import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ApiKind } from "./catalog.js";
import type { Usage } from "./imports.js";
import type { LanguageDeclaration, LanguageFile, LanguageImport, LanguageResolver, ResolvedImport } from "./languages.js";

const MAX_SNIPPET = 160;
const MIN_BODY_LENGTH = 40;

const named = (node: Node | null | undefined): Node[] => (node?.namedChildren ?? []).filter((child): child is Node => !!child);

const isExported = (name: string) => /^\p{Lu}/u.test(name);

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/,?\s+\)/g, ")").trim();
}

/**
 * Reads a Go file: its package name, its imports, its top-level functions, types, constants and
 * variables (exported when the name starts with a capital letter; exported methods and fields go
 * with their type), and the names used as `pkg.Member` that no declaration in the file explains,
 * which are the uses of imported packages.
 */
export function readGo(root: Node, source: string): LanguageFile {
  const lines = source.split("\n");
  const snippet = (node: Node) => (lines[node.startPosition.row] ?? "").trim().slice(0, MAX_SNIPPET);
  const imports: LanguageImport[] = [];
  const declarations: LanguageDeclaration[] = [];
  const methods = new Map<string, string[]>();
  const packageName = named(root).find((node) => node.type === "package_clause")?.namedChildren[0]?.text;

  const children = named(root);
  children.forEach((node, index) => {
    if (node.type === "import_declaration") {
      for (const spec of node.descendantsOfType("import_spec")) {
        if (!spec) continue;
        const literal = spec.childForFieldName("path");
        const value = literal?.descendantsOfType("interpreted_string_literal_content")[0]?.text ?? literal?.text.replace(/^["`]|["`]$/g, "");
        if (!value) continue;
        const alias = spec.childForFieldName("name");
        const line = spec.startPosition.row + 1;
        if (alias?.type === "dot") imports.push({ specifier: value, line, bindings: [], wildcard: true });
        else if (alias?.type === "blank_identifier") imports.push({ specifier: value, line, bindings: [] });
        else imports.push({ specifier: value, line, bindings: [{ imported: "*", local: alias?.text ?? "" }] });
      }
    } else if (node.type === "function_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return;
      declarations.push({ name, kind: "function", signature: header(node, source), line: node.startPosition.row + 1, ...docBefore(children, index), exported: isExported(name), ...bodyHash(node.childForFieldName("body")) });
    } else if (node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text;
      const receiver = receiverType(node.childForFieldName("receiver"));
      if (!name || !receiver || !isExported(name)) return;
      methods.set(receiver, [...(methods.get(receiver) ?? []), header(node, source)]);
    } else if (node.type === "type_declaration") {
      for (const spec of named(node)) {
        if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
        const name = spec.childForFieldName("name")?.text;
        if (!name) continue;
        const type = spec.childForFieldName("type");
        const kind: ApiKind = type?.type === "struct_type" ? "class" : type?.type === "interface_type" ? "interface" : "type";
        declarations.push({ name, kind, signature: typeSignature(spec, type, source), line: spec.startPosition.row + 1, ...docBefore(children, index), exported: isExported(name) });
      }
    } else if (node.type === "const_declaration" || node.type === "var_declaration") {
      const keyword = node.type === "const_declaration" ? "const" : "var";
      for (const spec of node.descendantsOfType(node.type === "const_declaration" ? "const_spec" : "var_spec")) {
        if (!spec) continue;
        const type = spec.childForFieldName("type")?.text;
        for (const nameNode of spec.childrenForFieldName("name")) {
          if (!nameNode) continue;
          declarations.push({ name: nameNode.text, kind: "variable", signature: `${keyword} ${nameNode.text}${type ? ` ${oneLine(type)}` : ""}`, line: nameNode.startPosition.row + 1, ...docBefore(children, index), exported: isExported(nameNode.text) });
        }
      }
    }
  });

  for (const declaration of declarations) {
    const list = methods.get(declaration.name);
    if (!list?.length || (declaration.kind !== "class" && declaration.kind !== "type" && declaration.kind !== "interface")) continue;
    const lines = list.map((method) => `    ${method}`).join("\n");
    const signature = declaration.signature.replace(/ \{\}$/, "");
    declaration.signature = signature.endsWith("\n}") ? `${signature.slice(0, -1)}${lines}\n}` : declaration.kind === "interface" ? `${signature} {\n${lines}\n}` : `${signature} {\n${lines}\n}`;
  }
  const importNames = new Set(imports.flatMap((spec) => [spec.bindings[0]?.local || guessName(spec.specifier), guessName(spec.specifier)]));
  const own = new Set(declarations.map((declaration) => declaration.name));
  return {
    imports,
    declarations,
    usages: qualifiers(root, snippet, importNames),
    references: packageReferences(root, snippet, importNames, own),
    ...(buildConstrained(source) ? { conditional: true as const } : {}),
    ...(packageName ? { packageName } : {}),
  };
}

/** A `//go:build` (or the old `// +build`) line before the package clause: the file is compiled only for some systems or tags. */
function buildConstrained(source: string): boolean {
  for (const line of source.split("\n")) {
    const text = line.trim();
    if (/^\/\/\s*(?:go:build\b|\+build\b)/.test(text)) return true;
    if (/^package\b/.test(text)) return false;
  }
  return false;
}


function receiverType(receiver: Node | null): string | undefined {
  const type = receiver?.descendantsOfType(["type_identifier"])[0];
  return type?.text;
}

function header(node: Node, source: string): string {
  const body = node.childForFieldName("body");
  return oneLine(source.slice(node.startIndex, body ? body.startIndex : node.endIndex));
}

function typeSignature(spec: Node, type: Node | null, source: string): string {
  const generic = spec.childForFieldName("type_parameters");
  const head = `type ${spec.childForFieldName("name")?.text ?? ""}${generic ? oneLine(generic.text) : ""}`;
  if (spec.type === "type_alias") return `${head} = ${oneLine(type?.text ?? "")}`;
  if (type?.type === "struct_type") {
    const fields = type.descendantsOfType("field_declaration").filter((field): field is Node => !!field).filter((field) => field.childrenForFieldName("name").some((name) => name && isExported(name.text)) || (!field.childForFieldName("name") && /^\*?\p{Lu}/u.test(field.text)));
    return `${head} struct` + (fields.length ? ` {\n${fields.map((field) => `    ${oneLine(field.text)}`).join("\n")}\n}` : " {}");
  }
  if (type?.type === "interface_type") {
    const members = named(type).map((member) => oneLine(member.text));
    return `${head} interface` + (members.length ? ` {\n${members.map((member) => `    ${member}`).join("\n")}\n}` : " {}");
  }
  return `${head} ${oneLine(source.slice(type?.startIndex ?? spec.startIndex, type?.endIndex ?? spec.endIndex))}`;
}

function docBefore(siblings: Node[], index: number): { doc?: string } {
  const docs: string[] = [];
  for (let i = index - 1; i >= 0 && siblings[i].type === "comment"; i--) {
    const previous = siblings[i];
    // The comment must end on the line above the next piece.
    if (siblings[i + 1].startPosition.row - previous.endPosition.row > 1) break;
    docs.unshift(previous.text.replace(/^\/\/ ?/, "").replace(/^\/\*+|\*+\/$/g, "").trim());
  }
  const text = docs.join("\n").trim().split(/\n\s*\n/)[0].split("\n").map((line) => line.trim()).join("\n");
  return text ? { doc: text } : {};
}

function bodyHash(body: Node | null): { bodyHash?: string } {
  if (!body) return {};
  const normalized = body.text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");
  if (normalized.length < MIN_BODY_LENGTH) return {};
  return { bodyHash: createHash("sha1").update(normalized).digest("hex").slice(0, 16) };
}

/**
 * `pkg.Member` uses: a selector whose operand is a plain name that nothing in the file declares
 * (no parameter, variable, receiver or range name of that name anywhere, unless an import is called that),
 * keyed by that name.
 */
function qualifiers(root: Node, snippet: (node: Node) => string, importNames: Set<string>): Record<string, Usage[]> {
  const declared = localNames(root);
  // A local that happens to be named like an import (`util := 3`) does not hide the package everywhere.
  for (const name of importNames) declared.delete(name);
  const usages = Object.create(null) as Record<string, Usage[]>;
  const visit = (node: Node) => {
    if (node.type === "import_declaration") return;
    if (node.type === "selector_expression" || node.type === "qualified_type") {
      const operand = node.type === "selector_expression" ? node.childForFieldName("operand") : node.childForFieldName("package");
      const member = (node.type === "selector_expression" ? node.childForFieldName("field") : node.childForFieldName("name"))?.text;
      if (operand && (operand.type === "identifier" || operand.type === "package_identifier") && !declared.has(operand.text)) {
        (usages[operand.text] ??= []).push({ line: operand.startPosition.row + 1, column: operand.startPosition.column + 1, snippet: snippet(operand), ...(member ? { member } : {}) });
      }
    }
    for (const child of named(node)) visit(child);
  };
  visit(root);
  return usages;
}

/** Names the file declares inside functions or as parameters, variables, constants and type parameters anywhere in it (a name declared like that anywhere is not taken as a use of a package-level name). */
function localNames(root: Node): Set<string> {
  const declared = new Set<string>();
  const collect = (node: Node) => {
    switch (node.type) {
      case "parameter_declaration":
      case "variadic_parameter_declaration":
      case "var_spec":
      case "const_spec":
        for (const name of node.childrenForFieldName("name")) if (name) declared.add(name.text);
        break;
      case "short_var_declaration":
      case "range_clause":
      case "receive_statement":
        for (const identifier of node.childForFieldName("left")?.descendantsOfType("identifier") ?? []) if (identifier) declared.add(identifier.text);
        break;
      case "type_parameter_declaration":
        for (const name of node.childrenForFieldName("name")) if (name) declared.add(name.text);
        break;
      case "type_switch_statement":
        for (const alias of node.childrenForFieldName("alias")) if (alias) declared.add(alias.text);
        break;
      default:
    }
    for (const child of named(node)) collect(child);
  };
  collect(root);
  return declared;
}

/**
 * Exported names this file uses without a qualifier: the uses of what other files of the same
 * package declare (Go needs no import for those). A name the file declares anywhere in a scope of its
 * own (parameter, local, type parameter) is left out, as are the keys of composite literals (fields).
 * Only exported names: they are the ones that can be linked to a contract.
 */
function packageReferences(root: Node, snippet: (node: Node) => string, importNames: Set<string>, own: Set<string>): Record<string, Usage[]> {
  const declared = localNames(root);
  const references = Object.create(null) as Record<string, Usage[]>;
  const visit = (node: Node) => {
    if (node.type === "import_declaration" || node.type === "comment") return;
    if ((node.type === "identifier" || node.type === "type_identifier") && isExported(node.text) && !declared.has(node.text) && !own.has(node.text) && !importNames.has(node.text)) {
      const parent = node.parent;
      const declares = !!parent && (parent.type === "function_declaration" || parent.type === "type_spec" || parent.type === "type_alias") && parent.childForFieldName("name")?.id === node.id;
      // `Foo{Name: 1}`: Name is a field, the first element of its pair (directly, or wrapped in a literal_element).
      const pair = parent?.type === "literal_element" ? parent.parent : parent;
      const key = pair?.type === "keyed_element" && pair.namedChildren[0]?.id === (parent?.type === "literal_element" ? parent.id : node.id);
      const qualifiedType = parent?.type === "qualified_type" && parent.childForFieldName("name")?.id === node.id;
      if (!declares && !key && !qualifiedType) {
        (references[node.text] ??= []).push({ line: node.startPosition.row + 1, column: node.startPosition.column + 1, snippet: snippet(node) });
      }
      return;
    }
    for (const child of named(node)) visit(child);
  };
  visit(root);
  return references;
}

interface GoModule {
  path: string;
  dir: string;
}

/** The last element of an import path that names a package: `a/b/v2` → `b`, `gopkg.in/yaml.v3` → `yaml`. */
function guessName(importPath: string): string {
  const parts = importPath.split("/").filter(Boolean);
  let last = parts.pop() ?? importPath;
  if (/^v\d+$/.test(last) && parts.length) last = parts.pop()!;
  return last.replace(/\.v\d+$/, "").replace(/^go-/, "").replace(/-go$/, "").replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Resolves Go imports to the project's packages. A module is a folder with a `go.mod`; an import
 * path under a module's path is the folder below it, and the package is the `.go` files there.
 * The name the code uses for it is the alias, else the package name the files declare. The standard
 * library and other modules are external.
 */
export function createGoResolver(root: string, files: Set<string>, parsed: Map<string, LanguageFile> = new Map()): LanguageResolver {
  const modules: GoModule[] = [];
  const dirs = new Set<string>();
  for (const file of files) for (let dir = path.posix.dirname(file); !dirs.has(dir); dir = path.posix.dirname(dir)) {
    dirs.add(dir);
    if (dir === ".") break;
  }
  for (const dir of dirs) {
    try {
      const modulePath = /^\s*module\s+("?)([^\s"]+)\1/m.exec(fs.readFileSync(path.join(root, dir === "." ? "" : dir, "go.mod"), "utf8"))?.[2];
      if (modulePath) modules.push({ path: modulePath, dir });
    } catch {
      // no go.mod here
    }
  }
  modules.sort((a, b) => b.path.length - a.path.length);
  const byDir = new Map<string, string[]>();
  for (const file of files) byDir.set(path.posix.dirname(file), [...(byDir.get(path.posix.dirname(file)) ?? []), file]);

  return (spec: LanguageImport, fromFile: string): ResolvedImport[] => {
    const module = modules.find((candidate) => spec.specifier === candidate.path || spec.specifier.startsWith(`${candidate.path}/`));
    if (!module) {
      const parts = spec.specifier.split("/");
      return [{ resolution: { kind: "external", packageName: parts[0].includes(".") ? parts.slice(0, 3).join("/") : parts[0] }, bindings: [], symbols: [] }];
    }
    const rest = spec.specifier.slice(module.path.length).replace(/^\//, "");
    const dir = rest ? path.posix.normalize(module.dir === "." ? rest : `${module.dir}/${rest}`) : module.dir;
    const packageFiles = (byDir.get(dir) ?? []).sort();
    if (packageFiles.length === 0) {
      return [{ resolution: { kind: "unresolved", reason: `no Go files in ${dir}` }, bindings: spec.bindings, symbols: ["*"] }];
    }
    const name = parsed.get(packageFiles[0])?.packageName ?? guessName(spec.specifier);
    const bindings = spec.bindings.map((binding) => ({ imported: "*", local: binding.local || name }));
    return [{ resolution: { kind: "internal", file: packageFiles[0] }, files: packageFiles, bindings, symbols: ["*"] }];
  };
}
