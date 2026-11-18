import type { Analysis, CodeDependency } from "./analyze.js";

export interface Reach {
  block: string;
  /** Steps from the starting block: 1 is a block that uses it (or that it uses) directly. */
  distance: number;
  /** A shortest chain from the starting block to this one, both ends included. */
  path: string[];
}

/**
 * Blocks reached by following dependencies from `block`: `dependents` are the blocks that use it,
 * directly or through others (what a change can break); `dependencies` are the blocks it uses.
 * Nearest first, then by id, so the answer is the same on every run.
 */
export function reach(dependencies: Array<Pick<CodeDependency, "from" | "to">>, block: string, direction: "dependents" | "dependencies"): Reach[] {
  const next = new Map<string, string[]>();
  for (const dep of dependencies) {
    const [source, target] = direction === "dependents" ? [dep.to, dep.from] : [dep.from, dep.to];
    next.set(source, [...(next.get(source) ?? []), target]);
  }
  const seen = new Map<string, Reach>([[block, { block, distance: 0, path: [block] }]]);
  let frontier = [block];
  while (frontier.length > 0) {
    const following: string[] = [];
    for (const current of frontier) {
      for (const target of [...(next.get(current) ?? [])].sort()) {
        if (seen.has(target)) continue;
        const from = seen.get(current)!;
        seen.set(target, { block: target, distance: from.distance + 1, path: [...from.path, target] });
        following.push(target);
      }
    }
    frontier = following;
  }
  seen.delete(block);
  return [...seen.values()].sort((a, b) => a.distance - b.distance || a.block.localeCompare(b.block));
}

/** Direct users listed before "… N more"; the transitive ones are listed one by one up to this many. */
const DIRECT_SHOWN = 25;
const INDIRECT_LISTED = 8;
const DEPENDENCIES_SHOWN = 12;

/** The answer to "what does changing this block touch?", for a coding agent or for the terminal. */
export function describeImpact(analysis: Analysis, blockId: string, options: { full?: boolean } = {}): string {
  const info = analysis.blocks.find((candidate) => candidate.block.id === blockId);
  if (!info) throw new Error(`Unknown block "${blockId}". Known blocks: ${analysis.blocks.map((candidate) => candidate.block.id).join(", ")}`);
  const names = new Map(analysis.blocks.map((candidate) => [candidate.block.id, candidate.block.name]));
  const label = (id: string) => `\`${id}\`${names.get(id) && names.get(id) !== id ? ` (${names.get(id)})` : ""}`;
  const dependents = reach(analysis.dependencies, blockId, "dependents");
  const dependencies = reach(analysis.dependencies, blockId, "dependencies");

  const lines = [`# Impact of changing ${label(blockId)}`, ""];
  if (dependents.length === 0) {
    lines.push("No block uses it: a change here stays inside the block.");
  } else {
    const direct = dependents.filter((entry) => entry.distance === 1);
    const indirect = dependents.filter((entry) => entry.distance > 1);
    lines.push(`${dependents.length} of ${analysis.blocks.length - 1} other block(s) can be affected: ${direct.length} directly${indirect.length ? `, ${indirect.length} through others` : ""}.`, "", "## Use it directly");
    const shownDirect = options.full ? direct : direct.slice(0, DIRECT_SHOWN);
    for (const entry of shownDirect) {
      const sites = new Map<string, boolean>();
      for (const site of analysis.callSites) {
        if (site.targetBlock === blockId && site.block === entry.block) sites.set(`${site.file}:${site.line}:${site.column}:${site.symbol}`, site.match === "by-name");
      }
      const symbols = analysis.dependencies.find((dep) => dep.from === entry.block && dep.to === blockId)?.symbols ?? [];
      const weak = [...sites.values()].filter(Boolean).length;
      const detail = [symbols.length ? symbols.slice(0, 6).join(", ") + (symbols.length > 6 ? ", …" : "") : "", sites.size ? `${sites.size} call site(s)${weak ? `, ${weak} found by name only` : ""}` : ""].filter(Boolean).join("; ");
      lines.push(`- ${label(entry.block)}${detail ? ` — ${detail}` : ""}`);
    }
    if (direct.length > shownDirect.length) lines.push(`- … ${direct.length - shownDirect.length} more direct user(s): \`callers\` with \`block: "${blockId}"\` lists the call sites, \`full\` lists the blocks.`);
    if (indirect.length && (options.full || indirect.length <= INDIRECT_LISTED)) {
      lines.push("", "## Through others (they use a block that uses it)");
      for (const entry of indirect) lines.push(`- ${label(entry.block)}, ${entry.distance} steps: ${[...entry.path].reverse().map((id) => `\`${id}\``).join(" → ")}`);
    } else if (indirect.length) {
      // Most of them pass through a few hubs: say which, not every chain.
      const through = new Map<string, number>();
      for (const entry of indirect) through.set(entry.path[1], (through.get(entry.path[1]) ?? 0) + 1);
      const hubs = [...through.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      lines.push("", `## Through others: ${indirect.length} block(s)`, "", "They do not use it themselves; they use a block that does. Where they pass through:");
      for (const [hub, count] of hubs.slice(0, 6)) lines.push(`- ${count} via ${label(hub)}`);
      if (hubs.length > 6) lines.push(`- … ${hubs.length - 6} more`);
      lines.push("", "`full` lists each one with its chain.");
    }
    lines.push("", "`callers` lists the call sites of one export; the direct users are the ones to read first.");
  }
  if (dependencies.length) {
    const shown = options.full ? dependencies : dependencies.slice(0, DEPENDENCIES_SHOWN);
    lines.push("", `It depends on ${dependencies.length} block(s): ${shown.map((entry) => `${label(entry.block)}${entry.distance > 1 ? ` (${entry.distance} steps)` : ""}`).join(", ")}${dependencies.length > shown.length ? `, … ${dependencies.length - shown.length} more` : ""}. A change in them can reach it.`);
  }
  return lines.join("\n");
}
