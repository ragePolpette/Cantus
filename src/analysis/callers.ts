import fs from "node:fs";
import path from "node:path";
import type { Analysis, CallSite } from "./analyze.js";

export interface CallerQuery {
  /** An exported name, or `Type.member` for a method or property of an export. */
  symbol?: string;
  /** File that defines the symbol, relative to the map's root. */
  file?: string;
  block?: string;
  /**
   * Also list callers inside the same block. Unset: only when the blocks are inferred from folders (no map
   * saved), where a block can be half the project and hiding its callers hides real ones.
   */
  includeSameBlock?: boolean;
}

export interface CallerAnswer {
  sites: CallSite[];
  /** What the caller should know before trusting the list: how the symbol was read, what is missing. */
  notes: string[];
}

/** Lines per file kept when looking for a member by name, so a very common name does not flood the answer. */
const MEMBER_LINES_PER_FILE = 20;

/**
 * Where an export is used. A plain name is matched against the export; `Type.member` finds the uses of
 * the member too, by name, in the files that use the type. A name that is neither an export nor a
 * `Type.member` of one is said so: "no callers" there would read as "dead code".
 */
export function findCallers(analysis: Analysis, query: CallerQuery): CallerAnswer {
  const notes: string[] = [];
  const includeSame = query.includeSameBlock ?? analysis.blocksInferred;
  const inScope = (site: CallSite) => (!query.file || site.targetFile === query.file) && (!query.block || site.targetBlock === query.block);
  const sameBlock = (site: CallSite) => site.block === site.targetBlock;
  const keep = (site: CallSite) => inScope(site) && (includeSame || !sameBlock(site));
  // What the default leaves out is said, never dropped in silence: the list would read as complete.
  const hiddenNote = (considered: CallSite[]): string[] => {
    const hidden = distinctSites(considered.filter((site) => inScope(site) && sameBlock(site))).length;
    return !includeSame && hidden > 0 ? [`${hidden} more call site(s) inside the block itself are not listed (\`include_same_block\` lists them).`] : [];
  };
  const answer = (sites: CallSite[], considered: CallSite[]): CallerAnswer => ({ sites, notes: sites.length === 0 ? [...notes, ...emptyNotes(analysis, { ...query, includeSameBlock: includeSame }, notes)] : [...notes, ...hiddenNote(considered)] });

  if (!query.symbol) return answer(analysis.callSites.filter(keep), analysis.callSites);

  const symbol = query.symbol.trim();
  const direct = analysis.callSites.filter((site) => site.symbol === symbol);
  const dot = symbol.lastIndexOf(".");
  if (dot > 0) {
    const type = symbol.slice(0, dot);
    const member = symbol.slice(dot + 1);
    const typeKnown = analysis.catalog.some((entry) => entry.name === type) || analysis.callSites.some((site) => site.symbol === type);
    if (!typeKnown && direct.length === 0) {
      notes.push(`\`${type}\` is not an export indexed by Cantus, so \`${symbol}\` cannot be looked up. \`find_api\` finds exports by name.`);
      return { sites: [], notes };
    }
    const byNameAll = membersUsed(analysis, type, member, inScope);
    const byName = byNameAll.filter(keep);
    if (byName.length > 0) notes.push(`\`${member}\` is also looked for by name in the files that use \`${type}\` (marked "by name only"): a call through a variable of another type with the same member name would show too.`);
    return answer([...direct.filter(keep), ...byName], [...direct, ...byNameAll]);
  }

  const isExport = direct.length > 0 || analysis.catalog.some((entry) => entry.name === symbol);
  if (isExport) return answer(direct.filter(keep), direct);

  // Not an export: a method or property of one?
  const owners = membersNamed(analysis, symbol);
  if (owners.length === 0) {
    notes.push(`\`${symbol}\` is not an export Cantus indexes (callers answers for exported names, and \`Type.member\` for what they hold). If it is a local function or a name in a library, search the code with grep.`);
    return { sites: [], notes };
  }
  if (owners.length > 1) {
    notes.push(`\`${symbol}\` is not an export; it is a member of ${owners.slice(0, 8).map((owner) => `\`${owner}\``).join(", ")}${owners.length > 8 ? `, … ${owners.length - 8} more` : ""}. Ask for one of them, like \`${owners[0]}.${symbol}\`.`);
    return { sites: [], notes };
  }
  const resolved = `${owners[0]}.${symbol}`;
  notes.push(`\`${symbol}\` is not an export; it is a member of \`${owners[0]}\`, so this answers for \`${resolved}\`.`);
  const inner = findCallers(analysis, { ...query, symbol: resolved });
  return { sites: inner.sites, notes: [...notes, ...inner.notes] };
}

/** Call sites counted once per place: the same line can be listed for two bindings. */
function distinctSites(sites: CallSite[]): CallSite[] {
  const seen = new Set<string>();
  return sites.filter((site) => {
    const id = `${site.file}:${site.line}:${site.column}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function emptyNotes(analysis: Analysis, query: CallerQuery, already: string[]): string[] {
  if (already.length > 0 || !query.symbol) return [];
  const sameBlock = analysis.callSites.filter((site) => site.symbol === query.symbol && site.block === site.targetBlock && (!query.file || site.targetFile === query.file));
  if (!query.includeSameBlock && sameBlock.length > 0) return [`No callers in other blocks; ${sameBlock.length} inside the block itself (\`include_same_block\` lists them).`];
  if (query.symbol.includes(".")) return [`No call of \`${query.symbol}\` found outside the file that defines it.`];
  return [`\`${query.symbol}\` is an export, and nothing in the project calls it outside the file that defines it.`];
}

/** Types (exports) whose declaration has a member with this name: a method, a property, a field. */
function membersNamed(analysis: Analysis, member: string): string[] {
  const owners = new Set<string>();
  const declared = new RegExp(`(?<![\\w$.])${escapeRegExp(member)}\\s*[(:;=?<{]|(?<![\\w$.])${escapeRegExp(member)}\\s*$`, "m");
  for (const entry of analysis.catalog) {
    if (entry.kind === "function" || entry.kind === "variable") continue;
    // The first line is the type's own declaration; the members follow.
    const body = entry.signature.split("\n").slice(1).join("\n");
    if (declared.test(body)) owners.add(entry.name);
  }
  // HTTP endpoints are named Type.member already.
  for (const site of analysis.callSites) {
    const dot = site.symbol.lastIndexOf(".");
    if (dot > 0 && site.symbol.slice(dot + 1) === member) owners.add(site.symbol.slice(0, dot));
  }
  return [...owners].sort();
}

/** Lines that use `member` in the files that use `type`: the call itself, found by its name. */
function membersUsed(analysis: Analysis, type: string, member: string, keep: (site: CallSite) => boolean): CallSite[] {
  const typeSites = analysis.callSites.filter((site) => site.symbol === type && site.via !== "http");
  const definedIn = new Set([...typeSites.map((site) => site.targetFile), ...analysis.catalog.filter((entry) => entry.name === type).map((entry) => entry.file)]);
  const targets = new Map<string, CallSite>();
  for (const site of typeSites) if (!targets.has(site.file)) targets.set(site.file, site);
  const use = new RegExp(`(?:\\.|->|::)\\s*${escapeRegExp(member)}\\b|(?<![\\w$.])${escapeRegExp(member)}\\s*\\(`);
  const found: CallSite[] = [];
  for (const [file, first] of targets) {
    if (definedIn.has(file)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(analysis.root, file), "utf8");
    } catch {
      continue;
    }
    let lines = 0;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const code = line.trim();
      if (!code || code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || code.startsWith("#")) continue;
      const hit = use.exec(line);
      if (!hit) continue;
      const site: CallSite = {
        symbol: `${type}.${member}`,
        targetFile: first.targetFile,
        ...(first.targetBlock ? { targetBlock: first.targetBlock } : {}),
        file,
        ...(first.block ? { block: first.block } : {}),
        line: index + 1,
        column: hit.index + 1,
        snippet: code.length > 200 ? `${code.slice(0, 199)}…` : code,
        via: "type",
        match: "by-name",
      };
      if (!keep(site)) break;
      found.push(site);
      if (++lines >= MEMBER_LINES_PER_FILE) break;
    }
  }
  return found;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
