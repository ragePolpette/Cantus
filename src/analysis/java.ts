import type { Node } from "web-tree-sitter";
import type { ApiKind } from "./catalog.js";
import type { Usage } from "./imports.js";
import type { LanguageDeclaration, LanguageFile, LanguageImport, LanguageResolver } from "./languages.js";

const MAX_SNIPPET = 160;

const named = (node: Node | null | undefined): Node[] => (node?.namedChildren ?? []).filter((child): child is Node => !!child);

const TYPE_KINDS: Record<string, ApiKind> = {
  class_declaration: "class",
  record_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  annotation_type_declaration: "interface",
};

const oneLine = (text: string): string => text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/,?\s+\)/g, ")").trim();

/** `com.shop.db.Store` → `com.shop.db`: the package is the segments before the first capitalized one. */
function packageOf(name: string): string {
  const parts = name.split(".");
  const type = parts.findIndex((part) => /^[A-Z]/.test(part));
  return (type < 0 ? parts.filter((part) => part !== "*") : parts.slice(0, type)).join(".");
}

/**
 * Reads a Java file for the code between files: its package, imports (reduced to the package they
 * name), the types it declares with their public and protected members, and the type names it uses.
 * Java imports name packages and types, not files: like C#, a name is linked to the type of that
 * name in a package the file sees (its own and the imported ones; see linkByNamespace).
 */
export function readJava(root: Node, source: string): LanguageFile {
  const lines = source.split("\n");
  const snippet = (node: Node) => (lines[node.startPosition.row] ?? "").trim().slice(0, MAX_SNIPPET);
  const imports: LanguageImport[] = [];
  const declarations: LanguageDeclaration[] = [];
  const references = Object.create(null) as Record<string, Usage[]>;
  const top = named(root);
  const packageNode = top.find((node) => node.type === "package_declaration");
  const pkg = named(packageNode).find((node) => node.type === "scoped_identifier" || node.type === "identifier")?.text.replace(/\s+/g, "") ?? "";

  top.forEach((node, index) => {
    if (node.type === "import_declaration") {
      const target = named(node).find((part) => part.type === "scoped_identifier" || part.type === "identifier");
      const specifier = target ? packageOf(target.text.replace(/\s+/g, "")) : "";
      if (specifier) imports.push({ specifier, line: node.startPosition.row + 1, bindings: [], wildcard: true });
    } else if (TYPE_KINDS[node.type]) {
      const declaration = readType(node, source, pkg, docBefore(top, index));
      if (declaration) declarations.push(declaration);
    }
  });

  const collect = (node: Node) => {
    if (node.type === "import_declaration" || node.type === "package_declaration" || node.type === "line_comment" || node.type === "block_comment") return;
    const parent = node.parent;
    const isField = (field: string) => parent?.childForFieldName(field)?.id === node.id;
    const record = () => (references[node.text] ??= []).push({ line: node.startPosition.row + 1, column: node.startPosition.column + 1, snippet: snippet(node) });
    if (node.type === "type_identifier") {
      // `Outer.Inner`: Outer is the type used; Inner is a member of it.
      const qualified = parent?.type === "scoped_type_identifier" && parent.namedChildren[0]?.id !== node.id;
      const declares = !!parent && (TYPE_KINDS[parent.type] !== undefined || parent.type === "type_parameter") && isField("name");
      if (!qualified && !declares) record();
      return;
    }
    // `Rules.total(…)`, `Config.DEFAULT`, `@Service`: a capitalized name that is the object of a call or access, or an annotation.
    if (node.type === "identifier" && /^[A-Z]/.test(node.text) && parent && ((parent.type === "method_invocation" && isField("object")) || (parent.type === "field_access" && isField("object")) || ((parent.type === "marker_annotation" || parent.type === "annotation") && isField("name")))) {
      record();
      return;
    }
    for (const child of named(node)) collect(child);
  };
  collect(root);

  return { imports, declarations, usages: Object.create(null), references, namespaces: [pkg] };
}

/** Javadoc right above the declaration: its first lines, without tags. */
function docBefore(siblings: Node[], index: number): string | undefined {
  const previous = siblings[index - 1];
  if (previous?.type !== "block_comment" || !previous.text.startsWith("/**")) return undefined;
  const text = previous.text
    .replace(/^\/\*\*|\*\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter((line) => line && !line.startsWith("@"))
    .join("\n")
    .replace(/\{@(?:code|link|linkplain)\s+([^}]*)\}/g, "$1")
    .replace(/<[^>]+>/g, "");
  return text || undefined;
}

function modifiersOf(node: Node): string[] {
  const modifiers = named(node).find((child) => child.type === "modifiers");
  return (modifiers?.children ?? []).filter((child): child is Node => !!child && child.type !== "marker_annotation" && child.type !== "annotation").map((child) => child.text);
}

/** The node's text from its first modifier that is not an annotation, up to `stop`, on one line. */
function headerText(node: Node, source: string, stop: Node | null | undefined): string {
  const text = source.slice(node.startIndex, stop ? stop.startIndex : node.endIndex);
  return oneLine(text.replace(/@\w+(?:\.\w+)*(?:\([^)]*\))?\s*/g, "")).replace(/[;{]\s*$/, "").trim();
}

function readType(node: Node, source: string, pkg: string, doc: string | undefined): LanguageDeclaration | undefined {
  const name = node.childForFieldName("name")?.text;
  if (!name) return undefined;
  const body = node.childForFieldName("body");
  let signature = headerText(node, source, body);
  const isInterface = node.type === "interface_declaration" || node.type === "annotation_type_declaration";
  if (node.type === "enum_declaration") {
    const constants = named(body).filter((member) => member.type === "enum_constant").map((member) => member.childForFieldName("name")?.text ?? member.text);
    signature += ` { ${constants.join(", ")} }`;
  } else if (body) {
    const members: string[] = [];
    for (const member of named(body)) {
      const modifiers = modifiersOf(member);
      if (!(isInterface ? !modifiers.includes("private") : modifiers.includes("public") || modifiers.includes("protected"))) continue;
      if (member.type === "method_declaration" || member.type === "constructor_declaration") {
        members.push(headerText(member, source, member.childForFieldName("body")));
      } else if (member.type === "field_declaration" || member.type === "constant_declaration") {
        const declarators = named(member).filter((child) => child.type === "variable_declarator");
        const first = declarators[0];
        const end = first?.childForFieldName("name")?.endIndex ?? member.endIndex;
        const text = headerText(member, source, undefined);
        members.push(oneLine(first ? `${text.slice(0, end - member.startIndex).replace(/@\w+(?:\.\w+)*(?:\([^)]*\))?\s*/g, "")}${declarators.length > 1 ? `, ${declarators.slice(1).map((declarator) => declarator.childForFieldName("name")?.text).join(", ")}` : ""}` : text));
      } else if (TYPE_KINDS[member.type]) {
        members.push(headerText(member, source, member.childForFieldName("body")));
      }
    }
    if (members.length) signature += " {\n" + members.map((member) => `    ${member};`).join("\n") + "\n}";
  }
  return {
    name,
    kind: TYPE_KINDS[node.type],
    signature,
    line: node.childForFieldName("name")!.startPosition.row + 1,
    ...(doc ? { doc } : {}),
    exported: true,
    ...(pkg ? { namespace: pkg } : {}),
  };
}

/** Java imports name packages and types, not files: the analysis links Java by package instead. */
export function createJavaResolver(): LanguageResolver {
  return () => [];
}
