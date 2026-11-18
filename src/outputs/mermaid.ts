import type { Analysis } from "../analysis/analyze.js";
import type { Finding } from "../analysis/rules.js";
import { type ArchModel, UNASSIGNED, modelLayers } from "../model/index.js";

/**
 * The block graph as a Mermaid flowchart, for places that render it themselves (a pull request
 * comment, a README, a wiki): one box per block grouped by layer, one arrow per dependency
 * (dashed: not in the map; thick and red: breaks a layer rule; dotted: in the map, not in the code yet).
 */
export function renderMermaid(analysis: Analysis, model: ArchModel | undefined, findings: Finding[]): string {
  const ids = new Map(analysis.blocks.map((info, index) => [info.block.id, `b${index + 1}`]));
  const text = (value: string) => value.replace(/&/g, "#amp;").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;");

  const layers = [...modelLayers(model), UNASSIGNED].filter((layer) => analysis.blocks.some((info) => info.block.layer === layer));
  const lines = ["flowchart TB"];
  layers.forEach((layer, index) => {
    lines.push(`  subgraph L${index + 1}["${text(layer)}"]`);
    for (const info of analysis.blocks.filter((candidate) => candidate.block.layer === layer)) {
      lines.push(`    ${ids.get(info.block.id)}["${text(info.block.name)}<br/>${info.files.length} file${info.files.length === 1 ? "" : "s"}"]`);
    }
    lines.push("  end");
  });

  const arrows: Array<{ from: string; to: string; kind: "ok" | "undeclared" | "violation" | "planned" }> = [];
  for (const dep of analysis.dependencies) {
    const related = findings.filter((finding) => finding.from === dep.from && finding.to === dep.to);
    const kind = related.some((finding) => finding.kind === "undeclared-dependency") ? "undeclared" : related.some((finding) => finding.kind === "layer-violation") ? "violation" : "ok";
    arrows.push({ from: dep.from, to: dep.to, kind });
  }
  for (const dep of model?.dependencies ?? []) {
    if (!arrows.some((arrow) => arrow.from === dep.from && arrow.to === dep.to)) arrows.push({ from: dep.from, to: dep.to, kind: "planned" });
  }
  const arrow = { ok: "-->", undeclared: "-.->", violation: "==>", planned: "-.-" } as const;
  const drawn = arrows.filter((candidate) => ids.has(candidate.from) && ids.has(candidate.to));
  drawn.forEach((candidate) => lines.push(`  ${ids.get(candidate.from)} ${arrow[candidate.kind]} ${ids.get(candidate.to)}`));
  const violations = drawn.flatMap((candidate, index) => (candidate.kind === "violation" ? [index] : []));
  if (violations.length) lines.push(`  linkStyle ${violations.join(",")} stroke:#dc2626,stroke-width:3px`);
  return lines.join("\n") + "\n";
}
