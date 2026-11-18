import fs from "node:fs";
import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ApiKind } from "./catalog.js";
import type { LanguageDeclaration, LanguageFile, LanguageImport, LanguageResolver } from "./languages.js";

const kinds = new Map<string, ApiKind>([
  ["class_declaration", "class"], ["interface_declaration", "interface"],
  ["trait_declaration", "type"], ["enum_declaration", "enum"], ["function_definition", "function"],
]);

function children(node?: Node | null): Node[] {
  return (node?.namedChildren ?? []).filter((child): child is Node => child !== null);
}

function qualify(namespace: string, name: string): string {
  return namespace ? `${namespace}\\${name}` : name;
}

function key(name: string, isFunction: boolean): string {
  return `${isFunction ? "function" : "type"}:${name.toLowerCase()}`;
}

const isName = (node: Node) => ["name", "qualified_name", "relative_name"].includes(node.type);

export function readPhp(root: Node, source: string): LanguageFile {
  const declarations: LanguageDeclaration[] = [];
  const imports = new Map<string, LanguageImport>();
  const usages: LanguageFile["usages"] = Object.create(null);
  const lines = source.split("\n");

  function remember(specifier: string, isFunction: boolean, node: Node) {
    const local = key(specifier, isFunction);
    const imported = specifier.split("\\").at(-1)!;
    if (!imports.has(local)) imports.set(local, { specifier, line: node.startPosition.row + 1, bindings: [{ local, imported }] });
    return local;
  }

  function readScope(nodes: Node[], namespace: string) {
    const aliases = new Map<string, string>();
    for (const node of nodes) {
      if (node.type !== "namespace_use_declaration") continue;
      const group = node.childForFieldName("body");
      const prefix = group ? children(node).find(part => part.type === "namespace_name")?.text ?? "" : "";
      for (const clause of children(group ?? node).filter(part => part.type === "namespace_use_clause")) {
        const modifier = clause.children.find(part => part?.type === "function" || part?.type === "const")?.type
          ?? node.children.find(part => part?.type === "function" || part?.type === "const")?.type;
        if (modifier === "const") continue;
        const alias = clause.childForFieldName("alias");
        const target = children(clause).find(part => isName(part) && part.id !== alias?.id);
        if (!target) continue;
        const specifier = qualify(prefix, target.text.replace(/^\\/, ""));
        const isFunction = modifier === "function";
        aliases.set(key(alias?.text ?? specifier.split("\\").at(-1)!, isFunction), specifier);
        remember(specifier, isFunction, target);
      }
    }

    function record(node: Node, isFunction: boolean) {
      if (!isName(node)) return;
      const name = node.text;
      if (!isFunction && /^(self|static|parent)$/i.test(name)) return;
      const [first, ...rest] = name.split("\\");
      const alias = aliases.get(key(first, isFunction && rest.length === 0));
      const resolved = name.startsWith("\\") ? name.slice(1)
        : /^namespace\\/i.test(name) ? qualify(namespace, rest.join("\\"))
        : alias ? qualify(alias, rest.join("\\")).replace(/\\$/, "")
        : qualify(namespace, name);
      const local = remember(resolved, isFunction, node);
      (usages[local] ??= []).push({
        line: node.startPosition.row + 1, column: node.startPosition.column + 1,
        snippet: (lines[node.startPosition.row] ?? "").trim().slice(0, 160),
      });
    }

    function visit(node: Node) {
      if (node.type === "namespace_use_declaration" || node.type === "namespace_definition") return;
      if (node.type === "function_call_expression") {
        const target = node.childForFieldName("function");
        if (target) record(target, true);
      } else if (["scoped_call_expression", "scoped_property_access_expression", "class_constant_access_expression"].includes(node.type)) {
        const target = node.childForFieldName("scope") ?? children(node)[0];
        if (target) record(target, false);
      } else if (["object_creation_expression", "named_type", "base_clause", "class_interface_clause", "use_declaration"].includes(node.type)) {
        for (const target of children(node)) record(target, false);
      }
      for (const child of children(node)) visit(child);
    }

    for (const node of nodes) {
      const kind = kinds.get(node.type);
      const name = node.childForFieldName("name")?.text;
      if (kind && name) {
        const end = node.childForFieldName("body")?.startIndex ?? node.endIndex;
        declarations.push({ name, namespace, kind, exported: true, line: node.startPosition.row + 1,
          signature: source.slice(node.startIndex, end).replace(/\s+/g, " ").trim() });
      }
      visit(node);
    }
  }

  let namespace = "";
  let scope: Node[] = [];
  for (const node of children(root)) {
    if (node.type !== "namespace_definition") {
      scope.push(node);
      continue;
    }
    readScope(scope, namespace);
    scope = [];
    namespace = node.childForFieldName("name")?.text ?? "";
    const body = node.childForFieldName("body");
    if (body) {
      readScope(children(body), namespace);
      namespace = "";
    }
  }
  readScope(scope, namespace);
  return { imports: [...imports.values()], declarations, usages };
}

export function createPhpResolver(root: string, files: Set<string>, parsed: Map<string, LanguageFile>): LanguageResolver {
  const declarations = new Map<string, Array<{ file: string; name: string }>>();
  for (const file of files) {
    for (const declaration of parsed.get(file)?.declarations ?? []) {
      const id = key(qualify(declaration.namespace ?? "", declaration.name), declaration.kind === "function");
      const matches = declarations.get(id) ?? [];
      matches.push({ file, name: declaration.name });
      declarations.set(id, matches);
    }
  }
  const composer = readPsr4(root);
  return (spec, fromFile) => {
    const binding = spec.bindings[0];
    if (!binding) return [];
    let matches = declarations.get(binding.local) ?? [];
    if (matches.length > 1 && binding.local.startsWith("type:")) {
      const paths = new Set(composer.flatMap(([prefix, dir]) => spec.specifier.startsWith(prefix)
        ? [path.posix.join(dir, spec.specifier.slice(prefix.length).replaceAll("\\", "/") + ".php")] : []));
      const mapped = matches.filter(match => paths.has(match.file));
      if (mapped.length) matches = mapped;
    }
    if (matches.length > 1) return [{ resolution: { kind: "unresolved", reason: "ambiguous PHP symbol" }, bindings: [], symbols: [] }];
    const match = matches[0];
    if (!match || match.file === fromFile) return [];
    return [{ resolution: { kind: "internal", file: match.file }, bindings: [{ ...binding, imported: match.name }], symbols: [match.name] }];
  };
}

function readPsr4(root: string): Array<[string, string]> {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "composer.json"), "utf8"));
    return [manifest?.autoload?.["psr-4"], manifest?.["autoload-dev"]?.["psr-4"]].flatMap(mapping =>
      Object.entries(mapping ?? {}).flatMap(([prefix, dirs]) => [dirs].flat().flatMap(dir =>
        typeof dir === "string" && !path.isAbsolute(dir) && !dir.includes("\\") ? [[prefix, dir] as [string, string]] : [],
      )),
    );
  } catch {
    return [];
  }
}
