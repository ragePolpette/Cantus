import type { Analysis } from "./analyze.js";
import { type Finding, weakestLink } from "./rules.js";

/** One line of the findings list: a finding as it is, or a group of many alike. */
export interface FindingLine {
  severity: Finding["severity"];
  kind: Finding["kind"];
  message: string;
}

/** A kind with this many findings or fewer is listed one by one. */
const GROUP_FROM = 4;
const BIG_CYCLE = 6;
const NAMES_SHOWN = 6;
const GROUPS_SHOWN = 8;

const plain = (finding: Finding): FindingLine => ({ severity: finding.severity, kind: finding.kind, message: finding.message });

/**
 * The findings as a reader wants them: the architecture ones (cycles, layers, breaking changes) one by
 * one and first, a large cycle with the blocks that hold it together, and the repetitive kinds (identical
 * functions, contracts that need types) as one line per group of files or per kind. `full` lists every
 * finding as `check` found it.
 */
export function renderFindings(findings: Finding[], analysis?: Analysis, options: { full?: boolean } = {}): FindingLine[] {
  if (options.full) return findings.map(plain);
  const lines: FindingLine[] = [];
  const grouped = new Map<Finding["kind"], Finding[]>();
  for (const finding of findings) {
    if (finding.kind === "cycle") lines.push(cycleLine(finding, analysis));
    else if (finding.kind === "duplicate-implementation" || finding.kind === "incomplete-contract" || finding.kind === "inferred-contract") {
      grouped.set(finding.kind, [...(grouped.get(finding.kind) ?? []), finding]);
    } else lines.push(plain(finding));
  }
  for (const [kind, group] of grouped) {
    if (group.length < GROUP_FROM) lines.push(...group.map(plain));
    else if (kind === "duplicate-implementation") lines.push(...duplicateLines(group));
    else lines.push(contractLine(kind, group));
  }
  const rank = { error: 0, warning: 1, info: 2 };
  return lines.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** A cycle through many blocks is one line, with the blocks that have the most arrows inside it. */
function cycleLine(finding: Finding, analysis?: Analysis): FindingLine {
  if (finding.blocks.length <= BIG_CYCLE) return plain(finding);
  const inside = new Set(finding.blocks);
  const degree = new Map<string, number>();
  for (const dep of analysis?.dependencies ?? []) {
    if (!inside.has(dep.from) || !inside.has(dep.to)) continue;
    degree.set(dep.from, (degree.get(dep.from) ?? 0) + 1);
    degree.set(dep.to, (degree.get(dep.to) ?? 0) + 1);
  }
  const hubs = [...degree.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([id, count]) => `${id} (${count} arrows)`);
  const listed = finding.blocks.slice(0, BIG_CYCLE).join(", ");
  return {
    severity: finding.severity,
    kind: finding.kind,
    message: `Dependency cycle through ${finding.blocks.length} blocks: ${listed}, … ${finding.blocks.length - BIG_CYCLE} more.${hubs.length ? ` Most connected inside it: ${hubs.join(", ")}: break it where they meet.` : ""}${weakestLink(finding.blocks, analysis?.dependencies ?? [])} \`check --full\` lists them all.`,
  };
}

/** Identical functions: one line per pair (or set) of files that hold them. */
function duplicateLines(group: Finding[]): FindingLine[] {
  const byFiles = new Map<string, Finding[]>();
  for (const finding of group) byFiles.set((finding.files ?? [finding.message]).join(" ↔ "), [...(byFiles.get((finding.files ?? [finding.message]).join(" ↔ ")) ?? []), finding]);
  const sets = [...byFiles.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const lines: FindingLine[] = [];
  for (const [files, findings] of sets.slice(0, GROUPS_SHOWN)) {
    if (findings.length === 1) {
      lines.push(plain(findings[0]));
      continue;
    }
    const names = [...new Set(findings.flatMap((finding) => finding.names ?? []))];
    const label = files.split(" ↔ ").map((file) => `\`${file}\``).join(" ↔ ");
    lines.push({
      severity: "info",
      kind: "duplicate-implementation",
      message: `${label}: ${findings.length} identical function(s) (${names.slice(0, NAMES_SHOWN).join(", ")}${names.length > NAMES_SHOWN ? ", …" : ""}).`,
    });
  }
  if (sets.length > GROUPS_SHOWN) {
    const rest = sets.slice(GROUPS_SHOWN).reduce((sum, [, findings]) => sum + findings.length, 0);
    lines.push({ severity: "info", kind: "duplicate-implementation", message: `… ${rest} more identical function(s) in ${sets.length - GROUPS_SHOWN} other group(s) of files (\`check --full\`).` });
  }
  return lines;
}

/** Contracts that need types: one line with the count per block. */
function contractLine(kind: Finding["kind"], group: Finding[]): FindingLine {
  const perBlock = new Map<string, number>();
  let files = 0;
  for (const finding of group) {
    const count = finding.files?.length ?? 1;
    files += count;
    const block = finding.blocks[0] ?? "(no block)";
    perBlock.set(block, (perBlock.get(block) ?? 0) + count);
  }
  const blocks = [...perBlock.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = blocks.slice(0, 8).map(([block, count]) => `${block} (${count})`).join(", ");
  const rest = blocks.length > 8 ? `, … ${blocks.length - 8} more` : "";
  if (kind === "incomplete-contract") {
    return { severity: "warning", kind, message: `${files} public file(s) have incomplete contracts (declarations need type inference): ${shown}${rest}. Add explicit types to their exports or install typescript in the project. \`check --full\` names the files.` };
  }
  return { severity: "info", kind, message: `${files} public file(s) in ${blocks.length} block(s) rely on inferred types: ${shown}${rest}. Explicit types on exports make contracts faster and stable. \`check --full\` lists them.` };
}
