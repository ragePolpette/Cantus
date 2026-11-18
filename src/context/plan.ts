import type { Analysis } from "../analysis/analyze.js";
import type { ArchModel, Block } from "../model/index.js";

/** What the map asks for and the code does not have yet: the work for "Build the plan". */
export interface BuildPlan {
  /** Blocks on the map with no code, in waves: a wave uses only blocks built before it (or already there). */
  waves: Block[][];
  /** Arrows on the map that the code does not follow yet, between blocks of any kind. */
  arrows: Array<{ from: string; to: string }>;
}

/**
 * The planned parts of the map: blocks without code and arrows not in the code. Blocks are ordered
 * so that providers come before the blocks that use them; blocks in the same wave are independent.
 */
export function buildPlan(analysis: Analysis, model: ArchModel | undefined): BuildPlan {
  const planned = analysis.blocks.filter((info) => info.files.length === 0).map((info) => info.block);
  const inCode = new Set(analysis.dependencies.map((dep) => `${dep.from}->${dep.to}`));
  const arrows = (model?.dependencies ?? []).filter((dep) => !inCode.has(`${dep.from}->${dep.to}`)).map((dep) => ({ from: dep.from, to: dep.to }));
  const waves: Block[][] = [];
  const done = new Set<string>();
  let left = planned;
  while (left.length > 0) {
    const pending = new Set(left.map((block) => block.id));
    // Ready: every planned block it uses is built already (arrows to existing blocks never wait).
    const ready = left.filter((block) => arrows.every((dep) => dep.from !== block.id || !pending.has(dep.to) || dep.to === block.id));
    // A cycle among planned blocks: build the rest together, the agents settle the order.
    const wave = ready.length > 0 ? ready : left;
    waves.push(wave);
    for (const block of wave) done.add(block.id);
    left = left.filter((block) => !done.has(block.id));
  }
  return { waves, arrows };
}

export function planIsEmpty(plan: BuildPlan): boolean {
  return plan.waves.length === 0 && plan.arrows.length === 0;
}

/** The plan for the coordinating agent: blocks to create, wave by wave, and arrows to connect. */
export function renderPlan(plan: BuildPlan, analysis: Analysis): string {
  const name = (id: string) => analysis.blocks.find((info) => info.block.id === id)?.block.name ?? id;
  const lines = ["## The plan: what the map has and the code does not", ""];
  if (plan.waves.length) {
    lines.push("Blocks to create, in waves. A wave uses only blocks from earlier waves or blocks that already exist; the blocks of one wave are independent and can be built in parallel.", "");
    plan.waves.forEach((wave, index) => {
      lines.push(`### Wave ${index + 1}`, "");
      for (const block of wave) {
        const uses = plan.arrows.filter((dep) => dep.from === block.id).map((dep) => `\`${dep.to}\``);
        const usedBy = plan.arrows.filter((dep) => dep.to === block.id).map((dep) => `\`${dep.from}\``);
        lines.push(`- \`${block.id}\` ${block.name} (${block.layer}), folder \`${block.include[0]}\`${block.description ? ` — ${block.description.replace(/\.\s*$/, "")}` : ""}. Uses: ${uses.join(", ") || "—"}. Will be used by: ${usedBy.join(", ") || "—"}.`);
      }
      lines.push("");
    });
  }
  const between = plan.arrows.filter((dep) => !plan.waves.some((wave) => wave.some((block) => block.id === dep.from)));
  if (between.length) {
    lines.push("Arrows to connect from blocks that already exist (the first block should use the second, once it exists):", "");
    for (const dep of between) lines.push(`- ${name(dep.from)} (\`${dep.from}\`) → ${name(dep.to)} (\`${dep.to}\`)`);
    lines.push("");
  }
  return lines.join("\n");
}
