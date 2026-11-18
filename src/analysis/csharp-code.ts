import type { Node } from "web-tree-sitter";
import type { ApiKind } from "./catalog.js";
import type { Usage } from "./imports.js";
import type { LanguageDeclaration, LanguageFile, LanguageImport, LanguageResolver } from "./languages.js";

const MAX_SNIPPET = 160;

const named = (node: Node | null | undefined): Node[] => (node?.namedChildren ?? []).filter((child): child is Node => !!child);

const TYPE_KINDS: Record<string, ApiKind> = {
  class_declaration: "class",
  struct_declaration: "class",
  record_declaration: "class",
  record_struct_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  delegate_declaration: "type",
};

/** Nodes whose `name` is a declaration, not a use. */
const DECLARING = new Set([
  ...Object.keys(TYPE_KINDS), "method_declaration", "constructor_declaration", "destructor_declaration", "property_declaration",
  "event_declaration", "variable_declarator", "parameter", "enum_member_declaration", "type_parameter", "local_function_statement",
  "namespace_declaration", "file_scoped_namespace_declaration", "using_directive", "foreach_statement", "catch_declaration",
]);

/**
 * Reads a C# file for the code between files: its namespaces, `using` directives, the types it
 * declares (with their non-private members), and the type names it uses. C# has no file imports:
 * a name is linked to the type of that name in a namespace the file can see (see linkByNamespace).
 */
export function readCSharpCode(root: Node, source: string): LanguageFile {
  const lines = source.split("\n");
  const snippet = (node: Node) => (lines[node.startPosition.row] ?? "").trim().slice(0, MAX_SNIPPET);
  const imports: LanguageImport[] = [];
  const declarations: LanguageDeclaration[] = [];
  const namespaces = new Set<string>();
  const references = Object.create(null) as Record<string, Usage[]>;

  const visit = (node: Node, namespace: string) => {
    for (const child of named(node)) {
      if (child.type === "using_directive") {
        // `using A.B;` and `global using A.B;` open a namespace; `using X = A.B.C;` and `using static` are left out.
        if (child.childForFieldName("name") || /^\s*(global\s+)?using\s+static\b/.test(child.text)) continue;
        const target = named(child).find((part) => part.type === "qualified_name" || part.type === "identifier");
        if (target) imports.push({ specifier: target.text.replace(/\s+/g, ""), line: child.startPosition.row + 1, bindings: [], wildcard: true, ...(/^\s*global\b/.test(child.text) ? { global: true as const } : namespace ? { scope: namespace } : {}) });
      } else if (child.type === "namespace_declaration") {
        const full = [namespace, child.childForFieldName("name")?.text ?? ""].filter(Boolean).join(".");
        namespaces.add(full);
        visit(child.childForFieldName("body") ?? child, full);
      } else if (child.type === "file_scoped_namespace_declaration") {
        namespace = [namespace, child.childForFieldName("name")?.text ?? ""].filter(Boolean).join(".");
        namespaces.add(namespace);
        visit(child, namespace);
      } else if (child.type === "declaration_list") {
        visit(child, namespace);
      } else if (TYPE_KINDS[child.type]) {
        const declaration = readType(child, source, namespace);
        if (declaration) declarations.push(declaration);
      }
    }
  };
  visit(root, "");
  if (namespaces.size === 0) namespaces.add("");

  const collect = (node: Node) => {
    if (node.type === "using_directive" || node.type === "attribute_list" || node.type === "comment") return;
    if (node.type === "identifier" && /^[A-Z]/.test(node.text)) {
      const parent = node.parent;
      const isField = (field: string) => parent?.childForFieldName(field)?.id === node.id;
      const declared = !!parent && DECLARING.has(parent.type) && isField("name");
      // `x.Name`: a member, not a type; `A.B.Order`: the qualifier is a namespace, the last part the type.
      const member = parent?.type === "member_access_expression" && isField("name");
      const qualifier = parent?.type === "qualified_name" && isField("qualifier");
      const namespaceName = parent?.type === "namespace_declaration" || parent?.type === "file_scoped_namespace_declaration" || (parent?.type === "qualified_name" && (parent.parent?.type === "namespace_declaration" || parent.parent?.type === "file_scoped_namespace_declaration"));
      if (!declared && !member && !qualifier && !namespaceName) {
        const access = parent?.type === "member_access_expression" && isField("expression") ? parent.childForFieldName("name")?.text : undefined;
        (references[node.text] ??= []).push({ line: node.startPosition.row + 1, column: node.startPosition.column + 1, snippet: snippet(node), ...(access ? { member: access } : {}) });
      }
      return;
    }
    for (const child of named(node)) collect(child);
  };
  collect(root);

  return { imports, declarations, usages: Object.create(null), references, namespaces: [...namespaces] };
}

function modifiersOf(node: Node): string[] {
  return named(node).filter((child) => child.type === "modifier").map((child) => child.text);
}

/** The node's text after its attributes, up to `stop` (exclusive), on one line. */
function headerText(node: Node, source: string, stop: Node | null | undefined): string {
  const start = named(node).filter((child) => child.type === "attribute_list").pop()?.endIndex ?? node.startIndex;
  return oneLine(source.slice(start, stop ? stop.startIndex : node.endIndex)).replace(/[;{]\s*$/, "").trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
}

function readType(node: Node, source: string, namespace: string): LanguageDeclaration | undefined {
  const nameNode = node.childForFieldName("name");
  const name = nameNode?.text;
  if (!name) return undefined;
  const modifiers = modifiersOf(node);
  const body = node.childForFieldName("body") ?? named(node).find((child) => child.type === "declaration_list" || child.type === "enum_member_declaration_list") ?? null;
  let signature = headerText(node, source, body);
  if (node.type === "enum_declaration") {
    signature += ` { ${named(body).filter((member) => member.type === "enum_member_declaration").map((member) => member.childForFieldName("name")?.text ?? member.text).join(", ")} }`;
  } else if (body) {
    const isInterface = node.type === "interface_declaration";
    const members: string[] = [];
    for (const member of named(body)) {
      const memberModifiers = modifiersOf(member);
      const visible = isInterface ? !memberModifiers.includes("private") : memberModifiers.some((modifier) => modifier === "public" || modifier === "protected" || modifier === "internal");
      if (!visible) continue;
      if (member.type === "method_declaration" || member.type === "constructor_declaration" || member.type === "operator_declaration" || member.type === "conversion_operator_declaration") {
        members.push(headerText(member, source, member.childForFieldName("body") ?? named(member).find((child) => child.type === "arrow_expression_clause")));
      } else if (member.type === "property_declaration" || member.type === "indexer_declaration") {
        const accessors = member.childForFieldName("accessors");
        const kinds = named(accessors).filter((accessor) => accessor.type === "accessor_declaration").map((accessor) => {
          const text = accessor.text;
          const keyword = /\b(get|set|init)\b/.exec(text)?.[1] ?? "";
          const prefix = modifiersOf(accessor).join(" ");
          return `${prefix ? prefix + " " : ""}${keyword};`;
        });
        const arrow = named(member).find((child) => child.type === "arrow_expression_clause");
        members.push(headerText(member, source, accessors ?? arrow ?? null) + (kinds.length ? ` { ${kinds.join(" ")} }` : arrow ? " { get; }" : ""));
      } else if (member.type === "field_declaration" || member.type === "event_field_declaration") {
        const variable = named(member).find((child) => child.type === "variable_declaration");
        const type = variable?.childForFieldName("type")?.text ?? "";
        const names = named(variable).filter((child) => child.type === "variable_declarator").map((child) => child.childForFieldName("name")?.text ?? "");
        members.push(oneLine(`${memberModifiers.join(" ")}${member.type === "event_field_declaration" ? " event" : ""} ${type} ${names.join(", ")}`));
      }
    }
    if (members.length) signature += " {\n" + members.map((member) => `    ${member}${member.endsWith("}") ? "" : ";"}`).join("\n") + "\n}";
  }
  return {
    name,
    kind: TYPE_KINDS[node.type],
    signature,
    line: (nameNode ?? node).startPosition.row + 1,
    ...docOf(node, source),
    exported: !modifiers.includes("private"),
    ...(namespace ? { namespace } : {}),
  };
}

/** `/// <summary>…</summary>` comments right above the declaration: the summary's text. */
function docOf(node: Node, source: string): { doc?: string } {
  const lines = source.slice(0, node.startIndex).split("\n");
  lines.pop();
  const docs: string[] = [];
  while (lines.length && /^\s*\/\/\//.test(lines[lines.length - 1])) docs.unshift(lines.pop()!.replace(/^\s*\/\/\/\s?/, ""));
  const text = docs.join("\n");
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? (text.includes("<") ? "" : text);
  const clean = summary.replace(/<see\s+cref="([^"]+)"\s*\/>/g, "$1").replace(/<[^>]+>/g, "").split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
  return clean ? { doc: clean } : {};
}

/** C# `using` directives name namespaces, not files: the analysis links C# by namespace instead. */
export function createCSharpResolver(): LanguageResolver {
  return () => [];
}
