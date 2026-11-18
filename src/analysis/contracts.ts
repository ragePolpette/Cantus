import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { isolatedDeclarationSync } from "oxc-transform";
import { parseSync, Visitor } from "oxc-parser";
import { type Report, errorMessage, lineColumn } from "./diagnostics.js";
import { toPosix } from "./resolve.js";
import { parseName } from "./vue.js";

type TypeScript6 = typeof import("@typescript/typescript6");

/**
 * Which engines may fill in declarations that oxc cannot produce on its own:
 * `auto` tries JSDoc type tags on JavaScript exports, then the project's own compiler, then the
 * bundled TypeScript 6.
 */
export type CompilerFallback = "auto" | "project" | "bundled" | "none";

export type ContractEngine = "oxc" | "jsdoc" | "project-compiler" | "typescript6";

export interface ContractIssue {
  file: string;
  /** Engine that produced the final declarations, or `incomplete` when none could. */
  engine: Exclude<ContractEngine, "oxc"> | "incomplete";
  compiler?: string;
  messages: string[];
}

export interface ContractResult {
  contracts: Record<string, string>;
  /** Files whose declarations oxc could not derive without type inference. */
  issues: ContractIssue[];
}

/**
 * Declarations are generated per file with oxc (isolated declarations: fast, no type checker).
 * Files whose exports need type inference fall back to JSDoc type tags on JavaScript, then to a
 * real TypeScript compiler.
 */
export function generateContracts(
  root: string,
  files: string[],
  fallback: CompilerFallback = "auto",
  report: Report = () => {},
  /** Sources to use instead of the file on disk: classic scripts with their globals exported. Compilers do not see them. */
  overrides: Map<string, string> = new Map(),
  /** Imports the analysis already resolved to a file of the project (file, specifier): a compiler that cannot find them is the one that is wrong. */
  resolvedLocally: (file: string, specifier: string) => boolean = () => false,
): ContractResult {
  const contracts: Record<string, string> = {};
  const pending = new Map<string, { partial: string; messages: string[]; errorStarts: number[] }>();

  for (const file of files) {
    let source: string;
    try {
      source = overrides.get(file) ?? fs.readFileSync(path.join(root, file), "utf8");
    } catch (error) {
      report({ level: "error", stage: "contracts", file, message: `cannot read file: ${errorMessage(error)}` });
      continue;
    }
    const result = isolatedDeclarationSync(parseName(file), source, { sourcemap: false });
    // Declarations that need inference are common in JavaScript: one note per file, with the first case.
    const inference = result.errors.filter((error) => /^TS9\d{3}:/.test(error.message));
    if (inference.length > 0) {
      const first = inference[0];
      const start = first.labels[0]?.start;
      report({
        level: "info",
        stage: "contracts",
        file,
        ...(start !== undefined ? lineColumn(source, start) : {}),
        message: `${inference.length} declaration(s) need type inference, e.g. ${first.message}`,
        detail: first.codeframe ?? undefined,
      });
    }
    for (const error of result.errors.filter((candidate) => !inference.includes(candidate))) {
      const start = error.labels[0]?.start;
      report({ level: "error", stage: "contracts", file, ...(start !== undefined ? lineColumn(source, start) : {}), message: error.message, detail: error.codeframe ?? undefined });
    }
    if (result.errors.length === 0) {
      contracts[file] = clean(result.code);
    } else {
      const messages = [...new Set(result.errors.map((error) => error.message))].slice(0, 3);
      const errorStarts = result.errors.flatMap((error) => (error.labels[0]?.start !== undefined ? [error.labels[0].start] : []));
      pending.set(file, { partial: clean(result.code), messages, errorStarts });
    }
  }

  const issues: ContractIssue[] = [];
  /** Why each file still has no complete declarations, per compiler: one warning per file at the end, not one error per compiler. */
  const failures = new Map<string, string[]>();
  const settle = (emitted: Record<string, string>, engine: ContractIssue["engine"], compiler: string) => {
    for (const [file, text] of Object.entries(emitted)) {
      const entry = pending.get(file);
      if (!entry) continue;
      contracts[file] = text;
      issues.push({ file, engine, compiler, messages: entry.messages });
      pending.delete(file);
    }
  };

  if (pending.size > 0) {
    const emitted: Record<string, string> = {};
    for (const file of [...pending.keys()]) {
      if (!/\.[cm]?jsx?$/.test(file)) continue;
      let source: string;
      try {
        source = overrides.get(file) ?? fs.readFileSync(path.join(root, file), "utf8");
      } catch {
        continue; // already reported by the first pass
      }
      const entry = pending.get(file)!;
      const text = jsdocDeclarations(file, source, entry.partial, entry.errorStarts);
      if (text !== undefined) emitted[file] = text;
    }
    if (Object.keys(emitted).length > 0) {
      settle(emitted, "jsdoc", "JSDoc type tags");
      report({ level: "info", stage: "contracts", message: `${Object.keys(emitted).length} JavaScript file(s) got complete declarations from JSDoc type tags, without a compiler` });
    }
  }
  // A compiler would read the script as it is on disk, without exports: its globals stay as JSDoc and oxc give them.
  for (const file of [...pending.keys()].filter((candidate) => overrides.has(candidate))) {
    const entry = pending.get(file)!;
    report({ level: "info", stage: "contracts", file, message: "global script: declarations come from the code and its JSDoc only; add @param/@returns tags for complete types" });
    contracts[file] = entry.partial;
    issues.push({ file, engine: "incomplete", messages: entry.messages });
    pending.delete(file);
  }
  if (pending.size > 0 && (fallback === "auto" || fallback === "project")) {
    const compiler = findProjectCompiler(root);
    if (compiler) {
      for (const [configFile, group] of byNearestConfig(root, [...pending.keys()])) {
        settle(emitWithProjectCompiler(root, group, compiler, report, failures, resolvedLocally, configFile), "project-compiler", compiler.label);
      }
    } else {
      report({ level: "info", stage: "contracts", message: "no TypeScript compiler installed in the project; using the bundled TypeScript 6 for inferred types" });
    }
  }
  if (pending.size > 0 && (fallback === "auto" || fallback === "bundled")) {
    try {
      for (const [configFile, group] of byNearestConfig(root, [...pending.keys()])) {
        const emitted = emitWithTypeScript6(root, group, report, failures, configFile);
        settle(emitted.contracts, "typescript6", `typescript@${emitted.version}`);
      }
    } catch (error) {
      report({ level: "error", stage: "contracts", message: `bundled TypeScript 6 failed: ${errorMessage(error)}`, detail: error instanceof Error ? error.stack : undefined });
    }
  }
  for (const [file, entry] of pending) {
    const why = failures.get(file);
    report({ level: "warning", stage: "contracts", file, message: "no compiler could generate complete declarations; the contract is partial", ...(why?.length ? { detail: why.join("\n") } : {}) });
    contracts[file] = entry.partial;
    issues.push({ file, engine: "incomplete", messages: entry.messages });
  }

  return { contracts, issues: issues.sort((a, b) => a.file.localeCompare(b.file)) };
}

/** Files grouped by the tsconfig.json closest to them (up to the project root): in a monorepo, path aliases live in the sub-project's own. */
function byNearestConfig(root: string, files: string[]): Map<string | undefined, string[]> {
  const known = new Map<string, string | undefined>();
  const nearest = (dir: string): string | undefined => {
    if (known.has(dir)) return known.get(dir);
    const candidate = path.join(root, dir, "tsconfig.json");
    const found = fs.existsSync(candidate) ? candidate : dir === "." || dir === "" ? undefined : nearest(path.posix.dirname(dir));
    known.set(dir, found);
    return found;
  };
  const groups = new Map<string | undefined, string[]>();
  for (const file of files) {
    const config = nearest(path.posix.dirname(toPosix(file)));
    groups.set(config, [...(groups.get(config) ?? []), file]);
  }
  return groups;
}

interface ProjectCompiler {
  bin: string;
  label: string;
}

interface SourceComment {
  type: string;
  value: string;
  start: number;
  end: number;
}

interface JsdocTags {
  params: Map<string, { type: string; optional: boolean; rest?: boolean }>;
  returns?: string;
  type?: string;
}

/** The text between a `{` at `from` and its matching `}`; undefined when unbalanced. */
function braced(text: string, from: number): { inner: string; end: number } | undefined {
  if (text[from] !== "{") return undefined;
  let depth = 0;
  for (let index = from; index < text.length; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}" && --depth === 0) return { inner: text.slice(from + 1, index), end: index + 1 };
  }
  return undefined;
}

function parseJsdocTags(value: string): JsdocTags {
  const tags: JsdocTags = { params: new Map() };
  // One tag per entry; a tag's type may span lines and nest braces (`{{ a: number }}`).
  const text = value.split("\n").map((line) => line.replace(/^\s*\*\s?/, "")).join("\n");
  const tagPattern = /@(param|arg|argument|returns?|type)\b\s*/g;
  for (let match = tagPattern.exec(text); match; match = tagPattern.exec(text)) {
    const type = braced(text, match.index + match[0].length);
    if (!type) continue;
    const tag = match[1];
    if (tag === "returns" || tag === "return") {
      tags.returns = jsdocTypeToTs(type.inner);
    } else if (tag === "type") {
      tags.type = jsdocTypeToTs(type.inner);
    } else {
      const name = /^\s*(\[[^\]]*\]|[^\s]+)/.exec(text.slice(type.end))?.[1];
      if (!name) continue;
      const bracketed = name.startsWith("[");
      const bare = (bracketed ? name.slice(1, -1) : name).split("=")[0].trim();
      if (!bare || bare.includes(".")) continue; // `options.size` documents a property, not a parameter
      const closureOptional = type.inner.trim().endsWith("=");
      const rest = type.inner.trim().startsWith("...");
      tags.params.set(bare, { type: jsdocTypeToTs(rest ? type.inner.trim().slice(3) : type.inner), optional: bracketed || closureOptional, ...(rest ? { rest: true } : {}) });
    }
  }
  return tags;
}

/** Splits at `separator` outside brackets, parentheses and braces. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if ("<({[".includes(char)) depth++;
    else if (">)}]".includes(char)) depth--;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

/** Index of the parenthesis closing the one at `open`. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

/**
 * A JSDoc type written for the Closure Compiler, turned into TypeScript: `*` → `any`, `?T` → `T | null`,
 * `!T` → `T`, `T=` → `T` (optional), `Array.<T>` → `Array<T>`, `Object.<K, V>` → `Record<K, V>`,
 * `function(a, b): R` → `(arg0: a, arg1: b) => R`. TypeScript-style types pass through unchanged.
 */
export function jsdocTypeToTs(raw: string): string {
  let type = raw.trim();
  if (type === "*") return "any";
  if (type === "?") return "unknown";
  if (type.endsWith("=")) type = type.slice(0, -1).trim();
  if (type.startsWith("!")) return jsdocTypeToTs(type.slice(1));
  if (type.startsWith("?")) return `${jsdocTypeToTs(type.slice(1))} | null`;
  if (type.endsWith("?") && !type.endsWith("?)")) return `${jsdocTypeToTs(type.slice(0, -1))} | null`;
  if (type.startsWith("(") && closingParen(type, 0) === type.length - 1) return `(${jsdocTypeToTs(type.slice(1, -1))})`;
  const union = splitTopLevel(type, "|");
  if (union.length > 1) return union.map(jsdocTypeToTs).join(" | ");
  if (/^function\s*\(/.test(type)) {
    const open = type.indexOf("(");
    const close = closingParen(type, open);
    if (close < 0) return "Function";
    const args = splitTopLevel(type.slice(open + 1, close), ",").filter((arg) => arg && !/^(this|new)\s*:/.test(arg));
    const returns = /^\s*:\s*(.+)$/s.exec(type.slice(close + 1))?.[1];
    const params = args.map((arg, index) => (arg.startsWith("...") ? `...arg${index}: ${jsdocTypeToTs(arg.slice(3))}[]` : `arg${index}${arg.endsWith("=") ? "?" : ""}: ${jsdocTypeToTs(arg)}`));
    return `(${params.join(", ")}) => ${returns ? jsdocTypeToTs(returns) : "void"}`;
  }
  const generic = /^([\w$.]+?)\.?<(.*)>$/s.exec(type);
  if (generic) {
    const args = splitTopLevel(generic[2], ",").map(jsdocTypeToTs);
    if ((generic[1] === "Object" || generic[1] === "object") && args.length === 2) return `Record<${args[0]}, ${args[1]}>`;
    return `${generic[1]}<${args.join(", ")}>`;
  }
  return type;
}

/** Top-level declarations of a declaration file, by declared name, with their full text (multi-line included). */
function declarationsByName(fileName: string, text: string): Map<string, string> {
  const byName = new Map<string, string>();
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(fileName.replace(/\.[cm]?[jt]sx?$/, ".d.ts"), text);
  } catch {
    return byName;
  }
  for (const statement of parsed.program.body as Array<{ start: number; end: number; type: string; declaration?: { type?: string; id?: { name?: string }; declarations?: Array<{ id?: { type?: string; name?: string } }> } }>) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : undefined;
    if (!declaration) continue;
    const names = declaration.id?.name ? [declaration.id.name] : (declaration.declarations ?? []).flatMap((declarator) => (declarator.id?.type === "Identifier" && declarator.id.name ? [declarator.id.name] : []));
    for (const name of names) if (!byName.has(name)) byName.set(name, text.slice(statement.start, statement.end));
  }
  return byName;
}

interface ExportRecord {
  name: string;
  start: number;
  end: number;
  /** Start of the export statement: where the JSDoc comment sits. */
  jsdocStart: number;
  kind: "function" | "const-function" | "const-value";
  params?: Array<{ type: string; name?: string }>;
}

/**
 * Declarations for a JavaScript file whose exports carry JSDoc type tags (`@param {number} a`,
 * `@returns {string}`, `@type {T}`): complete contracts without a compiler. An export oxc could
 * not declare (it has an error inside its range) needs complete tags; an export already declared
 * by oxc is kept from `partial`. An export covered by neither leaves the whole file to the
 * compiler fallbacks.
 */
/**
 * Complete declarations of a JavaScript file from its JSDoc tags, given what oxc produced for it;
 * undefined when the file is not JavaScript or the tags do not cover every export oxc could not declare.
 */
export function jsdocContract(file: string, source: string, oxc: ReturnType<typeof isolatedDeclarationSync>): string | undefined {
  if (!/\.[cm]?jsx?$/.test(file) || oxc.errors.length === 0) return undefined;
  const errorStarts = oxc.errors.flatMap((error) => (error.labels[0]?.start !== undefined ? [error.labels[0].start] : []));
  return jsdocDeclarations(file, source, clean(oxc.code), errorStarts);
}

function jsdocDeclarations(fileName: string, source: string, partial: string, errorStarts: number[]): string | undefined {
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(fileName, source);
  } catch {
    return undefined; // already reported as a parse error by the first pass
  }
  const comments = ((parsed as unknown as { comments?: SourceComment[] }).comments ?? [])
    .filter((comment) => comment.type === "Block" && comment.value.startsWith("*"));
  const leadingJsdoc = (start: number): JsdocTags | undefined => {
    const comment = comments.find((candidate) => candidate.end <= start && source.slice(candidate.end, start).trim() === "");
    return comment ? parseJsdocTags(comment.value) : undefined;
  };

  const records: ExportRecord[] = [];
  let notCovered = false;
  new Visitor({
    ExportDefaultDeclaration() {
      notCovered = true;
    },
    ExportNamedDeclaration(node) {
      const declaration = node.declaration as { type?: string; id?: { name?: string }; params?: Array<{ type: string; name?: string }>; declarations?: Array<{ id?: { type?: string; name?: string }; init?: { type?: string; params?: Array<{ type: string; name?: string }> }; start?: number; end?: number }> } | undefined;
      if (declaration?.type === "FunctionDeclaration") {
        const name = declaration.id?.name;
        if (name) records.push({ name, start: node.start, end: node.end, jsdocStart: node.start, kind: "function", params: declaration.params });
        return;
      }
      if (declaration?.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations ?? []) {
          const name = declarator.id?.type === "Identifier" ? declarator.id.name : undefined;
          const init = declarator.init;
          if (!name || declarator.start === undefined || declarator.end === undefined) continue;
          if (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression") {
            records.push({ name, start: declarator.start, end: declarator.end, jsdocStart: node.start, kind: "const-function", params: init.params });
          } else {
            records.push({ name, start: declarator.start, end: declarator.end, jsdocStart: node.start, kind: "const-value" });
          }
        }
        return;
      }
      if (declaration) {
        notCovered = true; // classes, enums, type aliases: not typed by JSDoc tags
        return;
      }
      for (const specifier of (node.specifiers ?? []) as Array<{ local?: { name?: string } }>) {
        const name = specifier.local?.name;
        if (!name) continue;
        if (!new RegExp(`^.*\\b${escapeRegExp(name)}\\b.*$`, "m").test(partial)) notCovered = true;
      }
    },
  }).visit(parsed.program);
  if (notCovered) return undefined;

  const lines: string[] = [];
  const declared = declarationsByName(fileName, partial);
  for (const record of records) {
    const broken = errorStarts.some((start) => start >= record.start && start < record.end);
    if (!broken) {
      const kept = declared.get(record.name);
      if (kept === undefined) return undefined;
      if (!lines.includes(kept)) lines.push(kept);
      continue;
    }
    const tags = leadingJsdoc(record.jsdocStart);
    if (record.kind === "function" || record.kind === "const-function") {
      const list = paramList(record.params, tags);
      if (!list || !tags?.returns) return undefined;
      lines.push(
        record.kind === "function"
          ? `export declare function ${record.name}(${list.join(", ")}): ${tags.returns};`
          : `export declare const ${record.name}: (${list.join(", ")}) => ${tags.returns};`,
      );
    } else if (tags?.type) {
      lines.push(`export declare const ${record.name}: ${tags.type};`);
    } else {
      return undefined;
    }
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** `a: number, b?: string` from a function's parameters and its JSDoc `@param` tags; undefined when a parameter is not typed. */
function paramList(params: Array<{ type: string; name?: string }> | undefined, tags: JsdocTags | undefined): string[] | undefined {
  const list: string[] = [];
  for (const param of (params ?? []) as Array<{ type: string; name?: string; argument?: { type?: string; name?: string } }>) {
    if (param.type === "RestElement" && param.argument?.type === "Identifier" && param.argument.name) {
      const tag = tags?.params.get(param.argument.name);
      if (!tag) return undefined;
      list.push(`...${param.argument.name}: ${tag.type}[]`);
      continue;
    }
    if (param.type !== "Identifier" || !param.name) return undefined;
    const tag = tags?.params.get(param.name);
    if (!tag) return undefined;
    list.push(tag.rest ? `...${param.name}: ${tag.type}[]` : `${param.name}${tag.optional ? "?" : ""}: ${tag.type}`);
  }
  return list;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The TypeScript compiler installed for the project (any version: 5, 6 or the native 7). */
export function findProjectCompiler(root: string): ProjectCompiler | undefined {
  const candidates: Array<[string, string]> = [["typescript", "tsc"], ["@typescript/native-preview", "tsgo"]];
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    for (const [name, binName] of candidates) {
      const manifest = path.join(dir, "node_modules", name, "package.json");
      if (!fs.existsSync(manifest)) continue;
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version: string; bin?: string | Record<string, string> };
      const relativeBin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
      if (relativeBin) return { bin: path.join(path.dirname(manifest), relativeBin), label: `${name}@${pkg.version}` };
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

function emitWithProjectCompiler(root: string, files: string[], compiler: ProjectCompiler, report: Report, failures: Map<string, string[]>, resolvedLocally: (file: string, specifier: string) => boolean, projectConfig?: string): Record<string, string> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-dts-"));
  const outDir = path.join(workDir, "out");
  const hasConfig = projectConfig !== undefined;
  const config = {
    ...(hasConfig ? { extends: projectConfig } : {}),
    compilerOptions: {
      ...(hasConfig ? {} : { target: "es2022", module: "esnext", moduleResolution: "bundler", jsx: "preserve", strict: true }),
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
      sourceMap: false,
      composite: false,
      incremental: false,
      noEmitOnError: false,
      skipLibCheck: true,
      allowJs: true,
      rootDir: root,
      outDir,
    },
    files: files.map((file) => path.join(root, file)),
    include: [],
  };
  // Inside the project, so the compiler resolves `types` and @types packages from the project's node_modules.
  const configFile = path.join(root, ".cantus", `tsconfig.declarations.${process.pid}.json`);
  const createdDir = !fs.existsSync(path.dirname(configFile));
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  let output = "";
  try {
    output = execFileSync(process.execPath, [compiler.bin, "-p", configFile, "--pretty", "false"], {
      windowsHide: true,
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10 * 60_000,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    // Type errors exit non-zero but still emit declarations (noEmitOnError: false); anything else is a failure.
    const failed = error as { stdout?: string; stderr?: string; status?: number | null; signal?: string | null; code?: string };
    output = `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
    if (failed.signal || failed.code || (failed.status !== 1 && failed.status !== 2)) {
      report({
        level: "error",
        stage: "contracts",
        message: `${compiler.label} did not complete (${failed.signal ? `signal ${failed.signal}` : failed.code ?? `exit ${failed.status}`})`,
        detail: tail(output || errorMessage(error)),
      });
    }
  }

  let compilerErrors = 0;
  let knownToBeWrong = 0;
  const unparsed: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line.trim());
    if (match) {
      const file = toPosix(path.relative(root, path.resolve(root, match[1])));
      // The analysis found this import itself (an alias the compiler's configuration does not know): not the project's problem.
      const missing = match[5] === "TS2307" ? /Cannot find module '([^']+)'/.exec(match[6]) : null;
      if (missing && resolvedLocally(file, missing[1])) {
        knownToBeWrong++;
        continue;
      }
      compilerErrors++;
      report({
        level: "warning",
        stage: "contracts",
        file,
        line: Number(match[2]),
        column: Number(match[3]),
        message: `${compiler.label} ${match[5]}: ${match[6]}`,
      });
    } else if (/error TS\d+/.test(line)) {
      compilerErrors++;
      report({ level: "warning", stage: "contracts", message: `${compiler.label}: ${line.trim()}` });
    } else if (line.trim()) {
      unparsed.push(line);
    }
  }
  if (compilerErrors + knownToBeWrong > 0) {
    report({
      level: "info",
      stage: "contracts",
      message: `${compiler.label} reported ${compilerErrors + knownToBeWrong} diagnostic(s) while generating declarations; declarations were still emitted${knownToBeWrong ? ` (${knownToBeWrong} about imports the analysis resolves itself, not shown)` : ""}`,
    });
  }

  const emitted: Record<string, string> = {};
  const missingFiles: string[] = [];
  for (const file of files) {
    const outputFile = path.join(outDir, declarationPath(file));
    if (fs.existsSync(outputFile)) emitted[file] = clean(fs.readFileSync(outputFile, "utf8"));
    else {
      missingFiles.push(file);
      failures.set(file, [...(failures.get(file) ?? []), `${compiler.label} produced no declarations for this file`]);
    }
  }
  // Output that is not a type error (a crash, a broken installation) is the reason, and must not be lost.
  if (missingFiles.length > 0 && unparsed.length > 0) {
    report({ level: "warning", stage: "contracts", message: `${compiler.label} printed something other than type errors and produced no declarations for ${missingFiles.length} file(s)`, detail: tail(unparsed.join("\n")) });
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(configFile, { force: true });
  if (createdDir) {
    try {
      fs.rmdirSync(path.dirname(configFile)); // only if empty: another process may be using it
    } catch {
      // not empty, or already removed
    }
  }
  return emitted;
}

function tail(text: string, max = 4000): string {
  const trimmed = text.trim();
  return trimmed.length > max ? "…" + trimmed.slice(-max) : trimmed;
}

function emitWithTypeScript6(root: string, files: string[], report: Report, failures: Map<string, string[]>, projectConfig?: string): { contracts: Record<string, string>; version: string } {
  const ts = createRequire(import.meta.url)("@typescript/typescript6") as TypeScript6;
  let options: import("@typescript/typescript6").CompilerOptions = {};
  if (projectConfig) {
    const configName = toPosix(path.relative(root, projectConfig));
    const read = ts.readConfigFile(projectConfig, ts.sys.readFile);
    if (read.error) {
      report({ level: "warning", stage: "contracts", file: configName, message: `TypeScript 6 cannot read tsconfig.json: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}` });
    } else {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(projectConfig));
      options = parsed.options;
      for (const error of parsed.errors) {
        // TS18003: no inputs found — expected, Cantus passes its own file list.
        if (error.code === 18003) continue;
        report({ level: "warning", stage: "contracts", file: configName, message: `TypeScript 6: TS${error.code}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}` });
      }
    }
  }
  if (options.moduleResolution === undefined) {
    options.module = ts.ModuleKind.ESNext;
    options.moduleResolution = ts.ModuleResolutionKind.Bundler;
  }
  const outDir = path.join(root, "__cantus_declarations__");
  const program = ts.createProgram({
    rootNames: files.map((file) => path.join(root, file)),
    options: {
      ...options,
      allowJs: true,
      jsx: options.jsx ?? ts.JsxEmit.Preserve,
      skipLibCheck: true,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
      sourceMap: false,
      composite: false,
      incremental: false,
      noEmitOnError: false,
      outFile: undefined,
      tsBuildInfoFile: undefined,
      rootDir: root,
      outDir,
    },
  });

  const contracts: Record<string, string> = {};
  const byOutput = new Map(files.map((file) => [declarationPath(file), file]));
  for (const file of files) {
    const sourceFile = program.getSourceFile(path.join(root, file));
    if (!sourceFile) {
      failures.set(file, [...(failures.get(file) ?? []), "TypeScript 6 could not load this file"]);
      continue;
    }
    const result = program.emit(sourceFile, (fileName, text) => {
      const source = byOutput.get(toPosix(path.relative(outDir, fileName)));
      if (source) contracts[source] = clean(text);
    }, undefined, true);
    for (const diagnostic of result.diagnostics) {
      const position = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
      report({
        level: "warning",
        stage: "contracts",
        file: diagnostic.file ? toPosix(path.relative(root, diagnostic.file.fileName)) : file,
        ...(position ? { line: position.line + 1, column: position.character + 1 } : {}),
        message: `TypeScript 6 TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
      });
    }
    if (!contracts[file]) failures.set(file, [...(failures.get(file) ?? []), "TypeScript 6 produced no declarations for this file"]);
  }
  return { contracts, version: ts.version };
}

function declarationPath(file: string): string {
  return file.replace(/\.m[jt]s$/, ".d.mts").replace(/\.c[jt]s$/, ".d.cts").replace(/\.[jt]sx?$/, ".d.ts");
}

function clean(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("//# sourceMappingURL"))
    .join("\n")
    .trim();
}
