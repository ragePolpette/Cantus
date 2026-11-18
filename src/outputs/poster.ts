import type { ViewData } from "./view.js";

/**
 * The map as one still picture, for a README, a post or a pull request: the lanes, the blocks as wide as the code
 * they hold, the arrows between them (quiet, except a broken rule and a dependency the map does not list), and
 * the marks that matter: a block with findings, a hotspot, a block the working tree touches. One SVG file with no
 * script and no font to load, so it renders where a page cannot (GitHub shows it as an image).
 */
export interface PosterOptions {
  /** The picture's width in pixels (default 1200). */
  width?: number;
  /** A line under the title, e.g. the branch or the pull request. */
  subtitle?: string;
}

const MARGIN = 28;
const HEADER = 64;
const FOOTER = 40;
const LANE_PAD_TOP = 30;
const LANE_PAD = 16;
const CARD_HEIGHT = 106;
const CARD_MIN = 168;
const CARD_MAX = 264;
const COL_GAP = 26;
const ROW_GAP = 28;
const LANE_GAP = 30;

/** Colors the page itself uses, fixed here: a picture has no theme to follow. */
const INK = "#16222d";
const MUTED = "#5b6b78";
const SOFT = "#8a99a6";
const BLUE = "#0d6e92";
const ORANGE = "#d9701b";
const RED = "#c0322b";
const GREEN = "#2e9e5b";
const VIOLET = "#7a4fc0";
const YELLOW = "#b9851a";

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (tokens: number) => (tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : String(tokens));
const plural = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;

/** A text cut to fit a width, by an estimate of the average glyph width (the picture cannot measure a font it does not load). */
function fit(text: string, width: number, size: number, factor = 0.58): string {
  const room = Math.max(1, Math.floor(width / (size * factor)));
  return text.length <= room ? text : text.slice(0, Math.max(1, room - 1)) + "…";
}

interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  lane: number;
}

export function renderPoster(view: ViewData, options: PosterOptions = {}): string {
  const width = Math.max(640, Math.round(options.width ?? 1200));
  const inner = width - MARGIN * 2 - LANE_PAD * 2;
  const lanes = view.lanes.filter((lane) => view.blocks.some((block) => block.lane === lane));

  // Layout: each lane a row of cards (wrapping), a card as wide as its block's weight asks.
  const placed = new Map<string, Placed>();
  const laneBoxes: Array<{ name: string; y: number; h: number }> = [];
  let y = MARGIN + HEADER;
  lanes.forEach((lane, laneIndex) => {
    const blocks = view.blocks.filter((block) => block.lane === lane);
    const widths = blocks.map((block) => Math.round(CARD_MIN + (CARD_MAX - CARD_MIN) * block.weight));
    const rows: Array<Array<{ id: string; w: number }>> = [[]];
    let used = 0;
    blocks.forEach((block, index) => {
      const need = widths[index] + (rows[rows.length - 1].length ? COL_GAP : 0);
      if (used + need > inner && rows[rows.length - 1].length) { rows.push([]); used = 0; }
      used += widths[index] + (rows[rows.length - 1].length ? COL_GAP : 0);
      rows[rows.length - 1].push({ id: block.id, w: widths[index] });
    });
    const top = y;
    let rowY = y + LANE_PAD_TOP;
    for (const row of rows) {
      const total = row.reduce((sum, card) => sum + card.w, 0) + COL_GAP * (row.length - 1);
      let x = MARGIN + LANE_PAD + (inner - total) / 2;
      for (const card of row) {
        placed.set(card.id, { id: card.id, x, y: rowY, w: card.w, lane: laneIndex });
        x += card.w + COL_GAP;
      }
      rowY += CARD_HEIGHT + ROW_GAP;
    }
    const height = rowY - ROW_GAP - top + LANE_PAD;
    laneBoxes.push({ name: lane, y: top, h: height });
    y = top + height + LANE_GAP;
  });
  const height = Math.max(y - LANE_GAP + FOOTER + MARGIN, MARGIN * 2 + HEADER + FOOTER);

  const out: string[] = [];
  const total = view.blocks.reduce((sum, block) => sum + block.tokens, 0);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t d" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">`);
  out.push(`<title id="t">${esc(view.name)}: map of the code</title>`);
  out.push(`<desc id="d">${esc(plural(view.blocks.length, "block", "blocks"))} in ${esc(plural(lanes.length, "lane", "lanes"))}, ${esc(plural(view.edges.length, "dependency", "dependencies"))}. Drawn by Cantus.</desc>`);
  out.push(`<defs>`);
  for (const [name, color] of [["ok", SOFT], ["undeclared", VIOLET], ["violation", ORANGE], ["planned", SOFT]] as const) {
    out.push(`<marker id="m-${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`);
  }
  out.push(`</defs>`);
  out.push(`<rect width="${width}" height="${height}" fill="#f2f5f7"/>`);

  // Header.
  out.push(`<text x="${MARGIN}" y="${MARGIN + 22}" font-size="22" font-weight="700" fill="${INK}" letter-spacing="2">CANTUS</text>`);
  out.push(`<text x="${MARGIN + 124}" y="${MARGIN + 22}" font-size="18" fill="${MUTED}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">/ ${esc(fit(view.name, width / 2 - 160, 18, 0.62))}</text>`);
  const summary = `${plural(view.blocks.length, "block", "blocks")} · ${plural(view.edges.filter((edge) => edge.status !== "planned").length, "dependency", "dependencies")} · ~${fmt(total)} tokens`;
  out.push(`<text x="${width - MARGIN}" y="${MARGIN + 20}" font-size="14" text-anchor="end" fill="${MUTED}">${esc(summary)}</text>`);
  if (options.subtitle) out.push(`<text x="${MARGIN}" y="${MARGIN + 46}" font-size="14" fill="${MUTED}">${esc(fit(options.subtitle, width - MARGIN * 2, 14))}</text>`);

  // Lanes.
  for (const lane of laneBoxes) {
    out.push(`<rect x="${MARGIN}" y="${lane.y}" width="${width - MARGIN * 2}" height="${lane.h}" rx="10" fill="#e8edf1" stroke="#cfd8df" stroke-dasharray="4 4"/>`);
    out.push(`<text x="${MARGIN + 16}" y="${lane.y + 20}" font-size="11" letter-spacing="1.6" fill="${SOFT}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">${esc(lane.name.toUpperCase())}</text>`);
  }

  // Arrows under the cards, so a card hides what passes behind it. The quiet ones first, the rule breaks over them.
  const rank = { planned: 0, ok: 1, undeclared: 2, violation: 3 } as const;
  const arrows = [...view.edges].filter((edge) => placed.has(edge.from) && placed.has(edge.to)).sort((a, b) => rank[a.status] - rank[b.status]);
  for (const edge of arrows) {
    const a = placed.get(edge.from)!, b = placed.get(edge.to)!;
    const ax = a.x + a.w / 2, bx = b.x + b.w / 2;
    let d: string;
    if (a.y === b.y) {
      // Same row: leave from the sides, arching over the cards between.
      const right = bx > ax;
      const sx = right ? a.x + a.w : a.x, tx = right ? b.x : b.x + b.w, sy = a.y + CARD_HEIGHT / 2;
      d = `M${sx},${sy} C${sx + (right ? 36 : -36)},${sy - 34} ${tx + (right ? -36 : 36)},${sy - 34} ${tx},${sy}`;
    } else {
      const down = b.y > a.y;
      const y1 = down ? a.y + CARD_HEIGHT : a.y, y2 = down ? b.y : b.y + CARD_HEIGHT, half = Math.abs(y2 - y1) / 2;
      d = `M${ax},${y1} C${ax},${y1 + (down ? half : -half)} ${bx},${y2 + (down ? -half : half)} ${bx},${y2}`;
    }
    const strong = edge.status === "violation" || edge.status === "undeclared";
    const color = edge.status === "violation" ? ORANGE : edge.status === "undeclared" ? VIOLET : SOFT;
    const stroke = strong ? 2.4 : Math.min(2.2, 1 + Math.log(1 + edge.symbols.length) * 0.35);
    const dash = edge.status === "undeclared" ? ` stroke-dasharray="6 5"` : edge.status === "planned" ? ` stroke-dasharray="2 4"` : "";
    out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${stroke.toFixed(2)}" opacity="${strong ? 0.95 : 0.38}"${dash} marker-end="url(#m-${edge.status})"/>`);
  }

  // Cards.
  for (const block of view.blocks) {
    const spot = placed.get(block.id);
    if (!spot) continue;
    const { x, y: top, w } = spot;
    const touched = view.changes.git && block.changes.files > 0;
    const planned = !block.files.length && view.hasModel;
    const severity = block.severity === "error" ? RED : block.severity === "warning" ? ORANGE : GREEN;
    const own = view.findings.filter((finding) => finding.blocks.includes(block.id) && finding.severity !== "info").length;
    out.push(`<g>`);
    out.push(`<title>${esc(block.name)}${block.description ? ": " + esc(block.description) : ""}</title>`);
    out.push(`<rect x="${x}" y="${top}" width="${w}" height="${CARD_HEIGHT}" rx="9" fill="#ffffff" stroke="${touched ? BLUE : "#c3ced6"}" stroke-width="${touched ? 2.4 : 1.2}"${planned ? ` stroke-dasharray="5 4"` : ""}/>`);
    if (block.hotspot) out.push(`<rect x="${x}" y="${top + 10}" width="4" height="${CARD_HEIGHT - 20}" rx="2" fill="${ORANGE}"/>`);
    out.push(`<circle cx="${x + 18}" cy="${top + 21}" r="5" fill="${severity}"/>`);
    out.push(`<text x="${x + 30}" y="${top + 26}" font-size="15" font-weight="700" fill="${INK}">${esc(fit(block.shortName, w - 44 - (touched ? 62 : 0), 15, 0.6))}</text>`);
    if (touched) out.push(`<text x="${x + w - 12}" y="${top + 25}" font-size="12" text-anchor="end" fill="${BLUE}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">+${block.changes.added} −${block.changes.removed}</text>`);
    out.push(`<text x="${x + 18}" y="${top + 46}" font-size="11.5" fill="${MUTED}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">${esc(fit(block.include.join(", "), w - 34, 11.5, 0.62))}</text>`);
    out.push(`<text x="${x + 18}" y="${top + 63}" font-size="11.5" fill="${MUTED}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">${planned ? "planned · no code yet" : esc(`${plural(block.files.length, "file", "files")} · ~${fmt(block.tokens)} tokens`)}</text>`);
    // The weight bar, and the marks.
    out.push(`<rect x="${x + 18}" y="${top + CARD_HEIGHT - 14}" width="${w - 36}" height="3" rx="1.5" fill="#dfe6eb"/>`);
    out.push(`<rect x="${x + 18}" y="${top + CARD_HEIGHT - 14}" width="${Math.max(4, Math.round((w - 36) * block.weight))}" height="3" rx="1.5" fill="${BLUE}" opacity="0.7"/>`);
    const marks: Array<[string, string]> = [];
    if (own) marks.push([plural(own, "finding", "findings"), block.severity === "error" ? RED : YELLOW]);
    if (block.hotspot) marks.push([`hotspot · ${block.churn} edits`, YELLOW]);
    let markX = x + w - 12;
    for (const [text, color] of marks.reverse()) {
      const size = Math.round(text.length * 6.2 + 12);
      out.push(`<rect x="${markX - size}" y="${top + 70}" width="${size}" height="18" rx="9" fill="${color}" opacity="0.14"/>`);
      out.push(`<text x="${markX - size / 2}" y="${top + 83}" font-size="10.5" text-anchor="middle" fill="${color}" font-weight="600">${esc(text)}</text>`);
      markX -= size + 6;
    }
    out.push(`</g>`);
  }

  // Footer: what the marks mean.
  const legend = height - MARGIN + 6;
  const items: Array<[string, string, string?]> = [[SOFT, "dependency"], [VIOLET, "not on the map yet", "6 5"], [ORANGE, "breaks a layer rule"]];
  let legendX = MARGIN;
  for (const [color, text, dash] of items) {
    out.push(`<line x1="${legendX}" y1="${legend - 4}" x2="${legendX + 26}" y2="${legend - 4}" stroke="${color}" stroke-width="2.2"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);
    out.push(`<text x="${legendX + 32}" y="${legend}" font-size="11.5" fill="${MUTED}">${esc(text)}</text>`);
    legendX += 32 + Math.round(text.length * 6.4) + 24;
  }
  out.push(`<text x="${width - MARGIN}" y="${legend}" font-size="11.5" text-anchor="end" fill="${SOFT}">bar and width: share of the code · orange edge: hotspot${view.changes.git && view.changes.files && Object.keys(view.changes.files).length ? " · blue outline: changed" : ""}</text>`);
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}
