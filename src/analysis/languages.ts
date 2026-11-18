import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalysisCache } from "./cache.js";
import { type ApiKind, normalizeShape } from "./catalog.js";
import { type Diagnostic, type Report, errorMessage } from "./diagnostics.js";
import type { ImportBinding, Usage } from "./imports.js";
import type { Resolution } from "./resolve.js";
import { createPythonResolver } from "./python.js";
import { createCSharpResolver } from "./csharp-code.js";
import { createRustResolver } from "./rust.js";
import { createGoResolver } from "./go.js";
import { createPhpResolver } from "./php.js";
import { createJavaResolver } from "./java.js";

/**
 * What a language adapter reads from one file with tree-sitter, in a form every language shares:
 * the imports and the local names they bind, the declarations other files could use, and where
 * the imported names are used.
 */
export interface LanguageFile {
  imports: LanguageImport[];
  declarations: LanguageDeclaration[];
  /** Uses of each imported local name, outside the import statements. */
  usages: Record<string, Usage[]>;
  /** Set when the file does not parse cleanly: mid-edit, its exports cannot be read reliably. */
  syntaxError?: true;
  /**
   * Languages linked by namespace (C#): the namespaces the file's code is in, and the type names it
   * uses, linked to the types of that name in the namespaces it can see.
   */
  namespaces?: string[];
  references?: Record<string, Usage[]>;
  /** Go: the name the `package` clause gives, which is how importers call the package. */
  packageName?: string;
  /** Go: the file is compiled only for some systems or tags (`//go:build`), so another file may declare the same name for another one. */
  conditional?: true;
}

export interface LanguageImport {
  /** As written: `a.b`, `..pkg.mod`, `crate::orders::Order`. The language's resolver reads it. */
  specifier: string;
  line: number;
  /** Local names the import binds; `imported` is `*` when the name stands for the whole module. */
  bindings: ImportBinding[];
  /** Imports every public name of the target (`from m import *`, C#'s `using A.B;`). */
  wildcard?: true;
  /** C#'s `global using`: for every file of the project. */
  global?: true;
  /** C#: the namespace the directive sits in (`namespace A.B { using C; }`, or after `namespace A.B;`). The name is looked up there first, then in each enclosing one. */
  scope?: string;
}

export interface LanguageDeclaration {
  name: string;
  kind: ApiKind;
  /** The declaration as another file sees it: header and public members, no bodies. */
  signature: string;
  line: number;
  doc?: string;
  /** Visible outside the file (the language's rule: no leading `_`, `pub`, a capital letter…). */
  exported: boolean;
  /** Hash of the normalized body, to spot re-implementations. */
  bodyHash?: string;
  /** The namespace it is declared in, for languages linked by namespace. */
  namespace?: string;
}

/** An import resolved to the files it reaches, each with the bindings that come from it. */
export interface ResolvedImport {
  resolution: Resolution;
  /** When the import names a package of several files (Go), all of them; `resolution.file` is the first. */
  files?: string[];
  bindings: ImportBinding[];
  /** Names imported from that target: `*` for the whole module. */
  symbols: string[];
  /** For a glob import (`use super::*`): each name it brings into scope and the file that declares it, so the uses in `LanguageFile.references` can be linked. */
  glob?: Array<{ name: string; imported: string; file: string }>;
}

export type LanguageResolver = (spec: LanguageImport, fromFile: string) => ResolvedImport[];

export interface LanguageSupport {
  id: string;
  /** Shown in messages. */
  label: string;
  extensions: string[];
  /** Grammar file in `grammars/`. */
  grammar: string;
  /** Line comment marker, for the docs in a contract. */
  comment: string;
  /** Set for languages whose files name namespaces, not files (C#): see LanguageFile.references. */
  linkByNamespace?: true;
  /** Files of one folder that share a package name see each other without an import (Go): see LanguageFile.references. */
  linkBySamePackage?: true;
  /** With linkByNamespace: a namespace does not see its parents (Java packages), unlike C#. */
  flatNamespaces?: true;
  /** Folders of build output, never source. */
  excludedDirs?: string[];
  /** `parsed`: what the reader found in every file of the language, for resolvers that follow re-exports. */
  createResolver(root: string, files: Set<string>, parsed: Map<string, LanguageFile>): LanguageResolver;
}

/** Languages read with tree-sitter: imports, declarations and call sites, like JavaScript. */
export const LANGUAGES: LanguageSupport[] = [
  { id: "python", label: "Python", extensions: [".py", ".pyi"], grammar: "tree-sitter-python.wasm", comment: "#", createResolver: createPythonResolver },
  { id: "rust", label: "Rust", extensions: [".rs"], grammar: "tree-sitter-rust.wasm", comment: "//", createResolver: createRustResolver, excludedDirs: ["target"] },
  { id: "go", label: "Go", extensions: [".go"], grammar: "tree-sitter-go.wasm", comment: "//", createResolver: createGoResolver, linkBySamePackage: true },
  { id: "csharp", label: "C#", extensions: [".cs"], grammar: "tree-sitter-c_sharp.wasm", comment: "//", createResolver: createCSharpResolver, linkByNamespace: true, excludedDirs: ["bin", "obj"] },
  { id: "php", label: "PHP", extensions: [".php"], grammar: "tree-sitter-php.wasm", comment: "//", createResolver: createPhpResolver },
  { id: "java", label: "Java", extensions: [".java"], grammar: "tree-sitter-java.wasm", comment: "//", createResolver: createJavaResolver, linkByNamespace: true, flatNamespaces: true },
];

/** Extensions of the languages above. */
export const LANGUAGE_EXTENSIONS: string[] = LANGUAGES.flatMap((language) => language.extensions);

/**
 * Source files of languages Cantus does not read yet: they still belong to their blocks (size,
 * ownership, briefings), so a block of only such files is not empty.
 */
export const COUNTED_EXTENSIONS: string[] = [
  ".kt", ".kts", ".scala", ".groovy", ".rb", ".swift", ".dart",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx", ".m", ".mm", ".vb", ".fs",
  ".ex", ".exs", ".erl", ".hs", ".clj", ".lua", ".r", ".jl", ".zig",
];

export function languageOf(file: string): LanguageSupport | undefined {
  const extension = path.extname(file).toLowerCase();
  return LANGUAGES.find((language) => language.extensions.includes(extension));
}

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "language-worker.js");

/**
 * Structure of the given files, read by the tree-sitter worker; files unchanged since the last
 * analysis come from the cache. The worker is a child process because tree-sitter loads
 * asynchronously while the analysis is synchronous.
 */
export function readLanguageFiles(root: string, files: string[], cache: AnalysisCache, report: Report, stats: Map<string, fs.Stats>): Map<string, LanguageFile> {
  const result = new Map<string, LanguageFile>();
  const stale: string[] = [];
  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.join(root, file));
    } catch (error) {
      report({ level: "warning", stage: "parse", file, message: `cannot read file: ${errorMessage(error)}` });
      continue;
    }
    stats.set(file, stat);
    const cached = cache.get<LanguageFile>(`language:${file}`, stat);
    if (cached) {
      result.set(file, reviveFile(cached.value));
      for (const diagnostic of cached.diagnostics) report(diagnostic);
    } else stale.push(file);
  }
  if (stale.length === 0) return result;
  let parsed: Record<string, LanguageFile | { error: string }> = {};
  try {
    const output = execFileSync(process.execPath, [WORKER], { windowsHide: true, input: JSON.stringify({ root, files: stale }), encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    parsed = JSON.parse(output);
  } catch (error) {
    report({ level: "error", stage: "parse", message: `the tree-sitter reader failed: ${errorMessage(error)}`, detail: (error as { stderr?: string }).stderr || undefined });
  }
  for (const [file, data] of Object.entries(parsed)) {
    const stat = stats.get(file)!;
    if ("error" in data) {
      const diagnostic: Diagnostic = { level: "warning", stage: "parse", file, message: `cannot parse ${languageOf(file)?.label ?? "file"}: ${data.error}` };
      report(diagnostic);
      continue;
    }
    result.set(file, reviveFile(data));
    cache.set(`language:${file}`, stat, data, []);
  }
  return result;
}

/**
 * The exports of files as given (not as on disk: a committed version, a file being edited), each
 * with its normalized shape and its declaration; undefined for a file that does not parse cleanly.
 * One worker run for all of them.
 */
export function languageExportDeclarations(sources: Map<string, string>): Map<string, Map<string, { shape: string; signature: string }> | undefined> {
  const result = new Map<string, Map<string, { shape: string; signature: string }> | undefined>();
  if (sources.size === 0) return result;
  let parsed: Record<string, LanguageFile | { error: string }> = {};
  try {
    const files = [...sources.keys()];
    parsed = JSON.parse(execFileSync(process.execPath, [WORKER], { windowsHide: true, input: JSON.stringify({ root: ".", files, sources: Object.fromEntries(sources) }), encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }));
  } catch {
    // no reader: nothing to compare
  }
  for (const file of sources.keys()) {
    const data = parsed[file];
    if (!data || "error" in data || data.syntaxError) {
      result.set(file, undefined);
      continue;
    }
    const exports = new Map<string, { shape: string; signature: string }>();
    for (const declaration of data.declarations) {
      if (!declaration.exported) continue;
      // Two declarations with one name (a `partial` class in two parts, nested types): both count, in order, as the analysis lists them.
      const signature = declaration.signature.replace(/\s+/g, " ").trim();
      const earlier = exports.get(declaration.name);
      exports.set(declaration.name, earlier ? { shape: `${earlier.shape}\n${normalizeShape(declaration.signature)}`, signature: `${earlier.signature}\n${signature}` } : { shape: normalizeShape(declaration.signature), signature });
    }
    result.set(file, exports);
  }
  return result;
}

/** Usages are keyed by names from the code: a null prototype keeps `constructor` an ordinary key. */
function reviveFile(data: LanguageFile): LanguageFile {
  return { ...data, usages: Object.assign(Object.create(null) as Record<string, Usage[]>, data.usages) };
}

/** A file's contract for the blocks that call it: its exported declarations, with their docs. */
export function languageContract(file: LanguageFile, language: LanguageSupport): string {
  const comment = (doc: string) => doc.split("\n").map((line) => `${language.comment} ${line}`.trimEnd()).join("\n") + "\n";
  const exported = file.declarations.filter((declaration) => declaration.exported);
  if (exported.length === 0) return `${language.comment} no exported declarations`;
  return exported.map((declaration) => (declaration.doc ? comment(declaration.doc) : "") + declaration.signature).join("\n\n");
}
