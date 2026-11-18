import { type Analysis, matchNote } from "../analysis/analyze.js";
import { blockForFile } from "../model/index.js";
import type { Changes } from "./changes.js";
import { type ApiChange, readsExports } from "./impact.js";

const REVIEW_SITES = 8;

/** The review of the uncommitted work, for an agent about to commit or hand back; `since` names what it is compared with. */
export function renderReview(analysis: Analysis, changes: Changes, api: ApiChange[], since = "the last commit"): string {
  if (!changes.git) return "Not a git repository: there is no last commit to compare with.";
  const files = Object.entries(changes.files);
  const map = changes.mapChanged ? "The map (`.cantus/model.json`) has changes not committed yet: commit it with the code it describes." : "";
  if (files.length === 0) return map ? `No code changes since ${since}. ${map}` : `No changes since ${since}.`;
  const blockOf = new Map<string, string>();
  for (const info of analysis.blocks) for (const file of info.files) blockOf.set(file, info.block.id);
  const name = (id: string) => analysis.blocks.find((info) => info.block.id === id)?.block.name ?? id;
  const added = files.reduce((sum, [, change]) => sum + change.added, 0);
  const removed = files.reduce((sum, [, change]) => sum + change.removed, 0);
  const lines = [`# Changes since ${since}: ${files.length} file(s), +${added} −${removed}`, "", "## By block", ""];
  const byBlock = new Map<string, string[]>();
  for (const [file, change] of files.sort(([a], [b]) => a.localeCompare(b))) {
    const owner = blockOf.get(file) ?? blockForFile(analysis.blocks.map((info) => info.block), file)?.id ?? "";
    const label = change.binary ? `${change.status}, binary` : `${change.status === "added" ? "new, " : change.status === "deleted" ? "deleted, " : ""}+${change.added} −${change.removed}`;
    byBlock.set(owner, [...(byBlock.get(owner) ?? []), `\`${file}\` (${label})`]);
  }
  for (const [owner, entries] of byBlock) lines.push(`- ${owner ? `${name(owner)} (\`${owner}\`)` : "No block"}: ${entries.join(", ")}`);
  if (map) lines.push("", map);

  const breaking = api.filter((change) => change.kind !== "added");
  lines.push("", "## API changes", "");
  if (breaking.length === 0) lines.push("No export was changed or removed.");
  for (const change of breaking) {
    const what = change.kind === "removed" ? `was removed from \`${change.file}\`` : `changed in \`${change.file}\`: \`${oneLine(change.before)}\` → \`${oneLine(change.after)}\``;
    const sites = change.callers.length
      ? `${change.callers.length} call site(s) in ${analysis.blocksInferred ? "other files" : "other blocks"}: ${change.callers.slice(0, REVIEW_SITES).map((site) => `${site.file}:${site.line}${matchNote(site)}`).join(", ")}${change.callers.length > REVIEW_SITES ? ", …" : ""}`
      : `no call site in ${analysis.blocksInferred ? "other files" : "other blocks"}`;
    lines.push(`- \`${change.name}\` ${what}${change.members ? ` (${change.members})` : ""}. ${sites}.`);
  }
  const fresh = api.filter((change) => change.kind === "added");
  // A new top-level constant or variable (in a script without modules, nearly every one is an export) is named, not asked to be checked.
  const isValue = (change: ApiChange) => /^(export\s+)?(declare\s+)?(const|let|var)\b/.test(change.after ?? "");
  const declarations = fresh.filter((change) => !isValue(change));
  const values = fresh.filter(isValue);
  if (declarations.length) lines.push("", "## New exports", "", ...declarations.map((change) => `- \`${change.name}\` in \`${change.file}\`${change.block ? ` (${change.block})` : ""}: \`${oneLine(change.after)}\``), "", "Check with find_api that none of them duplicates something another block already offers.");
  if (values.length) lines.push("", `${declarations.length ? "Also " : ""}${values.length} new constant(s) or variable(s): ${values.slice(0, 12).map((change) => `\`${change.name}\``).join(", ")}${values.length > 12 ? ", …" : ""}.`);

  // A file whose exports did not change is not what its usual partners depend on: only files whose exports cannot be read (pages, styles) keep the note.
  const apiFiles = new Set(api.map((change) => change.file));
  const changed = new Set(files.map(([file]) => file));
  const missing = analysis.coChanges
    .filter((pair) => changed.has(pair.files[0]) !== changed.has(pair.files[1]))
    .filter((pair) => {
      const file = changed.has(pair.files[0]) ? pair.files[0] : pair.files[1];
      return !readsExports(file) || apiFiles.has(file);
    })
    .slice(0, 10)
    .map((pair) => {
      const [file, other] = changed.has(pair.files[0]) ? pair.files : [pair.files[1], pair.files[0]];
      return `- \`${file}\` usually changes with \`${other}\` (${pair.commits} commits), which is unchanged.`;
    });
  if (missing.length) lines.push("", "## Usually changed together, not this time", "", ...missing);
  return lines.join("\n");
}

function oneLine(text: string | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 120 ? flat.slice(0, 119) + "…" : flat;
}
