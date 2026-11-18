import { createHash } from "node:crypto";
import { parseSync } from "oxc-parser";
import { isolatedDeclarationSync } from "oxc-transform";
import { parseName } from "./vue.js";
import { jsdocContract } from "./contracts.js";

export type ApiKind = "function" | "class" | "interface" | "type" | "variable" | "enum" | "namespace";

/** One exported symbol of the project, as another block would see it. */
export interface ApiEntry {
  block: string;
  file: string;
  name: string;
  kind: ApiKind;
  /** Declaration text (from the file's contract when available). */
  signature: string;
  doc?: string;
  /** Line of the declaration in the source file (1-based), where an agent opens the file to read the rest. */
  line?: number;
  /** False when the declaration lacks types that need inference (no compiler ran for this file). */
  complete: boolean;
  /** Hash of the normalized function body, used to spot re-implementations. */
  bodyHash?: string;
  /**
   * The export's declaration as oxc derives it from the source alone, whitespace-normalized.
   * Comparable before and after an edit without running a compiler.
   */
  shape: string;
}

const MIN_BODY_LENGTH = 40;
const MAX_SIGNATURE_LENGTH = 2000;

/**
 * Lists every export of every file in a block. Files with a contract (public files) use it;
 * other files get oxc declarations, which may lack inferred types.
 */
export function buildCatalog(
  sources: Array<{ file: string; block: string; source: string }>,
  contracts: Record<string, string>,
  incompleteFiles: Set<string>,
): ApiEntry[] {
  const entries: ApiEntry[] = [];
  for (const { file, block, source } of sources) {
    let oxc: ReturnType<typeof isolatedDeclarationSync>;
    try {
      oxc = isolatedDeclarationSync(parseName(file), source, { sourcemap: false });
    } catch {
      continue; // syntax errors are already reported by the parse stage
    }
    const shapes = exportShapes(file, oxc.code);
    // Files no other block imports have no contract: their JSDoc tags still type what they export.
    const fromJsdoc = contracts[file] === undefined ? jsdocContract(file, source, oxc) : undefined;
    const declarations = contracts[file] ?? fromJsdoc ?? oxc.code;
    const complete = contracts[file] !== undefined ? !incompleteFiles.has(file) : fromJsdoc !== undefined || oxc.errors.length === 0;
    const bodies = functionBodyHashes(file, source);
    const lines = exportLines(file, source);
    for (const entry of declarationEntries(file, declarations)) {
      entries.push({
        block,
        file,
        ...entry,
        ...(lines.has(entry.name) ? { line: lines.get(entry.name) } : {}),
        complete,
        shape: shapes.get(entry.name) ?? normalizeShape(entry.signature),
        ...(bodies.has(entry.name) ? { bodyHash: bodies.get(entry.name) } : {}),
      });
    }
  }
  return entries.sort((a, b) => a.block.localeCompare(b.block) || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

function declarationEntries(file: string, declarations: string): Array<Pick<ApiEntry, "name" | "kind" | "signature" | "doc">> {
  const { program, comments } = parseSync(`${file}.d.ts`, declarations);
  const result: Array<Pick<ApiEntry, "name" | "kind" | "signature" | "doc">> = [];

  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration" && statement.type !== "ExportDefaultDeclaration") continue;
    const declaration = statement.declaration as { type: string; id?: { name?: string } | null; declarations?: Array<{ id: { type: string; name?: string } }> } | null;
    if (!declaration) continue;

    const signature = declarations.slice(statement.start, statement.end).replace(/^export\s+(default\s+)?(declare\s+)?/, "").slice(0, MAX_SIGNATURE_LENGTH);
    const doc = docBefore(declarations, comments, statement.start);
    const kind = kindOf(declaration.type);
    if (!kind) continue;

    const names = declaration.type === "VariableDeclaration"
      ? (declaration.declarations ?? []).filter((item) => item.id.type === "Identifier").map((item) => item.id.name!)
      : [statement.type === "ExportDefaultDeclaration" ? "default" : declaration.id?.name ?? "default"];
    for (const name of names) result.push({ name, kind, signature, ...(doc ? { doc } : {}) });
  }
  return result;
}

function kindOf(type: string): ApiKind | undefined {
  switch (type) {
    case "TSDeclareFunction":
    case "FunctionDeclaration":
      return "function";
    case "ClassDeclaration":
      return "class";
    case "TSInterfaceDeclaration":
      return "interface";
    case "TSTypeAliasDeclaration":
      return "type";
    case "VariableDeclaration":
      return "variable";
    case "TSEnumDeclaration":
      return "enum";
    case "TSModuleDeclaration":
      return "namespace";
    default:
      return undefined;
  }
}

function docBefore(text: string, comments: Array<{ type: string; value: string; start: number; end: number }>, start: number): string | undefined {
  const comment = [...comments].reverse().find((candidate) => candidate.end <= start);
  if (!comment || comment.type !== "Block" || !comment.value.startsWith("*")) return undefined;
  if (text.slice(comment.end, start).trim() !== "") return undefined;
  return comment.value
    .split("\n")
    .map((line) => line.replace(/^\s*\*+\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

/** Where each export is declared in the source (1-based line), by export name; a re-export points at its `export` statement. */
function exportLines(file: string, source: string): Map<string, number> {
  const lines = new Map<string, number>();
  let program;
  try {
    program = parseSync(parseName(file), source).program;
  } catch {
    return lines;
  }
  const starts = [0];
  for (let index = source.indexOf("\n"); index >= 0; index = source.indexOf("\n", index + 1)) starts.push(index + 1);
  const lineAt = (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  type Declared = { type: string; id?: { name?: string } | null; declarations?: Array<{ id: { type: string; name?: string } }> };
  const namesOf = (declaration: Declared | null | undefined): string[] =>
    !declaration ? [] : declaration.type === "VariableDeclaration"
      ? (declaration.declarations ?? []).filter((item) => item.id.type === "Identifier").map((item) => item.id.name!)
      : declaration.id?.name ? [declaration.id.name] : [];
  const local = new Map<string, number>();
  for (const statement of program.body) {
    const declaration = (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement) as Declared | null;
    for (const name of namesOf(declaration)) local.set(name, lineAt(statement.start));
  }
  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration") lines.set("default", lineAt(statement.start));
    if (statement.type !== "ExportNamedDeclaration") continue;
    for (const name of namesOf(statement.declaration as Declared | null)) lines.set(name, lineAt(statement.start));
    if (statement.source) {
      for (const specifier of statement.specifiers) lines.set(((specifier.exported as { name?: string; value?: string }).name ?? (specifier.exported as { value?: string }).value)!, lineAt(statement.start));
      continue;
    }
    for (const specifier of statement.specifiers) {
      const exported = (specifier.exported as { name?: string; value?: string }).name ?? (specifier.exported as { value?: string }).value;
      const origin = (specifier.local as { name?: string; value?: string }).name ?? (specifier.local as { value?: string }).value;
      if (exported) lines.set(exported, (origin ? local.get(origin) : undefined) ?? lineAt(statement.start));
    }
  }
  return lines;
}

/** Normalized bodies of exported functions (declarations and `const x = () => {}`), by export name. */
function functionBodyHashes(file: string, source: string): Map<string, string> {
  const hashes = new Map<string, string>();
  let program;
  try {
    program = parseSync(parseName(file), source).program;
  } catch {
    return hashes;
  }
  const add = (name: string | undefined, body: { start: number; end: number } | null | undefined) => {
    if (!name || !body) return;
    const normalized = source.slice(body.start, body.end).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/\s+/g, "");
    if (normalized.length < MIN_BODY_LENGTH) return;
    hashes.set(name, createHash("sha1").update(normalized).digest("hex").slice(0, 16));
  };
  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration" || !statement.declaration) continue;
    const declaration = statement.declaration;
    if (declaration.type === "FunctionDeclaration") add(declaration.id?.name, declaration.body);
    if (declaration.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        const init = item.init;
        if (item.id.type === "Identifier" && init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) {
          add(item.id.name, init.body);
        }
      }
    }
  }
  return hashes;
}

/** Compact one-line form for indexes and search results. */
export function shortSignature(entry: ApiEntry, max = 160): string {
  const oneLine = entry.signature.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** Where in an entry a word of the query was found, best place first. */
export interface ApiMatch {
  /** The entry's own name (the type or function). */
  name: string[];
  /** Names of members written in its declaration (class methods, interface properties). */
  member: string[];
  doc: string[];
  /** Anything else in the declaration, the file path or the block id. */
  other: string[];
}

export interface ApiHit {
  entry: ApiEntry;
  score: number;
  matched: ApiMatch;
}

/** Words of a query in Italian and English that say nothing about what is searched for (accents already removed). */
const STOPWORDS = new Set([
  "il", "lo", "la", "le", "gli", "un", "uno", "una", "di", "da", "in", "con", "su", "per", "tra", "fra", "al", "del", "dal", "nel", "sul", "dei", "dai", "nei", "sui", "ai", "delle", "dalle", "nelle", "sulle", "alle", "degli", "agli", "negli", "sugli", "che", "non", "si", "ed", "ma", "se", "come", "dove", "quando", "chi", "cosa", "sono", "era", "essere", "ho", "ha",
  "the", "an", "of", "to", "for", "in", "on", "at", "by", "with", "from", "and", "or", "is", "are", "be", "it", "this", "that", "as", "how", "what", "where", "when", "do", "does",
]);

/** Ranks entries by how well name, members, doc and location match the words of the query, and says which words matched where. */
export function rankCatalog(catalog: ApiEntry[], query: string, limit = 15): ApiHit[] {
  const all = [...new Set(splitWords(query))];
  // "invio dati al server con metodo http": the little words of a sentence match every comment and drown the rest.
  const words = all.filter((word) => !STOPWORDS.has(word));
  if (all.length > 0 && words.length === 0) words.push(...all);
  if (words.length === 0) return [];
  const scored = catalog.map((entry): ApiHit => {
    const nameWords = splitWords(entry.name);
    const memberWords = splitWords(memberNames(entry).join(" "));
    const docWords = splitWords(entry.doc ?? "");
    const otherWords = splitWords(`${entry.signature} ${entry.file} ${entry.block}`);
    const matched: ApiMatch = { name: [], member: [], doc: [], other: [] };
    let score = 0;
    for (const word of words) {
      // The name decides: a word in the type's own name outweighs the same word anywhere in its body.
      if (nameWords.includes(word)) { score += 5; matched.name.push(word); }
      // A partial word counts when the shorter side has 3 letters at least: "toast" is not "to" (dataToSend).
      // Same stem counts too, for plurals and genders in other languages ("fattura" and "fatture").
      else if (nameWords.some((candidate) => sameStem(candidate, word))) { score += 4; matched.name.push(word); }
      else if (memberWords.some((candidate) => candidate === word || sameStem(candidate, word))) { score += 2; matched.member.push(word); }
      if (docWords.includes(word)) { score += 2; matched.doc.push(word); }
      if (otherWords.includes(word) && !matched.name.includes(word) && !matched.member.includes(word)) { score += 1; matched.other.push(word); }
    }
    // Several words of the query found together beat one word found once.
    const covered = new Set([...matched.name, ...matched.member, ...matched.doc, ...matched.other]).size;
    if (covered > 1) score += covered * 2;
    return { entry, score, matched };
  });
  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit);
}

export function searchCatalog(catalog: ApiEntry[], query: string, limit = 15): ApiEntry[] {
  return rankCatalog(catalog, query, limit).map((hit) => hit.entry);
}

function sameStem(candidate: string, word: string): boolean {
  if (Math.min(candidate.length, word.length) >= 3 && (candidate.startsWith(word) || word.startsWith(candidate))) return true;
  let common = 0;
  while (common < candidate.length && common < word.length && candidate[common] === word[common]) common++;
  // "fattura" / "fatture": the same root and only the ending differs by a letter or two.
  return common >= 5 && candidate.length - common <= 2 && word.length - common <= 2;
}

/** Names of the members a class or interface declaration lists: `name(`, `name:` and `name?:`. */
function memberNames(entry: ApiEntry): string[] {
  if (entry.kind !== "class" && entry.kind !== "interface" && entry.kind !== "namespace" && entry.kind !== "enum") return [];
  const names = new Set<string>();
  // Parameters are not members: drop what is between parentheses first.
  for (const match of entry.signature.replace(/\([^()]*\)/g, "(").matchAll(/([A-Za-z_$][\w$]*)\??\s*[:(=]/g)) names.add(match[1]);
  names.delete(entry.name);
  return [...names];
}

function splitWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

/**
 * Search results as text. With `fromBlock`, each result says whether that block can use it:
 * its own code, a block it already depends on, or a block it would need a new dependency on.
 */
export function describeApiSearch(
  catalog: ApiEntry[],
  query: string,
  fromBlock?: { id: string; dependsOn: string[] },
): string {
  const results = rankCatalog(catalog, query);
  if (results.length === 0) return `No exported symbol matches "${query}". Nothing to reuse.`;
  return results
    .map(({ entry, matched }) => {
      const status = !fromBlock
        ? entry.block
        : entry.block === fromBlock.id
          ? `yours`
          : fromBlock.dependsOn.includes(entry.block)
            ? `already a dependency: ${entry.block}`
            : `new dependency: ${entry.block}`;
      const doc = entry.doc ? ` — ${entry.doc.split("\n")[0]}` : "";
      return `[${status}] ${entry.file}: ${shortSignature(entry)}${doc}${describeMatch(matched)}`;
    })
    .join("\n");
}

/** "(matched: name fattura; member cliente)", so the reader sees why a result is there. */
function describeMatch(matched: ApiMatch): string {
  const parts = (["name", "member", "doc", "other"] as const)
    .filter((place) => matched[place].length > 0)
    .map((place) => `${place === "other" ? "declaration" : place} ${matched[place].join(" ")}`);
  return parts.length > 0 ? ` (matched: ${parts.join("; ")})` : "";
}

/** Export name → normalized oxc declaration, for comparing a file's API before and after an edit. */
export function exportShapes(file: string, oxcDeclarations: string): Map<string, string> {
  const shapes = new Map<string, string>();
  for (const entry of declarationEntries(file, oxcDeclarations)) shapes.set(entry.name, shapes.has(entry.name) ? `${shapes.get(entry.name)}\n${normalizeShape(entry.signature)}` : normalizeShape(entry.signature));
  return shapes;
}

/** Export shapes of a source file as it is now (oxc only, no compiler). */
export function currentExportShapes(file: string, source: string): Map<string, string> {
  return exportShapes(file, isolatedDeclarationSync(parseName(file), source, { sourcemap: false }).code);
}

/** Like currentExportShapes, with each declaration as written too (for showing it, not comparing it). */
export function currentExportDeclarations(file: string, source: string): Map<string, { shape: string; signature: string }> {
  const result = new Map<string, { shape: string; signature: string }>();
  for (const entry of declarationEntries(file, isolatedDeclarationSync(parseName(file), source, { sourcemap: false }).code)) {
    const shape = normalizeShape(entry.signature);
    const signature = entry.signature.replace(/\s+/g, " ").trim();
    const earlier = result.get(entry.name);
    result.set(entry.name, earlier ? { shape: `${earlier.shape}\n${shape}`, signature: `${earlier.signature}\n${signature}` } : { shape, signature });
  }
  return result;
}

/**
 * Members written one per line without a terminator (Go) get a `;`, so that the shape still tells where one
 * ends: the line break would otherwise be flattened with the rest of the white space.
 */
function terminateMembers(signature: string): string {
  if (!signature.includes("\n")) return signature;
  let depth = 0;
  let nesting = 0;
  let out = "";
  const lines = signature.split("\n");
  for (const [index, line] of lines.entries()) {
    const code = line.trimEnd();
    out += code;
    for (const char of code) {
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === "(" || char === "[") nesting++;
      else if (char === ")" || char === "]") nesting--;
    }
    const next = lines[index + 1]?.trim();
    // A line that ends a member of a type body: inside the outer braces only, outside any parameter list.
    if (next && depth === 1 && nesting === 0 && code.trim() && !/[;,{(\[|&=:]$/.test(code) && !/^[|&)\].]/.test(next)) out += ";";
    out += "\n";
  }
  return out;
}

export function normalizeShape(signature: string): string {
  return terminateMembers(signature).replace(/\s+/g, " ").replace(/\s*([{}();,:<>|&=])\s*/g, "$1").trim();
}
