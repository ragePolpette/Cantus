import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ImportBinding, Usage } from "./imports.js";
import type { LanguageDeclaration, LanguageFile, LanguageImport, LanguageResolver, ResolvedImport } from "./languages.js";

const MAX_SNIPPET = 160;
const MIN_BODY_LENGTH = 40;

const named = (node: Node | null | undefined): Node[] => (node?.namedChildren ?? []).filter((child): child is Node => !!child);

/**
 * Reads a Python module: its imports (anywhere in the file, as imports inside functions and
 * `if TYPE_CHECKING:` count too), its top-level functions, classes, variables and type aliases,
 * and where the imported names are used.
 *
 * A name is public unless it starts with `_`; `__all__`, when it is a list of strings, decides instead.
 */
export function readPython(root: Node, source: string): LanguageFile {
  const lines = source.split("\n");
  const snippet = (node: Node) => (lines[node.startPosition.row] ?? "").trim().slice(0, MAX_SNIPPET);
  const imports: LanguageImport[] = [];
  const declarations: LanguageDeclaration[] = [];
  let all: string[] | undefined;

  const visitImports = (node: Node) => {
    if (node.type === "import_statement") {
      for (const name of node.childrenForFieldName("name").filter((child): child is Node => !!child)) {
        if (name.type === "aliased_import") {
          const module = name.childForFieldName("name")?.text ?? "";
          imports.push({ specifier: module, line: node.startPosition.row + 1, bindings: [{ imported: "*", local: name.childForFieldName("alias")?.text ?? module }] });
        } else {
          // `import a.b.c` binds `a`, and the code reads the module as `a.b.c.f`: the dotted name is the key.
          imports.push({ specifier: name.text, line: node.startPosition.row + 1, bindings: [{ imported: "*", local: name.text }] });
        }
      }
      return;
    }
    if (node.type === "import_from_statement") {
      const specifier = node.childForFieldName("module_name")?.text.replace(/\s+/g, "") ?? "";
      const bindings: ImportBinding[] = [];
      for (const name of node.childrenForFieldName("name").filter((child): child is Node => !!child)) {
        if (name.type === "aliased_import") bindings.push({ imported: name.childForFieldName("name")?.text ?? "", local: name.childForFieldName("alias")?.text ?? "" });
        else bindings.push({ imported: name.text, local: name.text });
      }
      const wildcard = named(node).some((child) => child.type === "wildcard_import");
      imports.push({ specifier, line: node.startPosition.row + 1, bindings, ...(wildcard ? { wildcard: true as const } : {}) });
      return;
    }
    for (const child of named(node)) visitImports(child);
  };
  visitImports(root);

  for (let statement of named(root)) {
    const decorated = statement.type === "decorated_definition" ? statement : undefined;
    if (decorated) statement = decorated.childForFieldName("definition") ?? statement;
    const line = (statement.childForFieldName("name") ?? statement).startPosition.row + 1;
    if (statement.type === "function_definition") {
      const name = statement.childForFieldName("name")?.text;
      if (!name) continue;
      const body = statement.childForFieldName("body");
      declarations.push({ name, kind: "function", signature: header(statement, source), line, ...docOf(body), exported: !name.startsWith("_"), ...bodyHash(body) });
    } else if (statement.type === "class_definition") {
      const name = statement.childForFieldName("name")?.text;
      if (!name) continue;
      const body = statement.childForFieldName("body");
      const members: string[] = [];
      for (let member of named(body)) {
        if (member.type === "decorated_definition") member = member.childForFieldName("definition") ?? member;
        const memberName = member.type === "function_definition" ? member.childForFieldName("name")?.text : annotatedName(member);
        // Public members, and the constructor: what callers of the class rely on.
        if (!memberName || (memberName.startsWith("_") && memberName !== "__init__")) continue;
        members.push(member.type === "function_definition" ? header(member, source) : (member.namedChildren[0]?.text ?? member.text).replace(/\s*=[\s\S]*$/, ""));
      }
      const signature = header(statement, source) + (members.length ? ":\n" + members.map((member) => `    ${member}`).join("\n") : "");
      declarations.push({ name, kind: "class", signature, line, ...docOf(body), exported: !name.startsWith("_") });
    } else if (statement.type === "type_alias_statement") {
      const name = statement.childForFieldName("left")?.text.replace(/\[.*$/s, "");
      if (name) declarations.push({ name, kind: "type", signature: oneLine(statement.text), line, exported: !name.startsWith("_") });
    } else if (statement.type === "expression_statement") {
      const assignment = statement.namedChildren[0];
      if (assignment?.type !== "assignment") continue;
      const left = assignment.childForFieldName("left");
      if (left?.type !== "identifier") continue;
      const name = left.text;
      if (name === "__all__") {
        const right = assignment.childForFieldName("right");
        if (right && (right.type === "list" || right.type === "tuple")) {
          all = named(right).filter((item) => item.type === "string").map((item) => stringContent(item));
        }
        continue;
      }
      const type = assignment.childForFieldName("type")?.text;
      const right = assignment.childForFieldName("right");
      // `Alias = list[int]`-style aliases stay variables: without types, nothing tells them apart.
      const signature = type ? `${name}: ${oneLine(type)}` : `${name}${literalType(right) ? `: ${literalType(right)}` : ""}`;
      // Later assignments to the same name keep the first one: that is where the name is declared.
      if (!declarations.some((declaration) => declaration.name === name)) declarations.push({ name, kind: "variable", signature, line, exported: !name.startsWith("_") });
    }
  }
  if (all) {
    const listed = new Set(all);
    for (const declaration of declarations) declaration.exported = listed.has(declaration.name);
  }

  return { imports, declarations, usages: usagesOf(root, imports, snippet) };
}

/** `def f(a: int) -> str`, `async def f()`, `class A(B)`: the text before the body, on one line. */
function header(node: Node, source: string): string {
  const body = node.childForFieldName("body");
  const text = source.slice(node.startIndex, body ? body.startIndex : node.endIndex);
  return oneLine(text).replace(/\s*:\s*$/, "");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/,?\s+\)/g, ")").trim();
}

function annotatedName(member: Node): string | undefined {
  const assignment = member.type === "expression_statement" ? member.namedChildren[0] : null;
  if (assignment?.type !== "assignment" || !assignment.childForFieldName("type")) return undefined;
  const left = assignment.childForFieldName("left");
  return left?.type === "identifier" ? left.text : undefined;
}

function literalType(node: Node | null): string | undefined {
  switch (node?.type) {
    case "integer": return "int";
    case "float": return "float";
    case "string":
    case "concatenated_string": return "str";
    case "true":
    case "false": return "bool";
    case "list":
    case "list_comprehension": return "list";
    case "dictionary":
    case "dictionary_comprehension": return "dict";
    case "tuple": return "tuple";
    case "set":
    case "set_comprehension": return "set";
    default: return undefined;
  }
}

function stringContent(node: Node): string {
  return named(node).filter((child) => child.type === "string_content").map((child) => child.text).join("");
}

/** The docstring of a body: its first paragraph. */
function docOf(body: Node | null): { doc?: string } {
  const first = body?.namedChildren[0];
  const string = first?.type === "expression_statement" ? first.namedChildren[0] : undefined;
  if (string?.type !== "string") return {};
  const text = stringContent(string).trim().split(/\n\s*\n/)[0].split("\n").map((line) => line.trim()).join("\n");
  return text ? { doc: text } : {};
}

function bodyHash(body: Node | null): { bodyHash?: string } {
  if (!body) return {};
  const normalized = body.text.replace(/#[^\n]*/g, "").replace(/\s+/g, "");
  if (normalized.length < MIN_BODY_LENGTH) return {};
  return { bodyHash: createHash("sha1").update(normalized).digest("hex").slice(0, 16) };
}

/**
 * Where each imported local name is read. A dotted key (`import a.b.c`) matches the attribute chain
 * that spells it; the member read through the name is kept (`orders.create(…)` → `create`), for the
 * names that turn out to be modules.
 */
function usagesOf(root: Node, imports: LanguageImport[], snippet: (node: Node) => string): Record<string, Usage[]> {
  const usages = Object.create(null) as Record<string, Usage[]>;
  const keys = new Map<string, Array<{ local: string }>>();
  for (const spec of imports) {
    for (const binding of spec.bindings) {
      if (!binding.local) continue;
      const first = binding.local.split(".")[0];
      const list = keys.get(first) ?? [];
      list.push({ local: binding.local });
      keys.set(first, list);
    }
  }
  if (keys.size === 0) return usages;
  const visit = (node: Node) => {
    if (node.type === "import_statement" || node.type === "import_from_statement" || node.type === "future_import_statement") return;
    if (node.type === "identifier") {
      const candidates = keys.get(node.text);
      const parent = node.parent;
      // `x.name` and `f(name=…)` mention `name` without reading the variable.
      const isMemberName = parent?.type === "attribute" && parent.childForFieldName("attribute")?.id === node.id;
      const isKeyword = parent?.type === "keyword_argument" && parent.childForFieldName("name")?.id === node.id;
      if (candidates && !isMemberName && !isKeyword) {
        // The attribute chain starting here: a.b.c.f → [a, b, c, f].
        const chain = [node.text];
        let top: Node = node;
        while (top.parent?.type === "attribute" && top.parent.childForFieldName("object")?.id === top.id) {
          top = top.parent;
          chain.push(top.childForFieldName("attribute")?.text ?? "");
        }
        const match = candidates
          .filter((candidate) => {
            const parts = candidate.local.split(".");
            return parts.length <= chain.length && parts.every((part, index) => chain[index] === part);
          })
          .sort((a, b) => b.local.length - a.local.length)[0];
        if (match) {
          const depth = match.local.split(".").length;
          // Kept for every binding: `from pkg import orders` may name a submodule, which only the resolver knows.
          const member = chain[depth];
          (usages[match.local] ??= []).push({ line: node.startPosition.row + 1, column: node.startPosition.column + 1, snippet: snippet(node), ...(member ? { member } : {}) });
        }
      }
      return;
    }
    for (const child of named(node)) visit(child);
  };
  visit(root);
  return usages;
}

/** Files that mark a Python project root; their folder (and its `src/`) is where absolute imports start. */
const PROJECT_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg"];

/**
 * Resolves Python imports to the project's modules. Absolute imports are looked up from the import
 * roots: the project root, `src/`, folders with a pyproject.toml, setup.py or setup.cfg (and their
 * `src/`), and the folder above each top-level package (the highest folder with an `__init__.py`).
 * A module is `a/b.py`, `a/b.pyi` or `a/b/__init__.py`. `from p import name` reaches the submodule
 * `p/name.py` when there is one, else the name in `p`. What is not found is an installed package
 * or the standard library: external, named by its first segment.
 */
export function createPythonResolver(root: string, files: Set<string>): LanguageResolver {
  const roots = new Set<string>([""]);
  const addRoot = (dir: string) => {
    roots.add(dir === "." ? "" : dir);
  };
  const dirs = new Set<string>();
  for (const file of files) {
    for (let dir = path.posix.dirname(file); dir !== "." && !dirs.has(dir); dir = path.posix.dirname(dir)) dirs.add(dir);
  }
  for (const dir of ["", ...dirs]) {
    const absolute = path.join(root, dir);
    if (PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(absolute, marker)))) {
      addRoot(dir);
      if (dirs.has(dir ? `${dir}/src` : "src")) addRoot(dir ? `${dir}/src` : "src");
    }
  }
  if (dirs.has("src")) addRoot("src");
  for (const file of files) {
    if (path.posix.basename(file) !== "__init__.py") continue;
    let top = path.posix.dirname(file);
    while (top !== "." && files.has(`${path.posix.dirname(top) === "." ? "" : path.posix.dirname(top) + "/"}__init__.py`)) top = path.posix.dirname(top);
    if (top !== ".") addRoot(path.posix.dirname(top));
  }
  const ordered = [...roots].sort((a, b) => b.length - a.length);
  // Top-level modules and packages of the project: an import under one of them that finds no file is a mistake, not a package.
  const topLevel = new Set<string>();
  for (const base of ordered) {
    const prefix = base ? `${base}/` : "";
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      const parts = file.slice(prefix.length).split("/");
      if (parts.length === 1 && parts[0] !== "__init__.py") topLevel.add(parts[0].replace(/\.pyi?$/, ""));
      else if (parts.length === 2 && parts[1] === "__init__.py") topLevel.add(parts[0]);
    }
  }

  const moduleFile = (base: string, dotted: string[]): string | undefined => {
    const stem = [base, ...dotted].filter(Boolean).join("/");
    for (const candidate of [`${stem}.py`, `${stem}.pyi`, `${stem}/__init__.py`, `${stem}/__init__.pyi`]) if (files.has(candidate)) return candidate;
    return undefined;
  };
  /** The folder a relative import starts from: `.` is the importing file's package, each extra dot one up. */
  const relativeBase = (fromFile: string, level: number): string | undefined => {
    let dir = path.posix.dirname(fromFile);
    for (let step = 1; step < level; step++) {
      if (dir === ".") return undefined;
      dir = path.posix.dirname(dir);
    }
    return dir === "." ? "" : dir;
  };

  return (spec, fromFile) => {
    const level = /^\.*/.exec(spec.specifier)![0].length;
    const dotted = spec.specifier.slice(level).split(".").filter(Boolean);
    const bases = level > 0 ? [relativeBase(fromFile, level)].filter((base): base is string => base !== undefined) : ordered;
    let base: string | undefined;
    let target: string | undefined;
    for (const candidate of bases) {
      target = dotted.length ? moduleFile(candidate, dotted) : moduleFile(candidate, []) ?? (level > 0 ? "" : undefined);
      // `from . import x` names the package folder itself, which may have no __init__.py.
      if (target !== undefined || (dotted.length === 0 && level > 0)) {
        base = candidate;
        break;
      }
      // A package folder without __init__.py (a namespace package): only its submodules are files.
      // A folder of that name with none of the imported modules is something else (examples, assets): keep looking.
      if (dotted.length && dirs.has([candidate, ...dotted].filter(Boolean).join("/")) && spec.bindings.some((binding) => binding.imported !== "*" && moduleFile(candidate, [...dotted, binding.imported]))) {
        base = candidate;
        target = "";
        break;
      }
    }
    if (base === undefined || target === undefined) {
      if (level > 0) return [{ resolution: { kind: "unresolved", reason: `no module ${spec.specifier} next to ${fromFile}` }, bindings: spec.bindings, symbols: spec.bindings.map((binding) => binding.imported) }];
      if (topLevel.has(dotted[0])) {
        return [{ resolution: { kind: "unresolved", reason: `no module ${spec.specifier} in the project's package ${dotted[0]}` }, bindings: spec.bindings, symbols: spec.bindings.map((binding) => binding.imported) }];
      }
      return [{ resolution: { kind: "external", packageName: dotted[0] ?? spec.specifier }, bindings: [], symbols: [] }];
    }
    const results: ResolvedImport[] = [];
    const own: ImportBinding[] = [];
    const isFromImport = spec.bindings.some((binding) => binding.imported !== "*") || spec.wildcard;
    for (const binding of spec.bindings) {
      // `from pkg import orders` names the submodule pkg/orders.py when there is one.
      const submodule = isFromImport && binding.imported !== "*" ? moduleFile(base, [...dotted, binding.imported]) : undefined;
      if (submodule) results.push({ resolution: { kind: "internal", file: submodule }, bindings: [{ imported: "*", local: binding.local }], symbols: ["*"] });
      else own.push(binding);
    }
    if (target && (own.length > 0 || spec.wildcard || !isFromImport)) {
      results.push({ resolution: { kind: "internal", file: target }, bindings: own, symbols: spec.wildcard ? ["*"] : isFromImport ? own.map((binding) => binding.imported) : ["*"] });
    } else if (!target && own.length > 0) {
      results.push({ resolution: { kind: "unresolved", reason: `${spec.specifier || "."} is a folder without __init__.py and has no module ${own.map((binding) => binding.imported).join(", ")}` }, bindings: own, symbols: own.map((binding) => binding.imported) });
    }
    return results;
  };
}
