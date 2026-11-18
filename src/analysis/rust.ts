import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ApiKind } from "./catalog.js";
import type { ImportBinding, Usage } from "./imports.js";
import type { LanguageDeclaration, LanguageFile, LanguageImport, LanguageResolver, ResolvedImport } from "./languages.js";

const MAX_SNIPPET = 160;
const MIN_BODY_LENGTH = 40;

const named = (node: Node | null | undefined): Node[] => (node?.namedChildren ?? []).filter((child): child is Node => !!child);

const ITEM_KINDS: Record<string, ApiKind> = {
  function_item: "function",
  struct_item: "class",
  union_item: "class",
  enum_item: "enum",
  trait_item: "interface",
  type_item: "type",
  const_item: "variable",
  static_item: "variable",
  macro_definition: "function",
};

/** A `use` path: segments from the first to the last, what it binds locally, and whether it ends in `*`. */
interface UsePath {
  segments: string[];
  local?: string;
  wildcard?: boolean;
}

function flattenUse(node: Node | null | undefined, prefix: string[], out: UsePath[]): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
    case "crate":
    case "self":
    case "super":
    case "metavariable":
      out.push({ segments: [...prefix, node.text], local: node.text });
      return;
    case "scoped_identifier": {
      const segments = scopedSegments(node);
      out.push({ segments: [...prefix, ...segments], local: segments[segments.length - 1] });
      return;
    }
    case "use_as_clause": {
      const alias = node.childForFieldName("alias")?.text;
      const inner: UsePath[] = [];
      flattenUse(node.childForFieldName("path"), prefix, inner);
      for (const item of inner) out.push({ ...item, local: alias === "_" ? undefined : alias });
      return;
    }
    case "use_wildcard": {
      const inner: UsePath[] = [];
      flattenUse(named(node)[0], prefix, inner);
      for (const item of inner) out.push({ segments: item.segments, wildcard: true });
      return;
    }
    case "scoped_use_list": {
      const base = node.childForFieldName("path");
      const head = base ? scopedSegments(base) : [];
      for (const entry of named(node.childForFieldName("list"))) {
        // `use a::{self}` names the module `a` itself.
        if (entry.type === "self") out.push({ segments: [...prefix, ...head], local: head[head.length - 1] });
        else flattenUse(entry, [...prefix, ...head], out);
      }
      return;
    }
    case "use_list":
      for (const entry of named(node)) flattenUse(entry, prefix, out);
      return;
    default:
  }
}

function scopedSegments(node: Node): string[] {
  const segments: string[] = [];
  let current: Node | null = node;
  while (current && (current.type === "scoped_identifier" || current.type === "scoped_type_identifier")) {
    const name = current.childForFieldName("name");
    if (name) segments.unshift(name.text);
    current = current.childForFieldName("path");
  }
  if (current) segments.unshift(current.text);
  return segments;
}

/**
 * Reads a Rust file: its `use` declarations and `mod x;` files, its items (functions, structs with
 * their public fields and inherent methods, enums, traits, constants, type aliases, macros), and
 * where the names it imports are used. A name is exported when the item has any `pub`.
 */
export function readRust(root: Node, source: string): LanguageFile {
  const lines = source.split("\n");
  const snippet = (node: Node) => (lines[node.startPosition.row] ?? "").trim().slice(0, MAX_SNIPPET);
  const imports: LanguageImport[] = [];
  const declarations: LanguageDeclaration[] = [];
  const methods = new Map<string, string[]>();

  const readUse = (node: Node) => {
    const paths: UsePath[] = [];
    flattenUse(node.childForFieldName("argument"), [], paths);
    for (const item of paths) {
      const specifier = item.segments.join("::");
      if (item.wildcard) imports.push({ specifier, line: node.startPosition.row + 1, bindings: [], wildcard: true });
      else if (item.local) imports.push({ specifier, line: node.startPosition.row + 1, bindings: [{ imported: item.segments[item.segments.length - 1], local: item.local }] });
      else imports.push({ specifier, line: node.startPosition.row + 1, bindings: [] });
    }
  };

  const visit = (parent: Node, inline: string) => {
    const children = named(parent);
    children.forEach((node, index) => {
      if (node.type === "use_declaration") {
        readUse(node);
      } else if (node.type === "extern_crate_declaration") {
        // `pub extern crate grep_matcher as matcher;` names a crate under another name.
        const name = node.childForFieldName("name")?.text;
        if (name && name !== "self") imports.push({ specifier: name, line: node.startPosition.row + 1, bindings: [{ imported: name, local: node.childForFieldName("alias")?.text ?? name }] });
      } else if (node.type === "mod_item") {
        const name = node.childForFieldName("name")?.text;
        if (!name) return;
        const body = node.childForFieldName("body");
        if (!body) {
          // `mod m;` declares the file m.rs: an edge to it, and `m::x` paths are uses of it.
          imports.push({ specifier: `self::${name}`, line: node.startPosition.row + 1, bindings: [{ imported: name, local: name }] });
        } else if (!(name === "tests" && precedingAttributes(children, index).includes("cfg(test)"))) {
          visit(body, [inline, name].filter(Boolean).join("::"));
        }
      } else if (node.type === "impl_item") {
        if (node.childForFieldName("trait")) return;
        const type = typeName(node.childForFieldName("type"));
        if (!type) return;
        const list = methods.get(type) ?? [];
        for (const member of named(node.childForFieldName("body"))) {
          if (member.type === "function_item" && member.namedChildren.some((child) => child?.type === "visibility_modifier")) list.push(header(member, source));
          else if (member.type === "const_item" && member.namedChildren.some((child) => child?.type === "visibility_modifier")) list.push(header(member, source));
        }
        methods.set(type, list);
      } else if (ITEM_KINDS[node.type]) {
        const name = node.childForFieldName("name")?.text;
        if (!name) return;
        const exported = node.namedChildren.some((child) => child?.type === "visibility_modifier" && child.text !== "pub(self)");
        const body = node.childForFieldName("body");
        const declaration: LanguageDeclaration = {
          name,
          kind: ITEM_KINDS[node.type],
          signature: node.type === "macro_definition" ? `macro_rules! ${name}` : header(node, source),
          line: node.childForFieldName("name")!.startPosition.row + 1,
          ...docBefore(children, index),
          exported,
          ...(node.type === "function_item" ? bodyHash(body) : {}),
          ...(inline ? { namespace: inline } : {}),
        };
        if (node.type === "struct_item" || node.type === "union_item") declaration.signature = structSignature(node, source);
        if (node.type === "enum_item") declaration.signature += ` { ${named(body).filter((variant) => variant.type === "enum_variant").map((variant) => variant.childForFieldName("name")?.text ?? "").join(", ")} }`;
        if (node.type === "trait_item") {
          const members = named(body).filter((member) => member.type === "function_signature_item" || member.type === "function_item").map((member) => header(member, source));
          if (members.length) declaration.signature += " {\n" + members.map((member) => `    ${member};`).join("\n") + "\n}";
        }
        declarations.push(declaration);
      }
    });
  };
  visit(root, "");

  // Inherent public methods go with the type they extend, when it is declared in the same file.
  for (const declaration of declarations) {
    const list = methods.get(declaration.name);
    if (!list?.length || (declaration.kind !== "class" && declaration.kind !== "enum")) continue;
    const lines = list.map((method) => `    ${method};`).join("\n");
    declaration.signature = declaration.signature.endsWith("\n}") ? `${declaration.signature.slice(0, -1)}${lines}\n}` : `${declaration.signature} {\n${lines}\n}`;
  }
  const own = new Set(declarations.map((declaration) => declaration.name));
  return { imports, declarations, usages: usagesOf(root, imports, snippet), ...(imports.some((spec) => spec.wildcard) ? { references: globReferences(root, snippet, own, imports) } : {}) };
}

/** Parents of a pattern: what they bind is a new local, not a use of a name a glob import brought in. */
const PATTERN_PARENTS = new Set(["let_declaration", "parameter", "closure_parameters", "for_expression", "match_pattern", "let_condition", "self_parameter"]);

/**
 * Names a file with a glob import (`use super::*;`) uses without a path of its own, for the resolver to
 * tell which of them the glob brought in. Names the file declares or binds anywhere (a `let`, a
 * parameter, a pattern) are left out, as are the names in declarations and `use`.
 */
function globReferences(root: Node, snippet: (node: Node) => string, own: Set<string>, imports: LanguageImport[]): Record<string, Usage[]> {
  // A name the file imports itself wins over the glob's: the explicit route (`usages`) handles it.
  const bound = new Set<string>(own);
  for (const spec of imports) for (const binding of spec.bindings) if (binding.local) bound.add(binding.local);
  const collectBound = (node: Node) => {
    if (PATTERN_PARENTS.has(node.type)) {
      const target = node.type === "let_declaration" || node.type === "parameter" || node.type === "for_expression" ? node.childForFieldName("pattern") : node;
      for (const identifier of target?.descendantsOfType(["identifier", "shorthand_field_identifier"]) ?? []) {
        if (!identifier) continue;
        // `Expression::Or { lhs }`, `Some(x)`: the path and the type are uses; only the bare names bind.
        const parent = identifier.parent;
        if (parent && (parent.type === "scoped_identifier" || parent.type === "scoped_type_identifier" || ((parent.type === "tuple_struct_pattern" || parent.type === "struct_pattern") && parent.childForFieldName("type")?.id === identifier.id))) continue;
        bound.add(identifier.text);
      }
    }
    for (const child of named(node)) collectBound(child);
  };
  collectBound(root);
  const references = Object.create(null) as Record<string, Usage[]>;
  const visit = (node: Node) => {
    if (node.type === "use_declaration" || node.type === "attribute_item" || node.type === "line_comment" || node.type === "block_comment") return;
    if ((node.type === "identifier" || node.type === "type_identifier") && !bound.has(node.text)) {
      const parent = node.parent;
      const isName = (field: string) => parent?.childForFieldName(field)?.id === node.id;
      const declares = !!parent && BINDING_PARENTS.has(parent.type) && (isName("name") || isName("pattern"));
      // `Foo::new`: new belongs to Foo; `x.node` and `Struct { node: … }` read a field.
      const associated = (parent?.type === "scoped_identifier" || parent?.type === "scoped_type_identifier") && isName("name");
      // `'run` is a lifetime; `Iterator<Item = T>` names an associated type; in a macro's tokens, `A::B` and `name: value` are a path element and a field.
      const notAUse = parent?.type === "lifetime" || (parent?.type === "type_binding" && isName("name")) || (parent?.type === "token_tree" && (node.previousSibling?.type === "::" || node.nextSibling?.type === ":"));
      if (!declares && !associated && !notAUse) (references[node.text] ??= []).push({ line: node.startPosition.row + 1, column: node.startPosition.column + 1, snippet: snippet(node) });
    }
    for (const child of named(node)) visit(child);
  };
  visit(root);
  return references;
}

function typeName(node: Node | null): string | undefined {
  if (!node) return undefined;
  if (node.type === "type_identifier") return node.text;
  if (node.type === "generic_type") return typeName(node.childForFieldName("type"));
  return undefined;
}

function precedingAttributes(siblings: Node[], index: number): string {
  let text = "";
  for (let i = index - 1; i >= 0 && (siblings[i].type === "attribute_item" || siblings[i].type === "line_comment"); i--) text += siblings[i].text;
  return text.replace(/\s+/g, "");
}

/** The first paragraph of the `///` comments right above an item. */
function docBefore(siblings: Node[], index: number): { doc?: string } {
  const docs: string[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const sibling = siblings[i];
    if (sibling.type === "attribute_item") continue;
    if (sibling.type !== "line_comment" && sibling.type !== "block_comment") break;
    if (!sibling.children.some((child) => child?.type === "outer_doc_comment_marker")) break;
    docs.unshift(sibling.text.replace(/^\/\/\/ ?/, "").replace(/^\/\*\*|\*\/$/g, "").trimEnd());
  }
  const text = docs.join("\n").trim().split(/\n\s*\n/)[0].split("\n").map((line) => line.trim()).join("\n");
  return text ? { doc: text } : {};
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/,?\s+\)/g, ")").trim();
}

/** The item's text up to its body, on one line: `pub fn find(&self, haystack: &[u8]) -> Result<Option<Match>, Error>`. */
function header(node: Node, source: string): string {
  const body = node.childForFieldName("body");
  return oneLine(source.slice(node.startIndex, body ? body.startIndex : node.endIndex)).replace(/;$/, "");
}

function structSignature(node: Node, source: string): string {
  const base = header(node, source);
  const body = node.childForFieldName("body");
  if (!body) return base;
  if (body.type === "ordered_field_declaration_list") return oneLine(source.slice(node.startIndex, node.endIndex)).replace(/;$/, "");
  const fields = named(body).filter((field) => field.type === "field_declaration" && field.namedChildren.some((child) => child?.type === "visibility_modifier")).map((field) => oneLine(field.text));
  return fields.length ? `${base} {\n${fields.map((field) => `    ${field},`).join("\n")}\n}` : base;
}

function bodyHash(body: Node | null): { bodyHash?: string } {
  if (!body) return {};
  const normalized = body.text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");
  if (normalized.length < MIN_BODY_LENGTH) return {};
  return { bodyHash: createHash("sha1").update(normalized).digest("hex").slice(0, 16) };
}

/** Parents where an identifier names a new thing (a declaration, a binding), not a use of an imported one. */
const BINDING_PARENTS = new Set([
  "function_item", "function_signature_item", "struct_item", "union_item", "enum_item", "trait_item", "type_item", "const_item", "static_item",
  "mod_item", "macro_definition", "enum_variant", "parameter", "let_declaration", "closure_parameters", "for_expression", "tuple_pattern",
  "tuple_struct_pattern", "struct_pattern", "field_pattern", "ref_pattern", "mut_pattern", "slice_pattern", "or_pattern", "captured_pattern",
  "type_parameter", "const_parameter", "lifetime", "label", "use_declaration", "use_list", "use_as_clause", "scoped_use_list", "extern_crate_declaration",
]);

function usagesOf(root: Node, imports: LanguageImport[], snippet: (node: Node) => string): Record<string, Usage[]> {
  const usages = Object.create(null) as Record<string, Usage[]>;
  // `mod m;` and `use a::b;` may name modules: the resolver tells; the usage keeps the member read through the name.
  const locals = new Set<string>();
  for (const spec of imports) for (const binding of spec.bindings) if (binding.local) locals.add(binding.local);
  if (locals.size === 0) return usages;
  const visit = (node: Node) => {
    if (node.type === "use_declaration" || node.type === "attribute_item" || node.type === "line_comment" || node.type === "block_comment") return;
    if ((node.type === "identifier" || node.type === "type_identifier") && locals.has(node.text)) {
      const parent = node.parent;
      const isName = (field: string) => parent?.childForFieldName(field)?.id === node.id;
      const binds = !!parent && BINDING_PARENTS.has(parent.type) && (isName("name") || isName("pattern") || parent.type === "closure_parameters" || parent.type === "tuple_pattern" || parent.type === "let_declaration" || parent.type === "for_expression" && isName("pattern"));
      // `x.node` and `Struct { node: … }` read a field, not the name.
      const isAssociated = parent?.type === "scoped_identifier" || parent?.type === "scoped_type_identifier" ? isName("name") : false;
      if (!binds && !isAssociated) {
        let member: string | undefined;
        if (parent && (parent.type === "scoped_identifier" || parent.type === "scoped_type_identifier") && isName("path")) member = parent.childForFieldName("name")?.text;
        else if (parent?.type === "token_tree" && node.nextSibling?.type === "::") member = node.nextSibling.nextSibling?.text;
        (usages[node.text] ??= []).push({ line: node.startPosition.row + 1, column: node.startPosition.column + 1, snippet: snippet(node), ...(member ? { member } : {}) });
      }
    }
    for (const child of named(node)) visit(child);
  };
  visit(root);
  return usages;
}

interface Crate {
  name: string;
  dir: string;
  /** The folder the crate's modules live under (the one holding lib.rs or main.rs). */
  src: string;
  root: string;
}

/**
 * Resolves Rust `use` paths and `mod x;` to the project's files. Crates are the `Cargo.toml`
 * packages found above the files; a path starting with `crate`, `self` or `super` stays in the
 * crate, a path starting with a workspace crate's name (hyphens as underscores, or the name a
 * dependency is given in `Cargo.toml`) goes to that crate's `lib.rs`, a name declared in the current
 * module (`mod x;`) is that module. A module is `x.rs` or `x/mod.rs` next to its parent. Names a module
 * only re-exports (`pub use`) are followed. What is not in the project (`std`, crates.io) is external.
 */
export function createRustResolver(root: string, files: Set<string>, parsed: Map<string, LanguageFile> = new Map()): LanguageResolver {
  const crates = new Map<string, Crate>(); // by directory
  const dirs = new Set<string>();
  for (const file of files) for (let dir = path.posix.dirname(file); !dirs.has(dir); dir = path.posix.dirname(dir)) {
    dirs.add(dir);
    if (dir === ".") break;
  }
  const manifest = (dir: string) => path.join(root, dir === "." ? "" : dir, "Cargo.toml");
  for (const dir of dirs) {
    let text: string;
    try {
      text = fs.readFileSync(manifest(dir), "utf8");
    } catch {
      continue;
    }
    // Each key is read inside its own section: a `[lib]` with no `path` must not take the next section's (`[[bin]] path = "src/main.rs"`).
    const section = (header: string) => new RegExp(`^\\[${header}\\][^\\n]*\\n((?:(?!\\[)[^\\n]*\\n?)*)`, "m").exec(text)?.[1] ?? "";
    const lib = /^path\s*=\s*"([^"]+)"/m.exec(section("lib"))?.[1];
    const libName = /^name\s*=\s*"([^"]+)"/m.exec(section("lib"))?.[1];
    const join = (relative: string) => path.posix.normalize(dir === "." ? relative : `${dir}/${relative}`);
    const name = /^name\s*=\s*"([^"]+)"/m.exec(section("package"))?.[1];
    if (!name) continue;
    const bin = /^path\s*=\s*"([^"]+)"/m.exec(section("\\[bin\\]"))?.[1];
    const rootFile = [lib ? join(lib) : "", join("src/lib.rs"), join("src/main.rs"), bin ? join(bin) : ""].find((candidate) => candidate && files.has(candidate));
    if (!rootFile) continue;
    crates.set(dir, { name: (libName ?? name).replace(/-/g, "_"), dir, src: path.posix.dirname(rootFile), root: rootFile });
  }
  const byName = new Map<string, Crate>();
  for (const crate of crates.values()) byName.set(crate.name, crate);
  // Dependencies given another name, or a path: `grep = { path = "crates/grep" }`, `m = { package = "grep-matcher", path = "…" }`.
  const aliases = new Map<string, Map<string, Crate>>();
  for (const crate of crates.values()) {
    let text = "";
    try {
      text = fs.readFileSync(manifest(crate.dir), "utf8");
    } catch {
      continue;
    }
    const mine = new Map<string, Crate>();
    for (const match of text.matchAll(/^([\w-]+)\s*=\s*\{([^}]*)\}/gm)) {
      const target = /\bpath\s*=\s*"([^"]+)"/.exec(match[2])?.[1];
      if (!target) continue;
      const dep = crates.get(path.posix.normalize(crate.dir === "." ? target : `${crate.dir}/${target}`));
      if (dep) mine.set(match[1].replace(/-/g, "_"), dep);
    }
    aliases.set(crate.dir, mine);
  }
  const crateOf = (file: string): Crate | undefined => {
    let best: Crate | undefined;
    for (const crate of crates.values()) {
      const prefix = crate.dir === "." ? "" : `${crate.dir}/`;
      if (file.startsWith(prefix) && (!best || crate.dir.length > best.dir.length)) best = crate;
    }
    return best;
  };

  /** The module path of a file inside its crate: `src/a/b.rs` → [a, b], `src/a/mod.rs` → [a], `src/lib.rs` → []. */
  const modulePath = (file: string, crate: Crate): string[] => {
    if (file === crate.root) return [];
    const relative = path.posix.relative(crate.src, file);
    if (relative.startsWith("..")) return [];
    const parts = relative.replace(/\.rs$/, "").split("/");
    if (parts[parts.length - 1] === "mod") parts.pop();
    return parts;
  };
  const moduleFile = (crate: Crate, segments: string[]): string | undefined => {
    if (segments.length === 0) return crate.root;
    const stem = path.posix.join(crate.src, ...segments);
    return [`${stem}.rs`, `${stem}/mod.rs`].find((candidate) => files.has(candidate));
  };
  const declares = (file: string, name: string) => parsed.get(file)?.declarations.some((declaration) => declaration.name === name) ?? false;

  type Target = { kind: "module"; file: string; crate: Crate; segments: string[] } | { kind: "item"; file: string; name: string } | { kind: "external"; name: string } | { kind: "none" };

  /** Walks `segments` from a module; names a module re-exports are followed (through at most `depth` hops). */
  const walk = (file: string, crate: Crate, module: string[], rest: string[], depth: number): Target => {
    let currentFile = file;
    let currentCrate = crate;
    let segments = module;
    for (let index = 0; index < rest.length; index++) {
      const name = rest[index];
      // The last name may be an item that a module of the same name is also called (`pub use crate::interpolate::interpolate;`): the item wins.
      if (index === rest.length - 1 && depth > 0) {
        const reexport = parsed.get(currentFile)?.imports.find((spec) => spec.bindings.some((binding) => binding.local === name) && spec.specifier !== `self::${name}`);
        if (reexport) {
          const next = resolvePath(reexport.specifier.split("::"), currentFile, depth - 1);
          if (next.kind === "item" || next.kind === "external") return next;
        }
      }
      const child = moduleFile(currentCrate, [...segments, name]);
      if (child) {
        currentFile = child;
        segments = [...segments, name];
        continue;
      }
      if (declares(currentFile, name)) return { kind: "item", file: currentFile, name };
      // `pub use other::Thing;` or `pub use other_crate as alias;` in this module.
      const reexport = depth > 0 ? parsed.get(currentFile)?.imports.find((spec) => spec.bindings.some((binding) => binding.local === name)) : undefined;
      if (reexport) {
        const next = resolvePath(reexport.specifier.split("::"), currentFile, depth - 1);
        if (next.kind === "module") {
          currentFile = next.file;
          currentCrate = next.crate;
          segments = next.segments;
          continue;
        }
        return next;
      }
      return index === rest.length - 1 ? { kind: "none" } : { kind: "none" };
    }
    return { kind: "module", file: currentFile, crate: currentCrate, segments };
  };

  const resolvePath = (segments: string[], fromFile: string, depth: number): Target => {
    const crate = crateOf(fromFile);
    if (!crate) return { kind: "external", name: segments[0] };
    const here = modulePath(fromFile, crate);
    const [first, ...rest] = segments;
    if (first === "crate") return walk(crate.root, crate, [], rest, depth);
    if (first === "self") return walk(fromFile, crate, here, rest, depth);
    if (first === "super") {
      let up = here.slice(0, -1);
      let remaining = rest;
      while (remaining[0] === "super") {
        up = up.slice(0, -1);
        remaining = remaining.slice(1);
      }
      return walk(moduleFile(crate, up) ?? crate.root, crate, up, remaining, depth);
    }
    // A name in the current module (`mod x;` or an item), then another crate of the workspace.
    const child = moduleFile(crate, [...here, first]);
    if (child) return walk(child, crate, [...here, first], rest, depth);
    const hereFile = moduleFile(crate, here) ?? fromFile;
    if (declares(hereFile, first)) return { kind: "item", file: hereFile, name: first };
    const dep = aliases.get(crate.dir)?.get(first) ?? byName.get(first);
    if (dep) return walk(dep.root, dep, [], rest, depth);
    return { kind: "external", name: first };
  };

  /**
   * The names a glob import of `file`'s module brings in, with the file that declares each: the module's
   * own items, and what it imports itself (`use` of a name, a glob of another module, followed a few hops).
   * `inside`: the importer is a descendant (`use super::*`), which sees the module's private items and
   * `use` declarations too; any other importer sees only what the module declares `pub`.
   */
  const visibleNames = (file: string, inside: boolean, depth: number, seen: Set<string>): Map<string, { imported: string; file: string }> => {
    const names = new Map<string, { imported: string; file: string }>();
    const key = `${file}\u0000${inside}`;
    if (depth < 0 || seen.has(key)) return names;
    seen.add(key);
    const data = parsed.get(file);
    if (!data) return names;
    for (const declaration of data.declarations) if (inside || declaration.exported) names.set(declaration.name, { imported: declaration.name, file });
    if (inside) {
      for (const spec of data.imports) {
        if (spec.wildcard) {
          const target = resolvePath(spec.specifier.split("::").filter(Boolean), file, 6);
          if (target.kind !== "module") continue;
          for (const [name, found] of visibleNames(target.file, spec.specifier.split("::")[0] === "super", depth - 1, seen)) if (!names.has(name)) names.set(name, found);
          continue;
        }
        const segments = spec.specifier.split("::").filter(Boolean);
        for (const binding of spec.bindings) {
          if (!binding.local || names.has(binding.local)) continue;
          const target = resolvePath(segments, file, 6);
          if (target.kind === "item") names.set(binding.local, { imported: target.name, file: target.file });
        }
      }
    }
    return names;
  };
  const globCache = new Map<string, Map<string, { imported: string; file: string }>>();

  return (spec: LanguageImport, fromFile: string): ResolvedImport[] => {
    const segments = spec.specifier.split("::").filter(Boolean);
    const unresolved = (reason: string): ResolvedImport[] => [{ resolution: { kind: "unresolved", reason }, bindings: spec.bindings, symbols: spec.bindings.map((binding) => binding.imported) }];
    if (segments.length === 0) return [];
    const target = resolvePath(segments, fromFile, 6);
    const result = (file: string, bindings: ImportBinding[], symbols: string[]): ResolvedImport[] => [{ resolution: { kind: "internal", file }, bindings, symbols }];
    if (target.kind === "external") {
      return [{ resolution: { kind: "external", packageName: target.name }, bindings: [], symbols: [] }];
    }
    if (spec.wildcard) {
      if (target.kind === "module") {
        const inside = segments[0] === "super" || segments[0] === "self";
        const key = `${target.file}\u0000${inside}`;
        let names = globCache.get(key);
        if (!names) globCache.set(key, (names = visibleNames(target.file, inside, 3, new Set())));
        const own = parsed.get(fromFile)?.declarations.map((declaration) => declaration.name) ?? [];
        const glob = [...names].filter(([name, found]) => found.file !== fromFile && !own.includes(name)).map(([name, found]) => ({ name, imported: found.imported, file: found.file }));
        const [first] = result(target.file, [], ["*"]);
        return [{ ...first, ...(glob.length > 0 ? { glob } : {}) }];
      }
      if (target.kind === "item") return result(target.file, [], ["*"]);
      return unresolved(`no module ${spec.specifier} in the project`);
    }
    if (target.kind === "module") {
      // The path names a module: `use crate::a::b;` binds b to the module (its members are read as `b::x`).
      return result(target.file, spec.bindings.map((binding) => ({ imported: "*", local: binding.local })), ["*"]);
    }
    if (target.kind === "item") {
      return result(target.file, spec.bindings.map((binding) => ({ imported: target.name, local: binding.local })), [target.name]);
    }
    // The last segment may be an item the module declares through a macro, or an enum variant: fall back to the module.
    const parent = resolvePath(segments.slice(0, -1), fromFile, 6);
    if (parent.kind === "module" && segments.length > 1) {
      return result(parent.file, spec.bindings.map((binding) => ({ imported: binding.imported, local: binding.local })), [segments[segments.length - 1]]);
    }
    if (parent.kind === "item") return result(parent.file, spec.bindings.map((binding) => ({ imported: parent.name, local: binding.local })), [parent.name]);
    return unresolved(`no module or item ${spec.specifier} in the project`);
  };
}
