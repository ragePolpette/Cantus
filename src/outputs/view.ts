import { FONT_FACES } from "./fonts.js";
import type { Analysis, CallSite, Diagnostic } from "../analysis/analyze.js";
import { type ApiChange, apiChanges } from "../state/impact.js";
import { buildContextPack, buildScopePack } from "../context/index.js";
import { UNASSIGNED, modelLayers, selectableLayers, type ArchModel, type DocRef } from "../model/index.js";
import { docSummaries } from "../map/docs.js";
import type { Finding } from "../analysis/rules.js";
import { type ProblemGroup, actionableItems, explainDiagnostics } from "../analysis/explain.js";
import { shortSignature } from "../analysis/catalog.js";
import { reach } from "../analysis/reach.js";
import type { Changes, FileChange } from "../state/changes.js";
import { blockForFile } from "../model/index.js";
import { readWorktree } from "../state/checkout.js";
import { i18nPayload } from "./i18n/index.js";

type EdgeStatus = "ok" | "undeclared" | "violation" | "planned";

export interface ViewData {
  name: string;
  /** Set when the project folder is a linked git worktree: the branch and folder tell this map from the main checkout's. */
  worktree?: { folder: string; branch: string };
  generatedAt: string;
  hasModel: boolean;
  /** The names of the map's `agent.checks`, to pick one when a task starts. */
  checks?: string[];
  /** Layers shown: those with blocks, or all of them when the map names its own. */
  layers: string[];
  /** Every layer of the map, top to bottom, without \`unassigned\`: what the editor works on. */
  allLayers: string[];
  /**
   * The lanes the map draws, top to bottom. With a saved map they are its layers. Without one most blocks have no layer
   * (\`unassigned\`): they sit in a lane per top-level folder (\`werkzeug/\`), the ones that use the others above.
   */
  lanes: string[];
  blocks: Array<{
    id: string;
    name: string;
    /** The name the card shows: the last part of an inferred name (\`Coolmagic\` for \`Werkzeug · Examples · Coolmagic\`), unless it would repeat. */
    shortName: string;
    /** The lane the block is drawn in (its layer, or its folder's lane without a saved map). */
    lane: string;
    /** How much of the code the block holds, 0 to 1: the square root of its share of the largest block, so a small block stays visible. */
    weight: number;
    layer: string;
    include: string[];
    description?: string;
    files: Array<{ path: string; tokens: number }>;
    tokens: number;
    contextTokens: number;
    churn: number;
    hotspot: boolean;
    publicFiles: string[];
    externalPackages: string[];
    /** HTTP calls the block makes (`GET /api/orders/{…}`): the backend boundary. */
    httpEndpoints: string[];
    dynamicHttpCalls: number;
    loadedBy: string[];
    scriptFiles: number;
    endpoints: string[];
    /** Files of the block that keep changing with files outside it (git history). */
    changesWith: Array<{ file: string; other: string; otherBlock?: string; commits: number; share: number }>;
    /** What the block offers, file by file: exports, script globals and C# endpoints, with how many outside places use each. */
    api: Array<{ file: string; name: string; kind: string; signature: string; doc?: string; complete: boolean; callers: number }>;
    /** Lines changed since the last commit in the files under the block's paths. */
    changes: { added: number; removed: number; files: number };
    /** Blocks that use this one, directly (1 step) or through others: what a change here can reach. */
    dependents: Array<{ id: string; distance: number }>;
    severity: "error" | "warning" | "ok";
    /** Analysis problems in the block's files that somebody can act on (not Cantus's own limits). */
    problems: number;
  }>;
  /** `declared`: the map lists this arrow (the editor can remove it). */
  edges: Array<{ from: string; to: string; symbols: string[]; status: EdgeStatus; declared: boolean }>;
  findings: Finding[];
  diagnostics: Diagnostic[];
  /** The analysis problems, grouped by what they are and who can act on them. */
  problems: ProblemGroup[];
  contracts: Record<string, string>;
  /**
   * Call sites that cross block boundaries: for each pair of blocks (caller, called) the ones the panel can show, sure ones first
   * (the panel lists `CALL_SITES_SHOWN` per pair). The full count is in `callSiteCounts`; the page does not carry the rest.
   */
  callSites: CallSite[];
  /** A live page does not carry the call sites and contracts (`callSites` and `contracts` are empty): it asks `/api/panel` for a block's own. */
  lazyPanel?: boolean;
  /** Per called block: every call site into it (`all`), and per calling block how many distinct places there are (`from`). */
  callSiteCounts: Record<string, { all: number; from: Record<string, number> }>;
  /** Links between files, for the view inside a block: imports, and calls to globals, components and endpoints. */
  fileLinks: Array<{ from: string; to: string; kind: "import" | "call"; symbols: string[] }>;
  groups: Array<{ id: string; name: string; description?: string; blocks: string[]; missing: string[]; contextTokens: number; callers: number; neighbors: string[] }>;
  /** The team's documents: assigned to blocks or groups, or common. */
  docs: Array<DocRef & { tokens: number; exists: boolean }>;
  /** What changed since the last commit, file by file; `git: false` when there is no repository. */
  changes: { git: boolean; added: number; removed: number; files: Record<string, FileChange & { block?: string; agents?: string[] }> };
  /** Minified or bundled files kept in their blocks but not analyzed. */
  minifiedFiles: string[];
  /** Exports added, changed or removed since the last commit, with the call sites in other blocks they affect. */
  apiChanges: Array<Omit<ApiChange, "callers"> & { callers: Array<Pick<CallSite, "file" | "line" | "block" | "match">>; callerCount: number }>;
  repoTokens: number;
}

/** `agentsOf`: the agents known to have written lines of a file (the edit ledger of a running map). */
/** The page of a live map: without the call sites and contracts, which are many megabytes on a big project and needed only for the block open in the panel. */
export function lightView(view: ViewData): ViewData {
  return { ...view, callSites: [], contracts: {}, lazyPanel: true };
}

/** What the panel of one block needs besides the page: the call sites into it and the contracts of the blocks it uses. */
export function panelDataOf(view: ViewData, blockId: string): { callSites: CallSite[]; contracts: Record<string, string> } {
  const contracts: Record<string, string> = {};
  for (const edge of view.edges) {
    if (edge.from !== blockId) continue;
    for (const file of view.blocks.find((block) => block.id === edge.to)?.publicFiles ?? []) if (view.contracts[file] !== undefined) contracts[file] = view.contracts[file];
  }
  return { callSites: view.callSites.filter((site) => site.targetBlock === blockId), contracts };
}

/** How many call sites of one pair of blocks the panel lists; the rest is only counted. */
export const CALL_SITES_SHOWN = 30;
const MATCH_RANK: Record<string, number> = { certain: 0, likely: 1, "by-name": 2 };

/**
 * The call sites between blocks as the page needs them. A big project has hundreds of thousands, and the page lists thirty per pair
 * of blocks: carrying all of them was more than half of a 15 MB page. Same answer as the panel gave from the full list: sites of one
 * place found for several files counted once, sure ones first, the order of the analysis among equals.
 */
function crossBlockCallSites(all: CallSite[]): Pick<ViewData, "callSites" | "callSiteCounts"> {
  const counts: ViewData["callSiteCounts"] = {};
  const pairs = new Map<string, { seen: Set<string>; sites: CallSite[] }>();
  for (const site of all) {
    if (!site.block || !site.targetBlock || site.block === site.targetBlock) continue;
    const into = (counts[site.targetBlock] ??= { all: 0, from: {} });
    into.all++;
    const pairKey = `${site.targetBlock}\u0000${site.block}`;
    let pair = pairs.get(pairKey);
    if (!pair) pairs.set(pairKey, (pair = { seen: new Set(), sites: [] }));
    const place = `${site.file}:${site.line}:${site.column}:${site.symbol}`;
    if (pair.seen.has(place)) continue;
    pair.seen.add(place);
    into.from[site.block] = (into.from[site.block] ?? 0) + 1;
    pair.sites.push(site);
  }
  const callSites: CallSite[] = [];
  for (const pair of pairs.values()) {
    const ranked = pair.sites.length > CALL_SITES_SHOWN ? [...pair.sites].sort((a, b) => (MATCH_RANK[a.match] ?? 0) - (MATCH_RANK[b.match] ?? 0)).slice(0, CALL_SITES_SHOWN) : pair.sites;
    callSites.push(...ranked);
  }
  return { callSites, callSiteCounts: counts };
}

export function buildViewData(analysis: Analysis, model: ArchModel | undefined, findings: Finding[], changes?: Changes, agentsOf?: (file: string) => string[]): ViewData {
  const changedFiles: ViewData["changes"]["files"] = {};
  for (const [file, change] of Object.entries(changes?.files ?? {})) {
    const owner = blockForFile(analysis.blocks.map((info) => info.block), file);
    const agents = agentsOf?.(file) ?? [];
    changedFiles[file] = { ...change, ...(owner ? { block: owner.id } : {}), ...(agents.length ? { agents } : {}) };
  }
  const blockChanges = (blockId: string) => {
    const mine = Object.values(changedFiles).filter((change) => change.block === blockId);
    return { added: mine.reduce((sum, change) => sum + change.added, 0), removed: mine.reduce((sum, change) => sum + change.removed, 0), files: mine.length };
  };
  const churns = analysis.blocks.map((info) => info.churn).filter((churn) => churn > 0).sort((a, b) => b - a);
  const hotspotThreshold = churns.length >= 3 ? churns[Math.floor(churns.length * 0.2)] : Infinity;

  const edgeStatus = (from: string, to: string): EdgeStatus => {
    const related = findings.filter((finding) => finding.from === from && finding.to === to);
    if (related.some((finding) => finding.kind === "undeclared-dependency")) return "undeclared";
    if (related.some((finding) => finding.kind === "layer-violation")) return "violation";
    return "ok";
  };

  const edges: ViewData["edges"] = analysis.dependencies.map((dep) => ({
    from: dep.from,
    to: dep.to,
    symbols: dep.symbols,
    status: edgeStatus(dep.from, dep.to),
    declared: !!model?.dependencies.some((declared) => declared.from === dep.from && declared.to === dep.to),
  }));
  for (const dep of model?.dependencies ?? []) {
    if (!edges.some((edge) => edge.from === dep.from && edge.to === dep.to)) {
      edges.push({ from: dep.from, to: dep.to, symbols: [], status: "planned", declared: true });
    }
  }

  // A map with its own layers shows all of them, empty ones too: they are the frame to fill.
  const usedLayers = new Set(analysis.blocks.map((info) => info.block.layer));
  const layers = [...modelLayers(model), UNASSIGNED].filter((layer) => usedLayers.has(layer) || (!!model?.layers && layer !== UNASSIGNED));
  const placed = placeInLanes(analysis, edges, layers, !!model);
  const order = orderWithinLayers(analysis.blocks.map((info) => ({ id: info.block.id, layer: placed.laneOf.get(info.block.id)! })), edges, placed.lanes);
  const biggest = Math.max(1, ...analysis.blocks.map((info) => info.tokens));
  const callerCounts = outsideCallers(analysis);
  const ordered = [...analysis.blocks].sort((a, b) => order.get(a.block.id)! - order.get(b.block.id)!);
  const groups = explainDiagnostics(analysis.diagnostics);
  const actionable = actionableItems(groups);
  const worktree = readWorktree(analysis.root);
  return {
    name: analysis.name,
    ...(worktree ? { worktree } : {}),
    generatedAt: new Date().toISOString(),
    hasModel: !!model,
    ...(model?.agent?.checks && Object.keys(model.agent.checks).length ? { checks: Object.keys(model.agent.checks) } : {}),
    layers,
    allLayers: selectableLayers(model),
    lanes: placed.lanes,
    blocks: ordered.map((info) => {
      const pack = buildContextPack(analysis, info.block.id, model, findings);
      const own = findings.filter((finding) => finding.blocks.includes(info.block.id));
      const ownFiles = new Set(info.files);
      const problems = actionable.filter((item) => item.file && ownFiles.has(item.file));
      return {
        id: info.block.id,
        name: info.block.name,
        shortName: placed.shortNames.get(info.block.id) ?? info.block.name,
        lane: placed.laneOf.get(info.block.id)!,
        weight: Math.sqrt(info.tokens / biggest),
        layer: info.block.layer,
        include: info.block.include,
        description: info.block.description,
        files: pack.files,
        tokens: info.tokens,
        contextTokens: pack.ownedTokens + pack.contractTokens + pack.docTokens,
        churn: info.churn,
        hotspot: info.churn >= hotspotThreshold,
        publicFiles: info.publicFiles,
        externalPackages: info.externalPackages,
        httpEndpoints: info.httpEndpoints,
        dynamicHttpCalls: info.dynamicHttpCalls,
        loadedBy: info.loadedBy,
        scriptFiles: info.scriptFiles.length,
        endpoints: info.endpoints,
        changesWith: pack.changesWith,
        api: blockApi(analysis, info.block.id, callerCounts),
        changes: blockChanges(info.block.id),
        dependents: reach(analysis.dependencies, info.block.id, "dependents").map((entry) => ({ id: entry.block, distance: entry.distance })),
        severity:
          own.some((f) => f.severity === "error") || problems.some((item) => item.level === "error")
            ? "error"
            : own.some((f) => f.severity === "warning") || problems.some((item) => item.level === "warning")
              ? "warning"
              : "ok",
        problems: problems.length,
      };
    }),
    edges,
    // `msg` is not listed when a finding is printed, so it is carried over here by name.
    findings: findings.map((finding) => ({ ...finding, ...(finding.msg ? { msg: finding.msg } : {}) })),
    diagnostics: analysis.diagnostics,
    problems: groups,
    contracts: analysis.contracts,
    ...crossBlockCallSites(analysis.callSites),
    fileLinks: fileLinks(analysis),
    groups: (model?.groups ?? []).map((group) => {
      const known = new Set(analysis.blocks.map((info) => info.block.id));
      const blocks = group.blocks.filter((id) => known.has(id));
      const pack = blocks.length ? buildScopePack(analysis, { ...group, blocks }, model, findings) : undefined;
      return {
        id: group.id,
        name: group.name,
        ...(group.description ? { description: group.description } : {}),
        blocks,
        missing: group.blocks.filter((id) => !known.has(id)),
        contextTokens: pack ? pack.ownedTokens + pack.contractTokens + pack.docTokens : 0,
        callers: pack?.callers.length ?? 0,
        neighbors: pack?.neighbors.map((neighbor) => neighbor.block.id) ?? [],
      };
    }),
    docs: docSummaries(analysis.root, model),
    changes: {
      git: changes?.git ?? false,
      added: Object.values(changedFiles).reduce((sum, change) => sum + change.added, 0),
      removed: Object.values(changedFiles).reduce((sum, change) => sum + change.removed, 0),
      files: changedFiles,
    },
    minifiedFiles: analysis.minifiedFiles,
    apiChanges: (changes ? apiChanges(analysis.root, analysis, changes) : []).map((change) => ({
      ...change,
      callers: change.callers.slice(0, VIEW_API_CALLERS).map(({ file, line, block, match }) => ({ file, line, ...(block ? { block } : {}), match })),
      callerCount: change.callers.length,
    })),
    repoTokens: Object.values(analysis.fileTokens).reduce((sum, tokens) => sum + tokens, 0),
  };
}

const API_SIGNATURE_LENGTH = 240;
const VIEW_API_CALLERS = 20;

/** File-to-file links: imports, plus calls that imports do not show (globals, components, HTTP endpoints). */
function fileLinks(analysis: Analysis): ViewData["fileLinks"] {
  const links = new Map<string, ViewData["fileLinks"][number]>();
  for (const entry of analysis.fileImports) links.set(`${entry.from}\u0000${entry.to}`, { from: entry.from, to: entry.to, kind: "import", symbols: entry.symbols });
  for (const site of analysis.callSites) {
    if (site.file === site.targetFile) continue;
    const key = `${site.file}\u0000${site.targetFile}`;
    const link = links.get(key) ?? { from: site.file, to: site.targetFile, kind: "call" as const, symbols: [] };
    if (!link.symbols.includes(site.symbol)) link.symbols.push(site.symbol);
    links.set(key, link);
  }
  return [...links.values()];
}

/** How many call sites from outside the target's block use each `file` + `symbol`. */
function outsideCallers(analysis: Analysis): Map<string, number> {
  const counts = new Map<string, number>();
  for (const site of analysis.callSites) {
    if (site.block !== undefined && site.block === site.targetBlock) continue;
    const key = `${site.targetFile}\u0000${site.symbol}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function blockApi(analysis: Analysis, blockId: string, counts: Map<string, number>): ViewData["blocks"][number]["api"] {
  const callers = (file: string, symbol: string) => counts.get(`${file}\u0000${symbol}`) ?? 0;
  const exports = analysis.catalog
    .filter((entry) => entry.block === blockId)
    .map((entry) => ({
      file: entry.file,
      name: entry.name,
      kind: entry.kind,
      signature: shortSignature(entry, API_SIGNATURE_LENGTH),
      ...(entry.doc ? { doc: entry.doc.split("\n")[0].slice(0, 200) } : {}),
      complete: entry.complete,
      callers: callers(entry.file, entry.name),
    }));
  const endpoints = analysis.endpoints
    .filter((endpoint) => analysis.blocks.find((info) => info.block.id === blockId)?.files.includes(endpoint.file))
    .map((endpoint) => ({ file: endpoint.file, name: endpoint.handler, kind: "endpoint", signature: `${endpoint.method ?? "ANY"} ${endpoint.route}`, complete: true, callers: callers(endpoint.file, endpoint.handler) }));
  return [...exports, ...endpoints].sort((a, b) => a.file.localeCompare(b.file) || b.callers - a.callers || a.name.localeCompare(b.name));
}

/** First folders that say nothing about what is inside (`src/werkzeug/debug` is about `werkzeug`). */
const GENERIC_ROOTS = new Set(["src", "lib", "app", "source", "sources", "packages", "pkg", "internal", "cmd"]);

/** The lane of a block that has no layer, named by the top-level folder it lives in: `werkzeug/`, `examples/`. */
function folderLane(include: string[], projectName: string): string {
  const parts = (include[0] ?? ".").split("/").filter((part) => part && part !== ".");
  if (parts.length === 0) return `${projectName}/`;
  let index = 0;
  while (index < parts.length - 1 && GENERIC_ROOTS.has(parts[index])) index++;
  return `${parts[index]}/`;
}

/**
 * Where each block is drawn. With a saved map: in its layer. Without one, blocks come from folders and most
 * have no layer, so a single lane of them says nothing: each goes in the lane of its top-level folder, the
 * lanes that use others above the ones they use, and the blocks whose layer could be told stay in theirs.
 * Names inside a folder lane lose the part the lane already says (`Coolmagic` under `examples/`).
 */
function placeInLanes(analysis: Analysis, edges: Array<{ from: string; to: string }>, layers: string[], hasModel: boolean): { lanes: string[]; laneOf: Map<string, string>; shortNames: Map<string, string> } {
  const laneOf = new Map<string, string>();
  const shortNames = new Map<string, string>();
  const blocks = analysis.blocks.map((info) => info.block);
  const folders = new Set<string>();
  for (const block of blocks) {
    const lane = !hasModel && block.layer === UNASSIGNED ? folderLane(block.include, analysis.name) : block.layer;
    laneOf.set(block.id, lane);
    if (lane !== block.layer) folders.add(lane);
  }
  if (folders.size === 0) return { lanes: layers, laneOf, shortNames };

  // Depth of a lane: the longest chain of lanes that use it, so the lanes nobody uses come first.
  const names = [...folders];
  const depth = new Map(names.map((name) => [name, 0]));
  for (let pass = 0; pass < names.length; pass++) {
    let moved = false;
    for (const edge of edges) {
      const from = laneOf.get(edge.from), to = laneOf.get(edge.to);
      if (!from || !to || from === to || !folders.has(from) || !folders.has(to)) continue;
      if (depth.get(to)! < depth.get(from)! + 1 && depth.get(from)! + 1 < names.length) { depth.set(to, depth.get(from)! + 1); moved = true; }
    }
    if (!moved) break;
  }
  // A lane with no arrow to or from another lane (docs/, a lone script) says nothing about the structure: it goes last.
  const linked = new Set<string>();
  for (const edge of edges) {
    const from = laneOf.get(edge.from), to = laneOf.get(edge.to);
    if (from && to && from !== to) { linked.add(from); linked.add(to); }
  }
  names.sort((a, b) => Number(!linked.has(a)) - Number(!linked.has(b)) || depth.get(a)! - depth.get(b)! || a.localeCompare(b));
  const lanes = [...layers.filter((layer) => layer !== UNASSIGNED), ...names];

  // The short name: the last part of the inferred name, or the last two if another block of the lane ends the same.
  for (const block of blocks) {
    if (!folders.has(laneOf.get(block.id)!)) continue;
    const parts = block.name.split(" · ");
    const tail = (count: number) => parts.slice(-count).join(" · ");
    const sameLane = blocks.filter((other) => other.id !== block.id && laneOf.get(other.id) === laneOf.get(block.id));
    let count = 1;
    while (count < parts.length && sameLane.some((other) => other.name.split(" · ").slice(-count).join(" · ") === tail(count))) count++;
    shortNames.set(block.id, tail(count));
  }
  return { lanes, laneOf, shortNames };
}

/** Barycenter sweeps: place each block near the blocks it connects to, to reduce edge crossings. */
function orderWithinLayers(blocks: Array<{ id: string; layer: string }>, edges: Array<{ from: string; to: string }>, layers: string[]): Map<string, number> {
  const lanes = layers.map((layer) => blocks.filter((block) => block.layer === layer).map((block) => block.id).sort());
  const neighbors = new Map<string, string[]>();
  for (const edge of edges) {
    neighbors.set(edge.from, [...(neighbors.get(edge.from) ?? []), edge.to]);
    neighbors.set(edge.to, [...(neighbors.get(edge.to) ?? []), edge.from]);
  }
  const position = new Map<string, number>();
  const place = () => lanes.forEach((lane) => lane.forEach((id, index) => position.set(id, (index + 0.5) / lane.length)));
  place();
  const sweep = (laneIndexes: number[]) => {
    for (const index of laneIndexes) {
      const score = (id: string) => {
        const linked = (neighbors.get(id) ?? []).filter((other) => !lanes[index].includes(other));
        return linked.length ? linked.reduce((sum, other) => sum + position.get(other)!, 0) / linked.length : position.get(id)!;
      };
      lanes[index].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
      place();
    }
  };
  const indexes = lanes.map((_, index) => index);
  for (let pass = 0; pass < 3; pass++) {
    sweep(indexes.slice(1));
    sweep(indexes.slice(0, -1).reverse());
  }
  const result = new Map<string, number>();
  lanes.flat().forEach((id, index) => result.set(id, index));
  return result;
}

export interface RenderViewOptions {
  /** Served by `cantus serve`/`cantus mcp`: live updates and editing, authorized by this token. */
  live?: { token: string; /** A Claude Code session is attached: requests can go to it. */ session?: boolean; /** The project folder on this machine, for "Open in VS Code". */ root?: string };
}

export function renderViewHtml(data: ViewData, options: RenderViewOptions = {}): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const live = JSON.stringify(options.live ?? null).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cantus · ${escapeHtml(data.name)}${data.worktree ? ` · ${escapeHtml(data.worktree.branch)}` : ""}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 28'%3E%3Cg fill='none' stroke='%236b7a99' stroke-width='2'%3E%3Crect x='2' y='2' width='9' height='7'/%3E%3Crect x='17' y='2' width='9' height='7'/%3E%3Crect x='9.5' y='19' width='9' height='7'/%3E%3Cpath d='M6.5 9 V14 H14 V19 M21.5 9 V14 H14'/%3E%3C/g%3E%3C/svg%3E">
<script id="theme-boot">try { var theme = localStorage.getItem("cantus-theme"); if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme); } catch (error) { /* private mode */ }</script>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="brand"><svg class="logo" viewBox="0 0 28 28" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2" width="9" height="7"/><rect x="17" y="2" width="9" height="7"/><rect x="9.5" y="19" width="9" height="7"/><path d="M6.5 9 V14 H14 V19 M21.5 9 V14 H14"/></g></svg><strong>Cantus</strong><span>/ ${escapeHtml(data.name)}</span>${data.worktree ? `<em class="checkout" title="${escapeHtml(data.worktree.folder)}">${escapeHtml(data.worktree.branch)}</em>` : ""}</div>
  <nav id="tabs"></nav>
  <div id="chips"></div>
  <div id="settings-wrap"><button id="settings-btn" type="button" aria-expanded="false" aria-controls="settings">⚙</button><div id="settings" hidden></div></div>
</header>
<aside id="sessions" aria-label="Worktrees" hidden><div class="sx-head"></div><div class="sx-scroll"><div id="worktree-column"></div><details id="sessions-more"><summary></summary><div id="worktree-rules"></div></details></div></aside>
<main>
  <section id="canvas"><svg id="edges"></svg><div id="lanes"></div><div id="zoom" hidden></div><div id="changesview" hidden></div><div id="statsview" hidden></div><div id="fileview" hidden></div></section>
  <aside id="panel"></aside>
</main>
<footer id="bottom"><div id="facts"></div><span class="meta" id="meta"></span><span class="grow"></span><div id="legend-wrap"><button id="legend-btn" type="button" aria-expanded="false" aria-controls="legend">?</button><div id="legend" hidden></div></div></footer>
<script type="application/json" id="data">${json}</script>
<script type="application/json" id="live">${live}</script>
<script type="application/json" id="i18n">${i18nPayload()}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

const STYLE = `
${FONT_FACES}
/* Caratteri incorporati (fonts.ts); i colori sono variabili: lo scuro è la base, il chiaro segue il sistema (o data-theme="light"). */
:root { --sans:"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif; --mono:"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace; }
:root { color-scheme: dark;
  --bg:#08141c; --panel:#0c1b26; --lane:#0b1923; --card:#0f2230; --line:#1f3b4d; --text:#d4e6ee;
  --muted:#8fabbc; --blue:#4cc9e6; --green:#2abd60; --orange:#e99b17; --red:#e64d4d; --line-2:#1f3b4d;
  --chip:#1c2933; --ink-1:#cad8e2; --red-bg:#481f1f; --red-pale:#fbcdcd; --green-bg:#16311f; --green-soft:#8beaad;
  --field-line:#304758; --blue-strong:#2592a8; --on-blue:#ddf7fc; --amber-bg:#382a12; --amber-soft:#f3ce56; --ink-subtle:#6d95b1;
  --line-soft:#183040; --ink-muted:#acc3d3; --lane-head:#0c1b26; --row-hover:#12293a; --amber-fg:#f0ba2f; --green-fg:#51d782;
  --red-fg:#f17878; --violet-bg:#1f1c32; --violet-soft:#c6b9f9; --blue-bg:#1c3c42; --blue-soft:#98e8f8; --btn:#253846;
  --white:#ffffff; --card-alt:#0d1e2b; --line-hover:#39566a; --add-bg:#13251a; --del-bg:#291515; --ink-faint:#7f95a5;
  --red-soft:#f8a9a9; --violet:#aa91f4; --indigo:#a9ebf8; --api-bg:#0f161b; --api-line:#3b3317; --amber-pale:#f7e390;
  --chip-blue-2:#1f353a; --blue-strong-2:#26b3cf; --violet-line:#4f418b; --violet-pale:#ded8fc; --chip-2:#21313c; --orange-bg:#392412;
  --orange-soft:#f6ba7b; --chip-blue:#17282b; --blue-pale:#c2f1fb; --ink-soft:#c2d2de; --red-strong:#582020; --green-strong:#17502e;
  --green-pale:#bef4d1; --blue-bg-2:#21525c; --amber-strong:#57390e; --agent:#3ccb97; --agent-soft:#74e1b6; --agent-pale:#abefd0;
  --on-accent:#04121a;
}
@media (prefers-color-scheme: light) {
:root:not([data-theme="dark"]) { color-scheme: light;
  --bg:#eef3f6; --panel:#e2eaef; --lane:#e9eff3; --card:#fbfdfe; --line:#a9bcc8; --text:#0b2230;
  --muted:#46606f; --blue:#0a6f8f; --green:#34a65e; --orange:#a2711f; --red:#841f1f; --line-2:#b5c6d1;
  --chip:#edf0f3; --ink-1:#323c48; --red-bg:#efe6e6; --red-pale:#611010; --green-bg:#eff5f1; --green-soft:#1e6c3a;
  --field-line:#d3d9e0; --blue-strong:#0a6f8f; --on-blue:#ffffff; --amber-bg:#f5f2ed; --amber-soft:#7a5a0a; --ink-subtle:#56677b;
  --line-soft:#c4d2db; --ink-muted:#3f4b5a; --lane-head:#dbe5ec; --row-hover:#e4edf2; --amber-fg:#80590a; --green-fg:#17713b;
  --red-fg:#a3231b; --violet-bg:#eeeef2; --violet-soft:#231266; --blue-bg:#e8eef1; --blue-soft:#13576f; --btn:#e4e8ec;
  --white:#ffffff; --card-alt:#f2f6f8; --line-hover:#bac4cf; --add-bg:#f3f7f5; --del-bg:#f6f2f2; --ink-faint:#566a78;
  --red-soft:#691313; --violet:#2c1670; --indigo:#135369; --api-bg:#f6f7f9; --api-line:#f3f1eb; --amber-pale:#725f13;
  --chip-blue-2:#ebeff0; --blue-strong-2:#075a74; --violet-line:#7c70b1; --violet-pale:#1d105c; --chip-2:#e9ecf0; --orange-bg:#f5f0ed;
  --orange-soft:#784714; --chip-blue:#f1f4f5; --blue-pale:#114e64; --ink-soft:#3a4553; --red-strong:#b3261e; --green-strong:#1a7a43;
  --green-pale:#ffffff; --blue-bg-2:#d7e3e7; --amber-strong:#f3ece3; --agent:#318a6a; --agent-soft:#237253; --agent-pale:#1c6342;
  --on-accent:#ffffff;
}
}
:root[data-theme="light"] { color-scheme: light;
  --bg:#eef3f6; --panel:#e2eaef; --lane:#e9eff3; --card:#fbfdfe; --line:#a9bcc8; --text:#0b2230;
  --muted:#46606f; --blue:#0a6f8f; --green:#34a65e; --orange:#a2711f; --red:#841f1f; --line-2:#b5c6d1;
  --chip:#edf0f3; --ink-1:#323c48; --red-bg:#efe6e6; --red-pale:#611010; --green-bg:#eff5f1; --green-soft:#1e6c3a;
  --field-line:#d3d9e0; --blue-strong:#0a6f8f; --on-blue:#ffffff; --amber-bg:#f5f2ed; --amber-soft:#7a5a0a; --ink-subtle:#56677b;
  --line-soft:#c4d2db; --ink-muted:#3f4b5a; --lane-head:#dbe5ec; --row-hover:#e4edf2; --amber-fg:#80590a; --green-fg:#17713b;
  --red-fg:#a3231b; --violet-bg:#eeeef2; --violet-soft:#231266; --blue-bg:#e8eef1; --blue-soft:#13576f; --btn:#e4e8ec;
  --white:#ffffff; --card-alt:#f2f6f8; --line-hover:#bac4cf; --add-bg:#f3f7f5; --del-bg:#f6f2f2; --ink-faint:#566a78;
  --red-soft:#691313; --violet:#2c1670; --indigo:#135369; --api-bg:#f6f7f9; --api-line:#f3f1eb; --amber-pale:#725f13;
  --chip-blue-2:#ebeff0; --blue-strong-2:#075a74; --violet-line:#7c70b1; --violet-pale:#1d105c; --chip-2:#e9ecf0; --orange-bg:#f5f0ed;
  --orange-soft:#784714; --chip-blue:#f1f4f5; --blue-pale:#114e64; --ink-soft:#3a4553; --red-strong:#b3261e; --green-strong:#1a7a43;
  --green-pale:#ffffff; --blue-bg-2:#d7e3e7; --amber-strong:#f3ece3; --agent:#318a6a; --agent-soft:#237253; --agent-pale:#1c6342;
  --on-accent:#ffffff;
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 var(--sans); display:flex; flex-direction:column; height:100vh; }
header { display:flex; align-items:center; gap:20px; padding:10px 20px; background:var(--panel); border-bottom:1px solid var(--line-2); }
.brand strong { font-size:18px; } .brand span { color:var(--muted); margin-left:6px; font-size:15px; }
#chips { display:flex; flex-wrap:wrap; gap:8px; flex:1; justify-content:center; }
.chip { padding:3px 12px; border-radius:999px; background:var(--chip); font-size:13px; color:var(--ink-1); white-space:nowrap; }
.chip.error { background:var(--red-bg); color:var(--red-pale); } .chip.live { background:var(--green-bg); color:var(--green-soft); }
#panel input, #panel textarea, #panel select { display:block; width:100%; margin:6px 0; padding:6px 8px; background:var(--bg); border:1px solid var(--field-line); border-radius:6px; color:var(--text); font:inherit; }
#panel button { margin-top:6px; padding:6px 12px; background:var(--blue-strong); color:var(--on-blue); border:0; border-radius:6px; cursor:pointer; font:inherit; } .chip.warning { background:var(--amber-bg); color:var(--amber-soft); }
.meta { color:var(--ink-subtle); font-size:12px; }
#lang, #theme { background:var(--bg); border:1px solid var(--field-line); border-radius:6px; color:var(--text); font:inherit; font-size:12px; padding:3px 6px; cursor:pointer; }
main { flex:1; display:flex; min-height:0; }
#canvas { position:relative; flex:1; overflow:auto; padding:16px; }
#zoom { position:relative; }
#tabs { display:flex; gap:4px; }
#tabs button { padding:5px 14px; background:transparent; color:var(--muted); border:0; border-bottom:2px solid transparent; cursor:pointer; font:inherit; font-size:14px; }
#tabs button:hover { color:var(--text); } #tabs button.on { color:var(--text); border-bottom-color:var(--blue); }
#tabs .count { margin-left:6px; padding:0 7px; border-radius:999px; background:var(--chip); color:var(--ink-1); font-size:11px; }
#statsview h2.title { margin:0 0 4px; font-size:18px; } #statsview .sub { color:var(--muted); font-size:12px; margin-bottom:12px; }
#statsview .periods { display:flex; gap:6px; margin:0 0 14px; } #statsview .periods button { padding:3px 12px; background:var(--chip); color:var(--ink-1); border:1px solid var(--line); border-radius:999px; cursor:pointer; font:inherit; font-size:12px; } #statsview .periods button.on { background:var(--blue); border-color:var(--blue); color:var(--on-accent); }
#statsview .group { background:var(--lane); border:1px solid var(--line-soft); border-radius:10px; margin-bottom:12px; overflow:hidden; }
#statsview .group h3 { margin:0; padding:8px 14px; font-size:12px; letter-spacing:1px; text-transform:uppercase; color:var(--ink-muted); background:var(--lane-head); }
#statsview ul.advice { margin:0; padding:6px 14px 8px 30px; font-size:13px; line-height:1.5; } #statsview ul.advice li { margin:5px 0; }
#statsview table { width:100%; border-collapse:collapse; font:12.5px/1.4 var(--mono); } #statsview th { text-align:right; font-weight:500; color:var(--ink-muted); padding:6px 10px; white-space:nowrap; } #statsview td { text-align:right; padding:5px 10px; border-top:1px solid var(--card); white-space:nowrap; }
#statsview .tscroll { overflow-x:auto; } #statsview th:first-child, #statsview td:first-child { text-align:left; padding-left:14px; white-space:normal; min-width:150px; overflow-wrap:anywhere; } #statsview td.link { cursor:pointer; color:var(--text); } #statsview td.link:hover { text-decoration:underline; }
#statsview td.warn { color:var(--amber-fg); }
#statsview .srow { padding:6px 14px; border-top:1px solid var(--card); font:12.5px/1.4 var(--mono); display:flex; gap:10px; } #statsview .srow:first-of-type { border-top:0; } #statsview .srow .path { flex:1; min-width:0; word-break:break-all; } #statsview .srow .n { color:var(--ink-muted); }
#changesview h2.title { margin:0 0 4px; font-size:18px; } #changesview .sub { color:var(--muted); font-size:12px; margin-bottom:12px; }
#changesview .group { background:var(--lane); border:1px solid var(--line-soft); border-radius:10px; margin-bottom:12px; overflow:hidden; }
#changesview .group h3 { margin:0; padding:8px 14px; font-size:12px; letter-spacing:1px; text-transform:uppercase; color:var(--ink-muted); background:var(--lane-head); display:flex; gap:10px; align-items:center; }
#changesview .group h3 .badge { text-transform:none; letter-spacing:0; }
#changesview .frow { display:flex; align-items:center; gap:10px; padding:6px 14px; border-top:1px solid var(--card); font:12.5px/1.4 var(--mono); }
#changesview .frow.open { cursor:pointer; } #changesview .frow.open:hover { background:var(--row-hover); }
#changesview .frow .path { flex:1; min-width:0; word-break:break-all; } #changesview .frow .path b { color:var(--text); font-weight:600; } #changesview .frow .path i { color:var(--ink-subtle); font-style:normal; }
#changesview .st { width:18px; flex:none; text-align:center; font-weight:700; } #changesview .st.modified { color:var(--amber-fg); } #changesview .st.added { color:var(--green-fg); } #changesview .st.deleted { color:var(--red-fg); }
#changesview .tag { font:11px var(--sans); padding:1px 8px; border-radius:999px; background:var(--violet-bg); color:var(--violet-soft); white-space:nowrap; } #changesview .tag.warn { background:var(--amber-bg); color:var(--amber-soft); }
#fileview .fv-split { display:flex; gap:14px; align-items:flex-start; } #fileview .fv-main { flex:1; min-width:0; }
#fileview .fv-list { width:250px; flex:none; position:sticky; top:0; max-height:calc(100vh - 150px); overflow:auto; background:var(--lane); border:1px solid var(--line-soft); border-radius:10px; }
#fileview .fv-group { padding:6px 10px; font-size:10.5px; letter-spacing:1px; text-transform:uppercase; color:var(--ink-muted); background:var(--lane-head); position:sticky; top:0; }
#fileview .fv-item { display:flex; align-items:center; gap:8px; padding:4px 10px; cursor:pointer; font:12px/1.4 var(--mono); border-top:1px solid var(--card); }
#fileview .fv-item:hover { background:var(--row-hover); } #fileview .fv-item.on { background:var(--blue-bg); box-shadow:inset 3px 0 0 var(--blue); }
#fileview .fv-item .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#fileview .st { width:14px; flex:none; text-align:center; font-weight:700; } #fileview .st.modified { color:var(--amber-fg); } #fileview .st.added { color:var(--green-fg); } #fileview .st.deleted { color:var(--red-fg); }
#fileview .fv-nav { display:inline-flex; align-items:center; gap:6px; margin-left:auto; } #fileview label.marks { font-size:12px; color:var(--muted); display:inline-flex; align-items:center; gap:4px; }
.sbs { display:flex; } .sbs-col { flex:1 1 0; min-width:0; overflow-x:auto; } .sbs-col + .sbs-col { border-left:1px solid var(--line-2); } .sbs-in { min-width:max-content; }
.code .ln.empty { background:var(--bg); }
.code .no { position:relative; } .code .acts { display:none; position:absolute; left:0; top:0; bottom:0; width:100%; background:var(--card); align-items:center; justify-content:center; gap:3px; }
.code .ln:hover .acts { display:flex; } .code .act { cursor:pointer; color:var(--blue-soft); padding:0 3px; border-radius:4px; } .code .act:hover { background:var(--btn); color:var(--white); }
#fileview a.btn { padding:5px 12px; background:var(--btn); color:var(--ink-1); border-radius:6px; cursor:pointer; text-decoration:none; font-size:14px; }
.ask-box { background:var(--card-alt); border:1px solid var(--line-hover); border-radius:8px; padding:10px 12px; margin:0 0 10px; }
.ask-box .ask-title { font-weight:600; margin-bottom:6px; font-family:var(--mono); font-size:12.5px; }
.ask-box pre { margin:0 0 8px; padding:6px 8px; background:var(--bg); border-radius:6px; max-height:160px; overflow:auto; font:12px/1.5 var(--mono); color:var(--ink-1); }
.ask-box textarea { display:block; width:100%; margin:6px 0; padding:6px 8px; background:var(--bg); border:1px solid var(--field-line); border-radius:6px; color:var(--text); font:inherit; }
.req-line { margin:6px 0; font-size:13px; color:var(--ink-1); } .req-line .lvl { font-weight:600; } .req-line.ok .lvl { color:var(--green-soft); } .req-line.warn .lvl { color:var(--amber-soft); } .req-line a { color:var(--blue-soft); cursor:pointer; }
.ask-box button { margin-right:8px; } #fileview .ask-box button.primary { background:var(--blue-strong); color:var(--on-blue); }
body.review #panel, body.panel-closed #panel, body.panel-closed #panel-close { display:none; }
main { position:relative; }
.panel-x { position:absolute; top:10px; right:20px; z-index:3; width:28px; height:28px; padding:0; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--muted); font:20px/1 var(--sans); cursor:pointer; }
.panel-x:hover { color:var(--text); border-color:var(--line-hover); }
body.review #panel-close { display:none; }
#panel > .kicker, #panel h1 { padding-right:36px; }
.sbs-col .no, .sbs-col .mark { position:sticky; background:var(--bg); z-index:1; } .sbs-col .no { left:0; } .sbs-col .mark { left:48px; }
.sbs-col .ln.add .no, .sbs-col .ln.add .mark { background:var(--add-bg); } .sbs-col .ln.del .no, .sbs-col .ln.del .mark { background:var(--del-bg); }
.sbs-col .ln.empty .no, .sbs-col .ln.empty .mark { background:var(--bg); } .sbs-col .ln.add.agent .no, .sbs-col .ln.add.agent .mark { background:var(--violet-bg); }
#fileview .zoom-head { display:flex; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
#fileview .zoom-head h2 { margin:0; font-size:15px; font-family:var(--mono); word-break:break-all; }
#fileview button { padding:5px 12px; background:var(--btn); color:var(--ink-1); border:0; border-radius:6px; cursor:pointer; font:inherit; }
#fileview button.on { background:var(--blue-strong); color:var(--on-blue); }
.code { background:var(--bg); border:1px solid var(--line-2); border-radius:8px; font:12px/1.55 var(--mono); overflow:auto; }
.code .ln { display:flex; white-space:pre; } .code .ln:hover { background:var(--row-hover); }
.code .no { width:48px; flex:none; text-align:right; padding-right:10px; color:var(--ink-faint); user-select:none; }
.code .mark { width:16px; flex:none; text-align:center; user-select:none; }
.code .txt { padding-right:16px; color:var(--ink-1); }
.code .ln.add { background:var(--add-bg); } .code .ln.add .mark { color:var(--green-fg); }
.code .ln.del { background:var(--del-bg); } .code .ln.del .mark { color:var(--red-fg); } .code .ln.del .txt { color:var(--red-soft); }
.code .gap { color:var(--ink-subtle); padding:2px 0 2px 64px; cursor:pointer; background:var(--lane-head); font-size:11.5px; border-top:1px solid var(--card); border-bottom:1px solid var(--card); }
.code .gap.removed { color:var(--red-fg); }
.code .ln.add.agent { background:var(--violet-bg); box-shadow:inset 3px 0 0 var(--violet); } .code .ln.add.agent .mark { color:var(--violet-soft); }
.agent-note { font-size:12px; color:var(--violet-soft); } .agent-note i { display:inline-block; width:10px; height:10px; border-radius:2px; background:var(--violet-bg); box-shadow:inset 3px 0 0 var(--violet); margin-right:5px; vertical-align:-1px; }
a.change-link { cursor:pointer; text-decoration:none; }
#zoom .zoom-head { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
#zoom .zoom-head h2 { margin:0; font-size:18px; } #zoom .zoom-head .sub { color:var(--muted); font-size:12px; }
#zoom button { padding:5px 12px; background:var(--btn); color:var(--ink-1); border:0; border-radius:6px; cursor:pointer; font:inherit; }
#zoom .file-rows { display:flex; flex-direction:column; gap:40px; background:var(--lane); border:1px solid var(--line-soft); border-radius:10px; padding:20px 16px; }
#zoom .file-row-cards { display:flex; flex-wrap:wrap; justify-content:center; gap:24px 40px; }
.file-card { width:230px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; cursor:pointer; position:relative; z-index:2; user-select:none; }
.file-card:hover { border-color:var(--line-hover); } .file-card.selected { border:2px solid var(--blue); background:var(--blue-bg); } .file-card.faded { opacity:.45; }
.file-card h3 { margin:0; font-size:13.5px; font-family:var(--mono); word-break:break-all; }
.file-card .sub { color:var(--muted); font-size:11px; font-family:var(--mono); word-break:break-all; }
.file-card .badges { margin-top:6px; display:flex; flex-wrap:wrap; gap:5px; }
.file-card .file-open { float:right; margin:-2px -4px 0 6px; padding:2px 8px; font-size:11px; }
.file-card .out { font-size:10.5px; color:var(--violet); margin-top:5px; }
#edges { position:absolute; left:0; top:0; pointer-events:none; overflow:visible; z-index:1; }
#lanes { position:relative; display:flex; flex-direction:column; gap:12px; }
.lane { background:var(--lane); border:1px solid var(--line-soft); border-radius:10px; padding:28px 16px 16px; position:relative; }
.lane h2 { position:absolute; top:8px; left:16px; margin:0; font-size:11px; letter-spacing:1.5px; color:var(--ink-subtle); text-transform:uppercase; }
.lane .cards { display:flex; flex-wrap:wrap; justify-content:center; gap:36px 64px; }
.card.planned { border-style:dashed; background:var(--card-alt); } .card.planned .sub.plan { color:var(--indigo); }
.lane-tools { position:absolute; top:4px; right:10px; display:flex; gap:4px; }
.lane-tools button, .tiny { padding:1px 7px; font-size:11px; border-radius:5px; background:var(--chip); color:var(--ink-1); border:1px solid var(--line); cursor:pointer; }
#lanes input { padding:5px 8px; background:var(--bg); border:1px solid var(--field-line); border-radius:6px; color:var(--text); font:inherit; font-size:13px; }
.lane-tools input { font-size:11px; padding:1px 6px; width:140px; }
.add-layer input { width:260px; } .add-layer { align-items:center; }
.lane.drop { outline:2px dashed var(--blue); outline-offset:-4px; }
.card.ghost { border-style:dashed; color:var(--muted); display:flex; align-items:center; justify-content:center; min-height:70px; cursor:pointer; background:transparent; }
.card.ghost:hover { color:var(--blue-soft); border-color:var(--blue); }
.card form, .add-layer { display:flex; flex-direction:column; gap:6px; }
.add-layer { flex-direction:row; justify-content:center; padding:10px; }
.card .handle { position:absolute; right:-9px; top:50%; margin-top:-9px; width:18px; height:18px; border-radius:50%; background:var(--blue); color:var(--bg); font-size:12px; line-height:18px; text-align:center; cursor:crosshair; }
body.editing .card { position:relative; }
body.editing .card:not(.ghost) { cursor:grab; }
.api-changes { margin:0 0 10px; background:var(--api-bg); border:1px solid var(--api-line); border-radius:8px; padding:6px 12px; }
.api-changes code { color:var(--amber-pale); }
.chip.edit { cursor:pointer; background:var(--chip-blue-2); color:var(--blue-soft); } .chip.edit.on { background:var(--blue-strong-2); color:var(--white); }
.empty-map { text-align:center; padding:60px 20px; color:var(--muted); }
.draft-box { background:var(--lane); border:1px solid var(--line-soft); border-radius:10px; padding:10px 16px; margin-bottom:12px; }
.draft-box summary { cursor:pointer; color:var(--blue-soft); font-size:13px; }
.draft-box textarea { width:100%; min-height:90px; margin:8px 0; padding:8px; background:var(--bg); border:1px solid var(--field-line); border-radius:6px; color:var(--text); font:inherit; resize:vertical; }
.empty-map .draft-box { max-width:640px; margin:18px auto; text-align:left; }
.draft-bar { display:flex; align-items:center; gap:10px; background:var(--violet-bg); border:1px solid var(--violet-line); border-radius:10px; padding:10px 16px; margin-bottom:12px; color:var(--violet-pale); }
.draft-bar .grow { flex:1; }
.card.new { border-color:var(--violet); border-style:dashed; background:var(--violet-bg); } .card .sub.uses { color:var(--violet-soft); }
.card { width:220px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; cursor:pointer; position:relative; z-index:2; user-select:none; transition:border-color .15s, opacity .15s; }
.card:hover { border-color:var(--line-hover); }
.card.selected { border:2px solid var(--blue); background:var(--blue-bg); box-shadow:0 0 18px color-mix(in srgb, var(--blue) 35%, transparent); }
.card.faded { opacity:.45; }
.card.reached { border-color:var(--orange); }
.card .weight { height:3px; background:var(--line-soft); border-radius:2px; margin:0 0 8px; overflow:hidden; } .card .weight i { display:block; height:100%; background:var(--blue-soft); border-radius:2px; opacity:.7; }
.card.hot { border-left:3px solid var(--orange); }
.card h3 { margin:0 0 6px; font-size:15px; display:flex; align-items:center; gap:8px; }
.card .sub { color:var(--muted); font-size:12px; font-family:var(--mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.card .badges { margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; }
.badge { font-size:11px; padding:1px 9px; border-radius:999px; background:var(--chip-2); color:var(--ink-1); }
.badge.hot { background:var(--orange-bg); color:var(--orange-soft); }
.badge.chg, .section .badge.chg { background:var(--chip-blue); color:var(--ink-muted); display:inline-flex; gap:5px; font-size:11px; padding:1px 8px; border-radius:999px; }
.plus { color:var(--green-fg); } .minus { color:var(--red-fg); } .chip.changes { background:var(--chip-blue); } .badge.doc { background:var(--blue-bg); color:var(--blue-pale); } .badge.err { background:var(--red-bg); color:var(--red-pale); } .badge.warn { background:var(--amber-bg); color:var(--amber-soft); }
.dot { width:9px; height:9px; border-radius:50%; display:inline-block; background:var(--green); flex:none; }
.dot.warning { background:var(--orange); } .dot.error { background:var(--red); }
#panel { width:440px; flex:none; background:var(--panel); border-left:1px solid var(--line-2); overflow:auto; padding:20px; }
#panel .kicker { font-size:11px; letter-spacing:1.5px; color:var(--muted); text-transform:uppercase; font-weight:700; }
#panel h1 { margin:6px 0 2px; font-size:20px; }
#panel .desc { color:var(--blue-soft); margin:4px 0 14px; }
.section { background:var(--card); border-radius:8px; padding:12px 14px; margin-bottom:12px; }
.section h4 { margin:0 0 8px; font-size:13px; display:flex; justify-content:space-between; }
.section h4 span { color:var(--ink-subtle); font-weight:400; }
.section ul { margin:0; padding-left:0; list-style:none; }
.section li { font-size:12px; color:var(--ink-soft); padding:2px 0; font-family:var(--mono); word-break:break-all; }
.section li.text { font-family:inherit; }
.section li b { color:var(--violet-soft); font-weight:500; }
.finding.error { color:var(--red-soft); } .finding.warning { color:var(--amber-soft); } .finding.info { color:var(--ink-muted); }
.vfinding { margin:12px 0 0; padding-top:10px; border-top:1px solid var(--line, rgba(128,128,128,.25)); } .vfinding .lvl { font-weight:700; text-transform:uppercase; font-size:11px; letter-spacing:.04em; }
.bar { height:10px; background:var(--line-2); border-radius:5px; overflow:hidden; margin:6px 0; } .bar div { height:100%; background:var(--blue); border-radius:5px; }
pre { background:var(--bg); border:1px solid var(--line-2); border-radius:6px; padding:10px; font-size:11.5px; overflow:auto; max-height:320px; color:var(--ink-1); margin:6px 0 0; }
code.cmd { display:block; background:var(--bg); border:1px solid var(--line-2); border-radius:6px; padding:8px 10px; font-size:12px; color:var(--blue-soft); margin-top:6px; word-break:break-all; }
details summary { cursor:pointer; color:var(--ink-1); font-size:12px; }
footer { display:flex; align-items:center; gap:16px; padding:6px 20px; color:var(--ink-muted); font-size:12px; border-top:1px solid var(--line-2); position:relative; }
#facts { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
#facts .chip { font-size:11px; padding:1px 9px; }
footer .grow { flex:1; }
#legend-wrap, #settings-wrap { position:relative; }
#legend-btn, #settings-btn { background:transparent; border:1px solid var(--field-line); border-radius:999px; color:var(--muted); cursor:pointer; font:inherit; font-size:12px; width:24px; height:24px; padding:0; }
#settings-btn { font-size:15px; width:30px; height:30px; }
#legend-btn:hover, #settings-btn:hover, #legend-btn[aria-expanded="true"], #settings-btn[aria-expanded="true"] { color:var(--text); border-color:var(--blue); }
#legend { position:absolute; right:0; bottom:calc(100% + 8px); display:flex; flex-direction:column; gap:8px; background:var(--panel); border:1px solid var(--line-2); border-radius:6px; padding:10px 14px; white-space:nowrap; z-index:40; box-shadow:0 6px 20px rgba(0,0,0,.18); }
#legend[hidden], #settings[hidden] { display:none; }
#legend span { display:flex; align-items:center; gap:7px; }
#settings { position:absolute; right:0; top:calc(100% + 8px); display:flex; flex-direction:column; gap:10px; background:var(--panel); border:1px solid var(--line-2); border-radius:6px; padding:12px 14px; min-width:220px; z-index:40; box-shadow:0 6px 20px rgba(0,0,0,.18); }
#settings label.field { display:flex; justify-content:space-between; align-items:center; gap:12px; font-size:12px; color:var(--muted); }
#settings .chip.edit { text-align:center; border:0; font:inherit; font-size:13px; }
#signals-btn { cursor:pointer; display:inline-flex; gap:6px; align-items:center; font:inherit; font-size:13px; }
#sessions-btn, #signals-btn { border:1px solid var(--line-2); }
.signal .where { margin-left:8px; }
#signals-btn .n { border-radius:999px; padding:0 6px; font-size:11px; }
#signals-btn .n.warning { background:var(--amber-bg); color:var(--amber-fg); }
#signals-btn .n.error { background:var(--red-bg); color:var(--red-pale); }
#chips button.chip.edit { border:0; font:inherit; font-size:13px; }
.line { width:26px; height:0; border-top:2px solid var(--muted); display:inline-block; }
.line.undeclared { border-top:2px dashed var(--violet); } .line.violation { border-top:2px solid var(--orange); } .line.planned { border-top:2px dotted var(--ink-subtle); }
.empty { color:var(--ink-subtle); font-size:12px; }
.diag { font-size:12px; padding:3px 0; border-bottom:1px solid var(--line-2); font-family:var(--mono); word-break:break-word; }
.diag .where { color:var(--blue-soft); } .diag.error .lvl { color:var(--red-soft); } .diag.warning .lvl { color:var(--amber-soft); } .diag.info .lvl { color:var(--ink-muted); }
.diag pre { max-height:160px; }
.file-row, .file-api summary { display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:12px; padding:3px 0; }
.file-row .path, .file-api summary .path { font-family:var(--mono); color:var(--ink-soft); word-break:break-all; }
.file-api summary .path { color:var(--ink-1); }
.section .tag { font-size:10.5px; padding:0 7px; border-radius:999px; background:var(--chip-2); color:var(--ink-muted); }
.section .tag.used { background:var(--green-bg); color:var(--green-soft); } .section .tag.warn { background:var(--amber-bg); color:var(--amber-soft); }
.file-api { border-bottom:1px solid var(--line-2); padding:2px 0; }
.api-entry { padding:5px 0 5px 12px; border-top:1px solid var(--line-soft); }
.api-head { display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:12.5px; }
.api-head b { color:var(--text); font-weight:600; font-family:var(--mono); }
.kind { font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:var(--blue-soft); }
.kind.endpoint { color:var(--orange-soft); } .kind.class, .kind.interface, .kind.type { color:var(--violet-soft); }
code.signature { display:block; margin-top:3px; font:11.5px/1.45 var(--mono); color:var(--ink-soft); white-space:pre-wrap; word-break:break-word; }
#panel textarea { resize:vertical; min-height:70px; }
#panel button.secondary { background:var(--btn); color:var(--ink-1); } #panel button.danger { background:var(--red-strong); color:var(--red-pale); } #panel button.ok { background:var(--green-strong); color:var(--green-pale); }
#panel button:disabled { opacity:.5; cursor:default; }
.buttons { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.chip.task { cursor:pointer; background:var(--blue-bg-2); color:var(--blue-pale); } .chip.task.waiting { background:var(--amber-strong); color:var(--amber-pale); } .chip.stale { cursor:pointer; }
.card[data-task="running"] { box-shadow:0 0 0 2px var(--blue), 0 0 16px color-mix(in srgb, var(--blue) 45%, transparent); }
.card[data-task="waiting"] { box-shadow:0 0 0 2px var(--orange), 0 0 16px color-mix(in srgb, var(--orange) 50%, transparent); animation:pulse 1.4s ease-in-out infinite; }
.card[data-agent] { box-shadow:0 0 0 2px var(--agent), 0 0 16px color-mix(in srgb, var(--agent) 40%, transparent); animation:agent-glow 2.2s ease-in-out infinite; }
@keyframes agent-glow { 50% { box-shadow:0 0 0 2px var(--agent), 0 0 4px color-mix(in srgb, var(--agent) 15%, transparent); } }
.robot { position:absolute; top:-20px; right:10px; width:36px; height:36px; z-index:3; pointer-events:auto; animation:robot-bob 1.1s ease-in-out infinite; }
.robot svg { display:block; width:100%; height:100%; overflow:visible; }
.robot .eye { transform-box:fill-box; transform-origin:center; animation:robot-blink 3.2s infinite; }
.robot .bulb { animation:robot-ping 1s ease-in-out infinite; }
@keyframes robot-bob { 50% { transform:translateY(-3px); } }
@keyframes robot-blink { 0%, 92%, 100% { transform:scaleY(1); } 96% { transform:scaleY(.1); } }
@keyframes robot-ping { 50% { opacity:.25; } }
@media (prefers-reduced-motion: reduce) { .card[data-agent], .robot, .robot .eye, .robot .bulb { animation:none; } }
@keyframes pulse { 50% { box-shadow:0 0 0 2px var(--orange), 0 0 4px color-mix(in srgb, var(--orange) 20%, transparent); } }
.approval { border-left:3px solid var(--orange); }
.approval pre.plan { white-space:pre-wrap; max-height:420px; font-family:inherit; font-size:13px; }
body.panel-wide #panel { width:min(980px, 62vw); }
pre.diff .add { color:var(--green-soft); } pre.diff .del { color:var(--red-soft); } pre.diff .hunk { color:var(--blue-soft); }
pre.diff { max-height:480px; }
#panel textarea.doc-editor { min-height:420px; font:12.5px/1.5 var(--mono); }
.doc-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.doc-row a { color:var(--blue-soft); } .doc-row .tag { font-size:11px; padding:0 7px; border-radius:999px; background:var(--chip-2); color:var(--ink-1); }
#panel .doc-row button { margin-top:0; padding:2px 8px; font-size:12px; }
#panel label.check { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-1); } #panel label.check input { display:inline; width:auto; margin:0; }

/* Stile Disegno tecnico: linee sottili, angoli vivi, griglia a punti, etichette in monospazio, un solo accento. */
body { font-size:13.5px; }
.brand { display:flex; align-items:center; gap:10px; }
.brand .logo { width:26px; height:26px; color:var(--blue); flex:none; }
.brand strong { font-family:var(--mono); font-weight:600; font-size:17px; letter-spacing:3px; text-transform:uppercase; }
.brand span { font-family:var(--mono); font-size:12px; letter-spacing:.5px; margin-left:0; }
.brand .checkout { font-style:normal; font-family:var(--mono); font-size:11px; color:var(--orange); border:1px solid var(--orange); border-radius:10px; padding:1px 8px; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
header { border-bottom-color:var(--line); }
#sessions { position:fixed; left:0; bottom:0; width:min(460px, 94vw); z-index:30; background:var(--panel); border-right:1px solid var(--line); box-shadow:8px 0 24px rgba(0,0,0,.18); display:flex; flex-direction:column; }
#sessions[hidden] { display:none; }
#sessions .sx-head { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid var(--line); }
#sessions .sx-head h3 { margin:0; flex:1; font:600 12px var(--mono); letter-spacing:.1em; text-transform:uppercase; }
#sessions .sx-scroll { overflow:auto; padding:0 14px 16px; flex:1; }
#sessions .cmd { font:11.5px/1.5 var(--mono); white-space:pre-wrap; word-break:break-all; background:var(--bg); border:1px solid var(--line-soft); border-radius:4px; padding:4px 8px; margin:4px 0; }
#sessions input, #sessions select { display:block; width:100%; margin:4px 0 8px; padding:5px 8px; background:var(--bg); border:1px solid var(--field-line); border-radius:6px; color:var(--text); font:inherit; }
#sessions label.field { display:block; font-size:12px; color:var(--muted); }
#sessions-btn { cursor:pointer; display:inline-flex; gap:6px; align-items:center; }
#sessions-btn.on { border-color:var(--blue); }
#sessions-btn .n { border-radius:999px; padding:0 6px; font-size:11px; background:var(--chip-blue-2); }
#sessions-btn .n.wait { background:var(--amber-bg); color:var(--amber-fg); }
details.briefing { margin:14px 0 0; border-top:1px solid var(--line); padding-top:8px; }
details.briefing > summary { cursor:pointer; font:600 12px var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding:4px 0; }
#sessions-more { margin-top:14px; border-top:1px solid var(--line); padding-top:8px; }
#sessions-more > summary { cursor:pointer; font:12px var(--mono); color:var(--muted); padding:4px 0; }
.wtcol { padding-top:12px; }
.wtc { border:1px solid var(--line); border-left-width:3px; border-radius:4px; background:var(--bg); padding:8px 10px; margin:0 0 8px; font-size:12.5px; }
.wtc.here { border-color:var(--blue); }
.wtc-head { display:flex; align-items:center; gap:7px; font-family:var(--mono); }
.wtc-name { flex:none; max-width:55%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; color:var(--text); text-decoration:none; }
a.wtc-name { color:var(--blue-soft); }
.wtc-state { margin-left:auto; color:var(--muted); font-size:11.5px; white-space:nowrap; }
.wtc .dot { width:8px; height:8px; border-radius:50%; flex:none; background:var(--muted); box-sizing:border-box; }
.wtc.working .dot { background:var(--green); }
.wtc.opened .dot { background:transparent; border:1.5px solid var(--green); }
.wtc.waiting .dot { background:var(--amber-fg); }
.wtc.review .dot { background:var(--blue); }
.wtc.merged .dot, .wtc.off .dot { background:transparent; border:1.5px solid var(--muted); }
.wtc.working { border-left-color:var(--green); }
.wtc.opened { border-left-color:var(--green); }
.wtc.waiting { border-left-color:var(--amber-fg); }
.wtc.review { border-left-color:var(--blue); }
.wtc.merged, .wtc.off { border-left-color:var(--line); }
.wtc.merged .wtc-name, .wtc.off .wtc-name { color:var(--muted); }
.wtc-group { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:12px 0 4px; }
.wtc-line { color:var(--muted); font-size:12px; margin-top:4px; word-break:break-word; }
.wtc-asks { margin:0 0 10px; }
.wtc-queue { margin-top:8px; padding-top:6px; border-top:1px dashed var(--line); }
.wtc-q-title { font:600 11px var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.wtc-req { margin-top:4px; }
.wtc > button { margin-top:8px; margin-right:6px; }

.chip { border-radius:2px; font-family:var(--mono); font-size:11.5px; border:1px solid var(--line); }
.chip.live, .chip.error, .chip.warning, .chip.edit, .chip.task { border-color:transparent; }
#canvas { background-image:radial-gradient(color-mix(in srgb, var(--blue) 16%, transparent) 1px, transparent 1.2px); background-size:20px 20px; }
.lane { background:transparent; border:1px dashed var(--line); border-radius:2px; }
.lane h2 { font-family:var(--mono); font-weight:500; font-size:11px; letter-spacing:2px; color:var(--muted); background:var(--bg); padding:0 8px; left:12px; top:-8px; }
.card, .file-card { border-radius:2px; }
.card h3 { font-family:var(--mono); font-size:14px; font-weight:600; }
.card .sub { font-size:11px; }
.card.selected, .file-card.selected { border:1px solid var(--blue); box-shadow:0 0 0 1px var(--blue), 4px 4px 0 color-mix(in srgb, var(--blue) 25%, transparent); }
.card:hover, .file-card:hover { border-color:var(--blue); }
.badge { border-radius:2px; font-family:var(--mono); font-size:10.5px; }
.section { border-radius:2px; border:1px solid var(--line); }
.section h4 { font-family:var(--mono); font-size:12px; letter-spacing:.5px; text-transform:uppercase; }
#panel { border-left-color:var(--line); }
#panel h1 { font-family:var(--mono); font-size:21px; font-weight:600; }
#panel .kicker { font-family:var(--mono); font-weight:500; letter-spacing:2px; }
#panel .desc { color:var(--blue); }
#panel button, #zoom button, #fileview button, #fileview a.btn { border-radius:2px; font-family:var(--mono); font-size:12px; }
#panel button { background:var(--blue); color:var(--on-accent); }
#panel button.secondary, #zoom button, #fileview button, #fileview a.btn { background:transparent; border:1px solid var(--line); color:var(--text); }
#panel button.danger { background:var(--red-strong); color:var(--red-pale); } #panel button.ok { background:var(--green-strong); color:var(--green-pale); }
#fileview button.on { background:var(--blue); border-color:var(--blue); color:var(--on-accent); }
#fileview .ask-box button.primary { background:var(--blue); color:var(--on-accent); }
#tabs button { font-family:var(--mono); font-size:12.5px; letter-spacing:1px; text-transform:uppercase; }
#changesview h2.title, #statsview h2.title { font-family:var(--mono); font-size:20px; }
#changesview .group, #statsview .group, #fileview .fv-list, #zoom .file-rows { border-radius:2px; }
#changesview .group h3, #statsview .group h3, #fileview .fv-group { font-family:var(--mono); font-weight:500; }
footer { font-family:var(--mono); font-size:11px; }
.code, pre, code.cmd { border-radius:2px; }
@media (prefers-reduced-motion: reduce) { .card[data-agent], .card[data-task="waiting"] { animation:none; } }
`;
const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById("data").textContent);
  var live = JSON.parse(document.getElementById("live").textContent);

  // ---- Language: the English text in the code is the key; a language only needs its own lines.
  var I18N = JSON.parse(document.getElementById("i18n").textContent);
  var LANG_KEY = "cantus-lang";
  function pickLanguage() {
    var codes = [I18N.source.code].concat(I18N.languages.map(function (l) { return l.code; }));
    try { var saved = localStorage.getItem(LANG_KEY); if (codes.indexOf(saved) >= 0) return saved; } catch (error) { /* private mode */ }
    var wanted = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
    for (var i = 0; i < wanted.length; i++) {
      var base = String(wanted[i]).toLowerCase().split("-")[0];
      if (codes.indexOf(base) >= 0) return base;
    }
    return I18N.source.code;
  }
  var lang = pickLanguage();
  var messages = I18N.messages[lang] || {};
  var pluralRules = new Intl.PluralRules(lang);
  document.documentElement.lang = lang;
  function interpolate(text, params) {
    return params ? text.replace(/\\{(\\w+)\\}/g, function (all, name) { return name in params ? params[name] : all; }) : text;
  }
  /** A message: the language's line for this English text, or the English text itself. */
  function tr(text, params) {
    var line = messages[text];
    return interpolate(typeof line === "string" ? line : text, params);
  }
  /** A message with a count: "{n}" is the number; the forms follow the plural rules of the language. */
  function trn(n, one, other, params) {
    var all = { n: n };
    if (params) Object.keys(params).forEach(function (k) { all[k] = params[k]; });
    var line = messages[one + "|" + other];
    if (line && typeof line === "object") return interpolate(line[pluralRules.select(n)] || line.other, all);
    if (typeof line === "string") return interpolate(line, all);
    return interpolate(n === 1 ? one : other, all);
  }
  function tok(n) { return tr("~{tokens} tok", { tokens: fmt(n) }); }
  /** A message of the analysis (see src/analysis/message.ts): its template in this language, its values said the same way. */
  function say(value) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "object") return String(value);
    if (Array.isArray(value)) return value.map(say).join(", ");
    if (value.items) return value.items.map(say).join(value.sep);
    var params = {};
    Object.keys(value.p || {}).forEach(function (k) { params[k] = say(value.p[k]); });
    var line = messages[value.t];
    if (line && typeof line === "object") line = line[pluralRules.select(Number(params.n))] || line.other;
    // A value that is nothing (undefined) is not in the JSON: its slot is empty.
    return (typeof line === "string" ? line : value.t).replace(/\\{(\\w+)\\}/g, function (all, name) { return name in params ? params[name] : ""; });
  }
  function findingText(f) { return f.msg ? say(f.msg) : f.message; }
  function severityWord(severity) { return severity === "error" ? tr("error") : severity === "warning" ? tr("warning") : severity === "info" ? tr("info") : severity; }
  (function () {
    var select = document.createElement("select");
    select.id = "lang";
    select.title = tr("Language");
    [I18N.source].concat(I18N.languages).forEach(function (l) {
      var option = document.createElement("option");
      option.value = l.code;
      option.textContent = l.name;
      if (l.code === lang) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener("change", function () {
      try { localStorage.setItem(LANG_KEY, select.value); } catch (error) { /* private mode */ }
      location.reload();
    });
    // Theme: follow the system, or force light or dark; the choice stays in this browser (the head script applies it before the first paint).
    var themeSelect = document.createElement("select");
    themeSelect.id = "theme";
    themeSelect.title = tr("Theme");
    var root = document.documentElement;
    var currentTheme = root.getAttribute("data-theme") || "system";
    [["system", tr("System")], ["light", tr("Light")], ["dark", tr("Dark")]].forEach(function (entry) {
      var option = document.createElement("option");
      option.value = entry[0];
      option.textContent = entry[1];
      if (entry[0] === currentTheme) option.selected = true;
      themeSelect.appendChild(option);
    });
    themeSelect.addEventListener("change", function () {
      if (themeSelect.value === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", themeSelect.value);
      try { if (themeSelect.value === "system") localStorage.removeItem("cantus-theme"); else localStorage.setItem("cantus-theme", themeSelect.value); } catch (error) { /* private mode */ }
    });
    var settings = document.getElementById("settings");
    var settingsBtn = document.getElementById("settings-btn");
    settingsBtn.title = tr("Settings"); settingsBtn.setAttribute("aria-label", tr("Settings"));
    [[tr("Theme"), themeSelect], [tr("Language"), select]].forEach(function (entry) {
      var label = document.createElement("label");
      label.className = "field";
      label.appendChild(document.createTextNode(entry[0]));
      label.appendChild(entry[1]);
      settings.appendChild(label);
    });
    var legend = document.getElementById("legend");
    var legendBtn = document.getElementById("legend-btn");
    legendBtn.title = tr("What the colors and the lines mean"); legendBtn.setAttribute("aria-label", legendBtn.title);
    // One small menu at a time: the settings in the header, the legend in the bottom bar; a click elsewhere or Esc closes it.
    function popover(button, box) {
      button.addEventListener("click", function (event) {
        event.stopPropagation();
        var open = box.hidden;
        closePopovers();
        box.hidden = !open; button.setAttribute("aria-expanded", String(open));
      });
      box.addEventListener("click", function (event) { event.stopPropagation(); });
    }
    popover(settingsBtn, settings);
    popover(legendBtn, legend);
    document.addEventListener("click", closePopovers);
    [["dot ok", tr("aligned with the model")], ["dot warning", tr("rule warning")], ["dot error", tr("drift / error")], ["line undeclared", tr("dependency not on the map yet")], ["line violation", tr("layer violation")], ["line planned", tr("declared, not in code yet")]].forEach(function (entry) {
      var item = document.createElement("span");
      var mark = document.createElement("i");
      mark.className = entry[0];
      item.appendChild(mark);
      item.appendChild(document.createTextNode(entry[1]));
      legend.appendChild(item);
    });
  })();
  var byId = {};
  data.blocks.forEach(function (b) { byId[b.id] = b; });
  var selected = null;
  /** Blocks a change in this block reaches through others (not the direct neighbors, which are never faded). */
  function reachedFrom(id) {
    var found = {};
    if (id && byId[id]) byId[id].dependents.forEach(function (d) { if (d.distance > 1) found[d.id] = true; });
    return found;
  }
  var multi = [];
  var view = "none";

  function setHash(value) {
    history.replaceState(null, "", value ? "#" + value : location.pathname + location.search);
  }
  // Requests the page is waiting for: a reload now would throw their answer away (a button just clicked, a merge).
  var inFlight = 0;
  function api(method, url, body) {
    inFlight++;
    var done = function () { inFlight--; };
    return fetch(url, {
      method: method,
      headers: { "content-type": "application/json", "x-cantus-token": live ? live.token : "" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().then(function (json) { if (!res.ok) throw new Error(json.error || res.statusText); return json; });
    }).then(function (json) { done(); return json; }, function (error) { done(); throw error; });
  }

  /** Contracts of the neighbors and call sites into one block, asked for when its panel opens (the page does not carry them). */
  var panelDataCache = {};
  function panelDataOf(blockId) {
    if (!panelDataCache[blockId]) {
      panelDataCache[blockId] = api("GET", "/api/panel?block=" + encodeURIComponent(blockId));
      panelDataCache[blockId].catch(function () { delete panelDataCache[blockId]; });
    }
    return panelDataCache[blockId];
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  /** "+12 −3", for a block, a file or the whole project. */
  function changeBadge(added, removed) {
    var badge = el("span", "badge chg");
    badge.appendChild(el("span", "plus", "+" + added));
    badge.appendChild(el("span", "minus", "−" + removed));
    return badge;
  }
  function fileChangeTag(file) {
    var change = data.changes.files[file];
    if (!change) return null;
    if (change.binary) return el("span", "badge chg", change.status === "added" ? tr("new · binary") : tr("binary changed"));
    var badge = changeBadge(change.added, change.removed);
    if (change.status === "added") badge.insertBefore(el("span", null, tr("new") + " "), badge.firstChild);
    if (!live) return badge;
    var link = el("a", "change-link");
    link.title = tr("See what changed in this file since the last commit");
    link.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); openFileView(file); });
    link.appendChild(badge);
    return link;
  }
  function closePopovers() {
    [["settings-btn", "settings"], ["legend-btn", "legend"]].forEach(function (pair) {
      var box = document.getElementById(pair[1]);
      if (box && !box.hidden) { box.hidden = true; document.getElementById(pair[0]).setAttribute("aria-expanded", "false"); }
    });
  }
  function popoverOpen() { return !document.getElementById("settings").hidden || !document.getElementById("legend").hidden; }
  function fmt(n) { return n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }

  var minified = {};
  (data.minifiedFiles || []).forEach(function (file) { minified[file] = true; });
  var errors = data.findings.filter(function (f) { return f.severity === "error"; }).length;
  var warnings = data.findings.filter(function (f) { return f.severity === "warning"; }).length;
  var chips = document.getElementById("chips");
  // The bottom bar: what the map counts, and how much code it stands for.
  var facts = document.getElementById("facts");
  function fact(text, cls) { var f = el("span", "fact" + (cls ? " " + cls : ""), text); facts.appendChild(f); return f; }
  fact(trn(data.blocks.length, "{n} block", "{n} blocks"));
  fact(trn(data.edges.filter(function (e) { return e.status !== "planned"; }).length, "{n} dependency", "{n} dependencies"));
  var changedCount = Object.keys(data.changes.files).length;
  var breaking = data.apiChanges.filter(function (c) { return c.kind !== "added" && c.callerCount > 0; });
  if (data.changes.git && changedCount) {
    var since = fact("", "changes");
    since.appendChild(document.createTextNode(trn(changedCount, "{n} file changed", "{n} files changed") + " "));
    since.appendChild(el("span", "plus", "+" + data.changes.added));
    since.appendChild(document.createTextNode(" "));
    since.appendChild(el("span", "minus", "−" + data.changes.removed));
    since.title = tr("Since the last commit: staged, unstaged and new files. A commit resets it.");
  }
  var problemItems = 0, problemNotes = 0, problemErrors = false;
  data.problems.forEach(function (g) {
    if (g.who === "cantus") problemNotes += g.items.length;
    else { problemItems += g.items.length; if (g.severity === "error") problemErrors = true; }
  });
  // ---- Signals: what to look at (drift, warnings, API changes, analysis problems) in one button; the list opens in the panel.
  var signals = [];
  if (errors) signals.push({ level: "error", count: errors, text: tr("{n} drift/error", { n: errors }), findings: "error" });
  if (warnings) signals.push({ level: "warning", count: warnings, text: trn(warnings, "{n} warning", "{n} warnings"), findings: "warning" });
  if (!data.hasModel && data.blocks.length) signals.push({ level: "warning", count: 1, text: tr("inferred: run cantus analyze --write") });
  if (breaking.length) {
    var sites = breaking.reduce(function (sum, c) { return sum + c.callerCount; }, 0);
    signals.push({ level: "warning", count: breaking.length, id: "api", text: trn(breaking.length, "{n} API change", "{n} API changes") + " · " + trn(sites, "{n} call site to check", "{n} call sites to check"), why: tr("Exports changed or removed since the last commit that code in other blocks uses"), open: showApiChanges });
  }
  if (problemItems || problemNotes) signals.push({ level: problemItems ? (problemErrors ? "error" : "warning") : "note", count: problemItems, id: "problems", text: problemItems ? trn(problemItems, "{n} analysis problem to look at", "{n} analysis problems to look at") : trn(problemNotes, "{n} analysis note", "{n} analysis notes"), why: tr("What Cantus could not read or check while analyzing the project, and what to do about it"), open: showProblems });
  if (!data.changes.git) signals.push({ level: "note", count: 0, text: tr("changes need git"), why: tr("Lines changed since the last commit are shown in git repositories only.") });
  var signalCount = signals.reduce(function (sum, x) { return sum + x.count; }, 0);
  var signalLevel = signals.some(function (x) { return x.level === "error"; }) ? "error" : signalCount ? "warning" : "";
  var signalsBtn = el("button", "chip signals"); signalsBtn.id = "signals-btn"; signalsBtn.type = "button";
  signalsBtn.appendChild(document.createTextNode(tr("Signals")));
  if (signalCount) signalsBtn.appendChild(el("span", "n " + signalLevel, String(signalCount)));
  signalsBtn.title = signals.length ? signals.map(function (x) { return x.text; }).join(" · ") : tr("Nothing to look at");
  signalsBtn.addEventListener("click", function () { if (view === "signals" && panelOpen) closePanel(); else showSignals(); });
  chips.appendChild(signalsBtn);
  function showSignals() {
    leaveZoom();
    view = "signals"; openTask = null; openPanel();
    setHash("signals");
    var panel = document.getElementById("panel");
    panel.innerHTML = "";
    panel.appendChild(el("div", "kicker", tr("Signals")));
    panel.appendChild(el("h1", null, tr("What to look at")));
    if (!signals.length) panel.appendChild(el("p", "empty", tr("Nothing to look at: the code follows the map.")));
    signals.forEach(function (x) {
      var box = section(x.text);
      box.className += " signal " + x.level;
      if (x.id) box.id = "signal-" + x.id;
      if (x.why) box.appendChild(el("div", "empty", x.why));
      if (x.open) {
        var open = el("a", "change-link", tr("Open the list"));
        open.href = "#";
        open.addEventListener("click", function (event) { event.preventDefault(); x.open(); });
        box.appendChild(open);
      }
      if (x.findings) {
        var shown = data.findings.filter(function (f) { return f.severity === x.findings; });
        shown.slice(0, 30).forEach(function (f) {
          var row = el("div", "diag " + f.severity);
          row.appendChild(el("span", null, findingText(f)));
          (f.blocks || []).forEach(function (id) {
            if (!byId[id]) return;
            var link = el("a", "where", byId[id].name);
            link.href = "#";
            link.addEventListener("click", function (event) { event.preventDefault(); select(id); });
            row.appendChild(link);
          });
          box.appendChild(row);
        });
        if (shown.length > 30) box.appendChild(el("div", "empty", tr("… {n} more", { n: shown.length - 30 })));
      }
      panel.appendChild(box);
    });
  }
  // Editing the map by hand (live only): layers, blocks and arrows. Stays on across reloads.
  var editing = false;
  try { editing = !!live && sessionStorage.getItem("cantus-edit") === "1"; } catch (error) { editing = false; }
  function setEditing(on) {
    try { if (on) sessionStorage.setItem("cantus-edit", "1"); else sessionStorage.removeItem("cantus-edit"); } catch (error) { /* private mode */ }
    location.reload();
  }
  if (live) {
    // Turned on from the settings; while it is on, the header says so and turns it off.
    var editChip = el("button", "chip edit" + (editing ? " on" : ""), editing ? tr("Done editing") : tr("Edit the map"));
    editChip.type = "button"; editChip.id = "edit-map";
    editChip.title = editing ? tr("Back to the map") : tr("Add layers and blocks, draw arrows: the plan for the agents");
    editChip.addEventListener("click", function () { setEditing(!editing); });
    if (editing) chips.appendChild(editChip); else document.getElementById("settings").appendChild(editChip);
  }
  if (editing) document.body.classList.add("editing");
  function mapEdit(method, url, body, hash) {
    return api(method, url, body).then(function (r) {
      if (hash !== undefined) location.hash = typeof hash === "function" ? hash(r) : hash;
      location.reload();
      return r;
    });
  }
  function laneLayers() { return data.allLayers.slice(); }
  function saveLayers(layers, renames) { return mapEdit("PUT", "/api/map/layers", { layers: layers, renames: renames || {} }); }

  // ---- Tabs: the map of blocks, and the files changed since the last commit.
  var changesOpen = false;
  var statsOpen = false;
  var fromChanges = false;
  var tabMap = el("button", null, tr("Map")), tabChanges = el("button", null, tr("Changes")), tabStats = el("button", null, tr("Statistics"));
  if (changedCount) tabChanges.appendChild(el("span", "count", String(changedCount)));
  tabMap.addEventListener("click", function () { clearSelection(); });
  tabChanges.addEventListener("click", function () { showChanges(); });
  tabStats.addEventListener("click", function () { showStats(); });
  if (data.changes.git || live) document.getElementById("tabs").appendChild(tabMap);
  if (data.changes.git) document.getElementById("tabs").appendChild(tabChanges);
  if (live) document.getElementById("tabs").appendChild(tabStats);
  // The side panel starts closed and opens when you pick something (a block, a group, a file, a task); the cross or Esc closes it.
  var panelOpen = false;
  function applyPanel() { document.body.classList.toggle("panel-closed", !panelOpen); }
  function openPanel() { panelOpen = true; applyPanel(); }
  // A panel that only reads (a task, a document, the API changes, the analysis problems) is left when it is closed: back on the map,
  // so a reload does not open it again.
  var PANEL_ONLY = { "new-worktree": true, task: true, doc: true, api: true, problems: true, signals: true };
  function closePanel() {
    if (PANEL_ONLY[view]) clearSelection();
    panelOpen = false; applyPanel(); drawEdges(); // the canvas gets wider: draw the arrows again
  }
  var panelClose = el("button", "panel-x", "×");
  panelClose.id = "panel-close"; panelClose.type = "button";
  panelClose.title = tr("Close panel"); panelClose.setAttribute("aria-label", tr("Close panel"));
  panelClose.addEventListener("click", closePanel);
  document.querySelector("main").appendChild(panelClose);
  applyPanel();
  function markTabs() {
    var onChanges = changesOpen || fromChanges;
    tabMap.className = onChanges || statsOpen ? "" : "on";
    tabChanges.className = onChanges ? "on" : "";
    tabStats.className = statsOpen ? "on" : "";
    // Reviewing the changed files takes the width of the block's panel.
    document.body.classList.toggle("review", !!(fileViewOpen && fromChanges));
  }
  markTabs();

  document.getElementById("meta").textContent = tr("~{tokens} tokens of source", { tokens: fmt(data.repoTokens) }) + " · " + new Date(data.generatedAt).toLocaleString(lang);

  var lanes = document.getElementById("lanes");
  var zoomBlock = null;
  var fileViewOpen = false;
  var fileCards = {};
  var selectedFile = null;
  var cards = {};
  var laneOf = {};
  var laneEls = [];
  var draftShown = false;
  // A drag in progress (an arrow between two cards, a card to another layer).
  var gesturing = false;
  if (editing) lanes.appendChild(draftBox(!data.blocks.length));
  var shownLayers = editing ? data.allLayers.concat(data.blocks.some(function (b) { return b.layer === "unassigned"; }) ? ["unassigned"] : []) : data.lanes;
  shownLayers.forEach(function (layer, laneIndex) {
    var lane = el("div", "lane");
    lane.dataset.layer = layer;
    laneEls.push(lane);
    lane.appendChild(el("h2", null, layer));
    if (editing && layer !== "unassigned") lane.appendChild(laneTools(layer));
    var row = el("div", "cards");
    data.blocks.filter(function (b) { return (editing ? b.layer : b.lane) === layer; }).forEach(function (b) {
      var card = el("div", "card");
      var title = el("h3");
      title.appendChild(el("i", "dot " + b.severity));
      var label = el("span", null, editing ? b.name : b.shortName);
      if (!editing && b.shortName !== b.name) label.title = b.name;
      title.appendChild(label);
      card.appendChild(title);
      // How much of the code the block holds: a bar under the name, and a wider card for the bigger ones.
      var weight = el("div", "weight");
      var weightBar = el("i"); weightBar.style.width = Math.max(4, Math.round(b.weight * 100)) + "%";
      weight.appendChild(weightBar);
      weight.title = tr("{pct}% of the largest block's source", { pct: Math.round(b.weight * b.weight * 100) });
      card.appendChild(weight);
      if (!editing) card.style.width = Math.round(200 + 90 * b.weight) + "px";
      if (b.hotspot) card.classList.add("hot");
      card.appendChild(el("div", "sub", b.include.join(", ")));
      if (!b.files.length && data.hasModel) {
        card.className = "card planned";
        card.appendChild(el("div", "sub plan", tr("planned · no code yet")));
      } else card.appendChild(el("div", "sub", trn(b.files.length, "{n} file", "{n} files") + " · " + tr("~{tokens} tokens", { tokens: fmt(b.tokens) })));
      var badges = el("div", "badges");
      badges.appendChild(el("span", "badge", tr("context ~{tokens}", { tokens: fmt(b.contextTokens) })));
      if (b.hotspot) {
        var hot = el("span", "badge hot", tr("hotspot · {n} commit edits", { n: b.churn }));
        hot.title = tr("Times commits touched this block's files in the last 90 days: one of the most changed blocks.");
        badges.appendChild(hot);
      }
      var own = data.findings.filter(function (f) { return f.blocks.indexOf(b.id) >= 0 && f.severity !== "info"; });
      if (own.length) badges.appendChild(el("span", "badge " + (b.severity === "error" ? "err" : "warn"), trn(own.length, "{n} finding", "{n} findings")));
      if (b.problems) badges.appendChild(el("span", "badge " + (b.severity === "error" ? "err" : "warn"), trn(b.problems, "{n} analysis problem", "{n} analysis problems")));
      var ownDocs = data.docs.filter(function (d) { return (d.blocks || []).indexOf(b.id) >= 0; }).length;
      if (ownDocs) badges.appendChild(el("span", "badge doc", trn(ownDocs, "{n} doc", "{n} docs")));
      if (b.changes.files) {
        var changed = changeBadge(b.changes.added, b.changes.removed);
        changed.title = trn(b.changes.files, "{n} file changed since the last commit", "{n} files changed since the last commit");
        badges.appendChild(changed);
      }
      card.appendChild(badges);
      card.addEventListener("click", function (event) {
        if (dragDone) { dragDone = false; return; }
        if (event.shiftKey || event.ctrlKey || event.metaKey) toggleMulti(b.id); else select(b.id);
      });
      if (editing) editableCard(card, b);
      card.addEventListener("dblclick", function () { zoomInto(b.id); });
      card.addEventListener("mouseenter", function () { glow(b.id); });
      card.addEventListener("mouseleave", function () { glow(null); });
      card.title = tr("Double-click to see its files");
      cards[b.id] = card;
      laneOf[b.id] = laneIndex;
      row.appendChild(card);
    });
    if (editing) row.appendChild(newBlockCard(layer));
    lane.appendChild(row);
    lanes.appendChild(lane);
  });
  if (editing) lanes.appendChild(addLayerForm());
  else if (!data.blocks.length) {
    var emptyMap = el("div", "empty-map");
    emptyMap.appendChild(el("h2", null, tr("Nothing on the map yet")));
    emptyMap.appendChild(el("p", null, live ? tr("Sketch the project: layers, the blocks in each, and arrows between them. Agents build it from there.") : tr("No source files found. Run cantus serve to sketch the map.")));
    if (live) {
      emptyMap.appendChild(draftBox(true));
      var sketch = el("button", "secondary", tr("Or sketch it by hand")); sketch.addEventListener("click", function () { setEditing(true); }); emptyMap.appendChild(sketch);
    }
    lanes.appendChild(emptyMap);
  }

  // ---- Editing helpers (layers, blocks, arrows).
  function laneTools(layer) {
    var tools = el("div", "lane-tools");
    var layers = laneLayers();
    var index = layers.indexOf(layer);
    function button(label, title, action) { var b = el("button", null, label); b.title = title; b.addEventListener("click", function (event) { event.stopPropagation(); action(); }); tools.appendChild(b); }
    button(tr("Rename"), tr("Rename this layer"), function () {
      tools.innerHTML = "";
      var input = el("input"); input.value = layer;
      var ok = el("button", null, tr("Save"));
      function save() {
        var name = input.value.trim();
        if (!name || name === layer) return location.reload();
        var next = layers.slice(); next[index] = name;
        var renames = {}; renames[layer] = name;
        saveLayers(next, renames).catch(function (error) { alert(error.message); });
      }
      ok.addEventListener("click", save);
      input.addEventListener("keydown", function (event) { if (event.key === "Enter") save(); if (event.key === "Escape") location.reload(); });
      tools.appendChild(input); tools.appendChild(ok); input.focus(); input.select();
    });
    if (index > 0) button("↑", tr("Move up"), function () { var next = layers.slice(); next.splice(index, 1); next.splice(index - 1, 0, layer); saveLayers(next).catch(function (error) { alert(error.message); }); });
    if (index < layers.length - 1) button("↓", tr("Move down"), function () { var next = layers.slice(); next.splice(index, 1); next.splice(index + 1, 0, layer); saveLayers(next).catch(function (error) { alert(error.message); }); });
    button("✕", tr("Remove this layer"), function () {
      var inside = data.blocks.filter(function (b) { return b.layer === layer; }).length;
      if (layers.length === 1) return alert(tr("A map keeps at least one layer."));
      if (inside && !confirm(trn(inside, "Remove the layer {layer}? Its {n} block becomes unassigned.", "Remove the layer {layer}? Its {n} blocks become unassigned.", { layer: layer }))) return;
      saveLayers(layers.filter(function (name) { return name !== layer; })).catch(function (error) { alert(error.message); });
    });
    return tools;
  }

  function addLayerForm() {
    var box = el("div", "add-layer");
    var input = el("input"); input.placeholder = tr("New layer, e.g. ui, features, core");
    var add = el("button", null, tr("+ Add layer"));
    function save() {
      var name = input.value.trim();
      if (!name) return input.focus();
      saveLayers(laneLayers().concat([name])).catch(function (error) { alert(error.message); });
    }
    add.addEventListener("click", save);
    input.addEventListener("keydown", function (event) { if (event.key === "Enter") save(); });
    box.appendChild(input); box.appendChild(add);
    box.appendChild(el("span", "empty", tr("Layers go top to bottom: each may use itself and the ones below.")));
    return box;
  }

  /** Describe the project; an agent drafts layers, blocks and arrows; the draft is previewed before anything is saved. */
  function draftBox(open) {
    var box = el("details", "draft-box");
    box.open = !!open;
    box.appendChild(el("summary", null, data.blocks.length ? tr("Describe what to add, and Claude Code drafts it") : tr("Describe the project, and Claude Code drafts the map")));
    var text = el("textarea");
    text.placeholder = data.blocks.length ? tr("e.g. Add a wishlist: customers save products and get an email when the price drops.") : tr("e.g. A notes app: a web UI, notes with tags and search, sync to a server, offline storage in the browser.");
    try { text.value = sessionStorage.getItem("cantus-draft-text") || ""; } catch (error) { /* private mode */ }
    var go = el("button", null, tr("Draft the map"));
    var status = el("div", "empty", tr("It reads the project if there is one, changes nothing, and answers with layers, blocks and arrows to review."));
    go.addEventListener("click", function () {
      var description = text.value.trim();
      if (!description) return text.focus();
      try { sessionStorage.setItem("cantus-draft-text", description); } catch (error) { /* private mode */ }
      go.disabled = true; text.disabled = true;
      status.className = "empty"; status.textContent = tr("Claude Code is drafting the map… this can take a minute or two.");
      api("POST", "/api/map/draft", { description: description }).then(function (result) { showDraft(result); })
        .catch(function (error) { go.disabled = false; text.disabled = false; status.textContent = error.message; status.className = "finding error"; });
    });
    [text, go, status].forEach(function (n) { box.appendChild(n); });
    return box;
  }

  function showDraft(result) {
    draftShown = true;
    drawEdges();
    var model = result.model;
    var layers = (model.layers || ["interface", "application", "domain", "infrastructure"]).slice();
    if (model.blocks.some(function (b) { return b.layer === "unassigned"; })) layers.push("unassigned");
    var isNew = {}; result.addedBlocks.forEach(function (id) { isNew[id] = true; });
    var nameOf = {}; model.blocks.forEach(function (b) { nameOf[b.id] = b.name; });
    lanes.innerHTML = "";
    var bar = el("div", "draft-bar");
    bar.appendChild(el("span", "grow", tr("Draft") + ": " + trn(result.addedBlocks.length, "{n} new block", "{n} new blocks") + ", " + trn(result.addedDependencies.length, "{n} arrow", "{n} arrows") + (result.addedLayers.length ? ", " + tr("layers {names}", { names: result.addedLayers.join(", ") }) : "") + ". " + tr("Nothing is saved yet.")));
    var keep = el("button", null, tr("Keep it"));
    var discard = el("button", "secondary", tr("Discard"));
    keep.addEventListener("click", function () {
      keep.disabled = true;
      api("POST", "/api/map/draft/apply", { draft: result.draft }).then(function () {
        try { sessionStorage.removeItem("cantus-draft-text"); sessionStorage.setItem("cantus-edit", "1"); } catch (error) { /* private mode */ }
        location.hash = ""; location.reload();
      }).catch(function (error) { keep.disabled = false; alert(error.message); });
    });
    discard.addEventListener("click", function () { location.reload(); });
    bar.appendChild(keep); bar.appendChild(discard);
    lanes.appendChild(bar);
    layers.forEach(function (layer) {
      var lane = el("div", "lane");
      lane.appendChild(el("h2", null, layer + (result.addedLayers.indexOf(layer) >= 0 ? " · " + tr("new") : "")));
      var row = el("div", "cards");
      model.blocks.filter(function (b) { return b.layer === layer; }).forEach(function (b) {
        var card = el("div", "card" + (isNew[b.id] ? " new" : ""));
        var title = el("h3"); title.appendChild(el("span", null, b.name + (isNew[b.id] ? " · " + tr("new") : ""))); card.appendChild(title);
        card.appendChild(el("div", "sub", b.include.join(", ")));
        if (b.description) card.appendChild(el("div", "sub", b.description));
        var uses = model.dependencies.filter(function (d) { return d.from === b.id; }).map(function (d) { return nameOf[d.to] || d.to; });
        if (uses.length) card.appendChild(el("div", "sub uses", tr("uses {names}", { names: uses.join(", ") })));
        row.appendChild(card);
      });
      lane.appendChild(row);
      lanes.appendChild(lane);
    });
  }

  function folderFor(name) { return "src/" + (name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "block"); }

  function newBlockCard(layer) {
    var ghost = el("div", "card ghost", tr("+ Block"));
    ghost.title = tr("Add a block to {layer}", { layer: layer });
    ghost.addEventListener("click", function open(event) {
      event.stopPropagation();
      ghost.removeEventListener("click", open);
      ghost.className = "card";
      ghost.innerHTML = "";
      var form = el("form");
      var name = el("input"); name.placeholder = tr("Name, e.g. Orders");
      var folder = el("input"); folder.placeholder = tr("Folder");
      var desc = el("input"); desc.placeholder = tr("What it does, in one line");
      // Optionally, the first piece of work for it, sent to the lead of this worktree right after the block is created. The map starts no agent: without a session there is nowhere to send it.
      var work = live && live.session ? el("textarea") : null;
      if (work) { work.placeholder = tr("Optional: what should be built here? Sent right after the block is added."); work.rows = 3; }
      var touched = false;
      name.addEventListener("input", function () { if (!touched) folder.value = name.value.trim() ? folderFor(name.value) : ""; });
      folder.addEventListener("input", function () { touched = true; });
      var buttons = el("div", "buttons");
      var add = el("button", null, tr("Add")); add.type = "submit";
      var cancel = el("button", "secondary", tr("Cancel")); cancel.type = "button";
      cancel.addEventListener("click", function () { location.reload(); });
      buttons.appendChild(add); buttons.appendChild(cancel);
      var status = el("div", "empty");
      [name, folder, desc].concat(work ? [work] : [], [buttons, status]).forEach(function (n) { form.appendChild(n); });
      form.addEventListener("click", function (event) { event.stopPropagation(); });
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var prompt = work ? work.value.trim() : "";
        add.disabled = true;
        api("POST", "/api/map/blocks", { name: name.value, layer: layer, path: folder.value || undefined, description: desc.value }).then(function (r) {
          if (!prompt) return "block=" + r.id;
          // The block exists now: the work goes on it. If that fails the block stays, and the page says why.
          return api("POST", "/api/requests", { prompt: prompt, block: r.id })
            .then(function () { return "block=" + r.id; })
            .catch(function (error) { alert(tr("The block {id} was added, but its work was not started: {error}", { id: r.id, error: error.message })); return "block=" + r.id; });
        }).then(function (hash) { location.hash = hash; location.reload(); })
          .catch(function (error) { add.disabled = false; status.textContent = error.message; status.className = "finding error"; });
      });
      ghost.appendChild(form);
      name.focus();
    });
    return ghost;
  }

  /** In edit mode a card can be dragged to another layer, and its handle dragged onto another card to draw an arrow. */
  var dragDone = false;
  function editableCard(card, b) {
    var handle = el("span", "handle", "→");
    handle.title = tr("Drag onto another block: {name} uses it", { name: b.name });
    card.appendChild(handle);
    card.addEventListener("pointerdown", function (event) {
      if (event.button !== 0 || event.target.closest("input, button, a")) return;
      var arrow = event.target === handle;
      var startX = event.clientX, startY = event.clientY, moved = false, overLane = null;
      var line = null;
      function laneAt(x, y) { var node = document.elementFromPoint(x, y); return node && node.closest(".lane"); }
      function cardAt(x, y) { var node = document.elementFromPoint(x, y); var hit = node && node.closest(".card"); return hit && hit !== card ? Object.keys(cards).filter(function (id) { return cards[id] === hit; })[0] : null; }
      function move(e) {
        if (!moved && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 6) return;
        moved = true;
        gesturing = true;
        if (arrow) {
          var canvasBox = document.getElementById("canvas").getBoundingClientRect();
          var from = card.getBoundingClientRect();
          var canvasEl = document.getElementById("canvas");
          if (!line) { line = document.createElementNS(NS, "line"); line.style.stroke = "var(--blue)"; line.setAttribute("stroke-width", "2"); line.setAttribute("stroke-dasharray", "5 4"); svg.appendChild(line); }
          line.setAttribute("x1", from.right - canvasBox.left + canvasEl.scrollLeft); line.setAttribute("y1", from.top + from.height / 2 - canvasBox.top + canvasEl.scrollTop);
          line.setAttribute("x2", e.clientX - canvasBox.left + canvasEl.scrollLeft); line.setAttribute("y2", e.clientY - canvasBox.top + canvasEl.scrollTop);
        } else {
          card.style.opacity = "0.5";
          var lane = laneAt(e.clientX, e.clientY);
          if (overLane && overLane !== lane) overLane.classList.remove("drop");
          overLane = lane && lane.dataset.layer !== b.layer ? lane : null;
          if (overLane) overLane.classList.add("drop");
        }
      }
      function up(e) {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        gesturing = false;
        if (line) line.remove();
        card.style.opacity = "";
        if (overLane) overLane.classList.remove("drop");
        if (!moved) return;
        dragDone = true;
        setTimeout(function () { dragDone = false; }, 0);
        if (arrow) {
          var target = cardAt(e.clientX, e.clientY);
          if (target) mapEdit("POST", "/api/map/dependencies", { from: b.id, to: target }, "block=" + b.id).catch(function (error) { alert(error.message); });
        } else if (overLane) {
          mapEdit("PUT", "/api/map/blocks/" + encodeURIComponent(b.id), { layer: overLane.dataset.layer }, "block=" + b.id).catch(function (error) { alert(error.message); });
        }
      }
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  }

  /** The block's own fields and arrows, editable. A block with code keeps its folder: move the files instead. */
  function blockEditor(b) {
    var box = section(tr("Edit block"), b.files.length ? trn(b.files.length, "{n} file", "{n} files") : tr("planned"));
    var form = el("form");
    var name = el("input"); name.value = b.name;
    var layer = el("select");
    laneLayers().concat(["unassigned"]).forEach(function (name) { var o = el("option", null, name); o.value = name; if (name === b.layer) o.selected = true; layer.appendChild(o); });
    var folder = el("input"); folder.value = b.include[0] || "";
    if (b.files.length) { folder.disabled = true; folder.title = tr("This block has code: move its files and the map follows."); }
    var desc = el("textarea"); desc.value = b.description || ""; desc.placeholder = tr("What it does, in one line"); desc.rows = 2;
    var buttons = el("div", "buttons");
    var save = el("button", null, tr("Save")); save.type = "submit";
    buttons.appendChild(save);
    if (!b.files.length) {
      var remove = el("button", "secondary", tr("Remove block")); remove.type = "button";
      remove.addEventListener("click", function () {
        if (confirm(tr("Remove {name} and its arrows from the map?", { name: b.name }))) mapEdit("DELETE", "/api/map/blocks/" + encodeURIComponent(b.id), {}, "").catch(failTo(status));
      });
      buttons.appendChild(remove);
    }
    var status = el("div", "empty");
    [el("label", null, tr("Name")), name, el("label", null, tr("Layer")), layer, el("label", null, tr("Folder")), folder, el("label", null, tr("Description")), desc, buttons, status].forEach(function (n) { form.appendChild(n); });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var changes = { name: name.value, layer: layer.value, description: desc.value };
      if (!b.files.length) changes.path = folder.value;
      mapEdit("PUT", "/api/map/blocks/" + encodeURIComponent(b.id), changes, function (r) { return "block=" + r.id; }).catch(failTo(status));
    });
    box.appendChild(form);

    box.appendChild(el("h4", null, tr("Uses")));
    var outgoing = data.edges.filter(function (e) { return e.from === b.id; });
    if (!outgoing.length) box.appendChild(el("div", "empty", tr("No arrows yet: drag the → handle onto a block, or pick one below.")));
    outgoing.forEach(function (e) {
      var row = el("div", "diag");
      row.appendChild(el("span", null, (byId[e.to] ? byId[e.to].name : e.to) + (e.status === "planned" ? " · " + tr("not in code yet") : e.declared ? "" : " · " + tr("in code, not on the map"))));
      if (e.declared) {
        var drop = el("button", "tiny", "✕"); drop.title = tr("Remove the arrow from the map");
        drop.addEventListener("click", function () { mapEdit("DELETE", "/api/map/dependencies", { from: b.id, to: e.to }, "block=" + b.id).catch(failTo(status)); });
        row.appendChild(document.createTextNode(" ")); row.appendChild(drop);
      } else {
        var keep = el("button", "tiny", tr("+ map")); keep.title = tr("Put this dependency on the map");
        keep.addEventListener("click", function () { mapEdit("POST", "/api/map/dependencies", { from: b.id, to: e.to }, "block=" + b.id).catch(failTo(status)); });
        row.appendChild(document.createTextNode(" ")); row.appendChild(keep);
      }
      box.appendChild(row);
    });
    var others = data.blocks.filter(function (o) { return o.id !== b.id && !outgoing.some(function (e) { return e.to === o.id; }); });
    if (others.length) {
      var pick = el("select");
      others.forEach(function (o) { var opt = el("option", null, o.name + " (" + o.layer + ")"); opt.value = o.id; pick.appendChild(opt); });
      var add = el("button", "secondary", tr("Add arrow"));
      add.addEventListener("click", function () { mapEdit("POST", "/api/map/dependencies", { from: b.id, to: pick.value }, "block=" + b.id).catch(failTo(status)); });
      var row2 = el("div", "buttons"); row2.appendChild(pick); row2.appendChild(add);
      box.appendChild(row2);
    }
    return box;
  }

  var svg = document.getElementById("edges");
  var NS = "http://www.w3.org/2000/svg";
  var colors = { ok: "var(--muted)", undeclared: "var(--violet)", violation: "var(--orange)", planned: "var(--ink-subtle)", active: "var(--blue)" };

  function marker(id, color) {
    var m = document.createElementNS(NS, "marker");
    m.setAttribute("id", id); m.setAttribute("viewBox", "0 0 10 10"); m.setAttribute("refX", "9"); m.setAttribute("refY", "5");
    m.setAttribute("markerWidth", "7"); m.setAttribute("markerHeight", "7"); m.setAttribute("orient", "auto-start-reverse");
    var p = document.createElementNS(NS, "path"); p.setAttribute("d", "M0,0 L10,5 L0,10 z"); p.style.fill = color;
    m.appendChild(p); return m;
  }

  // The arrows drawn, to light up those of the block under the cursor without drawing again.
  var edgePaths = [];
  /** A thicker line for an arrow that carries more names (1 to 2.2 px). */
  function edgeWidth(e) { return Math.min(2.2, 1 + Math.log(1 + e.symbols.length) * 0.35).toFixed(2); }
  function glow(id) {
    if (selected) return;
    edgePaths.forEach(function (item) {
      var on = id && (item.edge.from === id || item.edge.to === id);
      if (item.edge.status === "ok") {
        item.path.style.stroke = on ? colors.active : colors.ok;
        item.path.setAttribute("marker-end", "url(#m-" + (on ? "active" : "ok") + ")");
        item.path.setAttribute("opacity", on ? "1" : id ? "0.15" : "0.4");
      } else item.path.setAttribute("opacity", on || !id ? "1" : "0.25");
      item.path.setAttribute("stroke-width", on ? "2.4" : edgeWidth(item.edge));
    });
  }
  function drawEdges() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (fileViewOpen || changesOpen || statsOpen || draftShown) return;
    if (zoomBlock) return drawFileEdges();
    var defs = document.createElementNS(NS, "defs");
    Object.keys(colors).forEach(function (k) { defs.appendChild(marker("m-" + k, colors[k])); });
    svg.appendChild(defs);
    var reached = reachedFrom(selected);
    var canvas = document.getElementById("canvas");
    svg.setAttribute("width", canvas.scrollWidth); svg.setAttribute("height", canvas.scrollHeight);
    var base = canvas.getBoundingClientRect();
    function laneBox(index) {
      var r = laneEls[index].getBoundingClientRect();
      return { x: r.left - base.left + canvas.scrollLeft, y: r.top - base.top + canvas.scrollTop, w: r.width, h: r.height };
    }
    // Nearest x in a lane that does not cross a card, so long edges pass between blocks.
    function freeX(laneIndex, wanted) {
      var spans = Object.keys(cards).filter(function (id) { return laneOf[id] === laneIndex; }).map(function (id) {
        var r = box(id); return [r.x - 14, r.x + r.w + 14];
      }).sort(function (p, q) { return p[0] - q[0]; });
      if (!spans.some(function (s) { return wanted > s[0] && wanted < s[1]; })) return wanted;
      var options = [spans[0][0] - 10, spans[spans.length - 1][1] + 10];
      for (var i = 1; i < spans.length; i++) options.push((spans[i - 1][1] + spans[i][0]) / 2);
      return options.sort(function (p, q) { return Math.abs(p - wanted) - Math.abs(q - wanted); })[0];
    }
    function box(id) {
      var r = cards[id].getBoundingClientRect();
      return { x: r.left - base.left + canvas.scrollLeft, y: r.top - base.top + canvas.scrollTop, w: r.width, h: r.height };
    }
    edgePaths = [];
    data.edges.forEach(function (e) {
      if (!cards[e.from] || !cards[e.to]) return;
      var a = box(e.from), b = box(e.to), d;
      var ax = a.x + a.w / 2, bx = b.x + b.w / 2;
      var la = laneOf[e.from], lb = laneOf[e.to];
      if (la === lb && Math.abs(a.y - b.y) >= 5) {
        // Same layer, different rows (a layer with many blocks wraps): a direct curve.
        var below = b.y > a.y;
        var y1 = below ? a.y + a.h : a.y, y2 = below ? b.y : b.y + b.h, half = (y2 - y1) / 2;
        d = "M" + ax + "," + y1 + " C" + ax + "," + (y1 + half) + " " + bx + "," + (y2 - half) + " " + bx + "," + y2;
      } else if (la === lb) {
        var right = bx > ax;
        var sx = right ? a.x + a.w : a.x, tx = right ? b.x : b.x + b.w, y1 = a.y + a.h / 2, y2 = b.y + b.h / 2;
        d = "M" + sx + "," + y1 + " C" + (sx + (right ? 40 : -40)) + "," + (y1 - 30) + " " + (tx + (right ? -40 : 40)) + "," + (y2 - 30) + " " + tx + "," + y2;
      } else {
        // Across layers: pass between the cards of every layer in between, in layer order.
        var down = lb > la;
        var points = [[ax, down ? a.y + a.h : a.y]];
        var step = down ? 1 : -1;
        for (var l = la + step; l !== lb; l += step) {
          var lr = laneBox(l);
          var t = (l - la) / (lb - la);
          var x = freeX(l, ax + (bx - ax) * t);
          points.push([x, down ? lr.y : lr.y + lr.h]);
          points.push([x, down ? lr.y + lr.h : lr.y]);
        }
        points.push([bx, down ? b.y : b.y + b.h]);
        d = "M" + points[0][0] + "," + points[0][1];
        for (var i = 1; i < points.length; i++) {
          var p0 = points[i - 1], p1 = points[i], mid = (p1[1] - p0[1]) / 2;
          d += " C" + p0[0] + "," + (p0[1] + mid) + " " + p1[0] + "," + (p1[1] - mid) + " " + p1[0] + "," + p1[1];
        }
      }
      var active = selected && (e.from === selected || e.to === selected);
      var onChain = !active && selected && e.status !== "planned" && reached[e.from] && (reached[e.to] || e.to === selected);
      var key = (active || onChain) && e.status === "ok" ? "active" : e.status;
      var path = document.createElementNS(NS, "path");
      path.setAttribute("d", d); path.setAttribute("fill", "none");
      path.style.stroke = colors[key]; path.setAttribute("stroke-width", active ? "2.4" : String(edgeWidth(e)));
      if (e.status === "undeclared") path.setAttribute("stroke-dasharray", "6 5");
      if (e.status === "planned") path.setAttribute("stroke-dasharray", "2 4");
      // Quiet unless it says something: a rule broken, or the block under the cursor or selected. The rest is a soft web.
      if (selected && !active && !onChain) path.setAttribute("opacity", "0.2");
      else if (!selected && !active && e.status === "ok") path.setAttribute("opacity", "0.4");
      path.setAttribute("marker-end", "url(#m-" + key + ")");
      edgePaths.push({ path: path, edge: e, key: key });
      var title = document.createElementNS(NS, "title");
      title.textContent = byId[e.from].name + " → " + byId[e.to].name + (e.symbols.length ? ": " + e.symbols.join(", ") : "");
      path.appendChild(title);
      svg.appendChild(path);
    });
  }

  function section(title, right) {
    var s = el("div", "section");
    var h = el("h4", null, title);
    if (right) h.appendChild(el("span", null, right));
    s.appendChild(h);
    return s;
  }
  function list(items, cls) {
    var ul = el("ul");
    items.forEach(function (item) {
      var li = el("li", cls);
      if (typeof item === "string") li.textContent = item; else li.appendChild(item);
      ul.appendChild(li);
    });
    return ul;
  }

  function diagnosticList(items) {
    var box = el("div");
    items.forEach(function (d) {
      var row = el("div", "diag " + d.level);
      row.appendChild(el("span", "lvl", "[" + d.level + "] " + d.stage + " "));
      if (d.file) row.appendChild(el("span", "where", d.file + (d.line ? ":" + d.line + ":" + (d.column || 1) : "") + " "));
      row.appendChild(el("span", null, d.message));
      if (d.detail) { var det = el("details"); det.appendChild(el("summary", null, "details")); det.appendChild(el("pre", null, d.detail)); row.appendChild(det); }
      box.appendChild(row);
    });
    return box;
  }
  function blockOfFile(file) {
    for (var i = 0; i < data.blocks.length; i++) {
      if (data.blocks[i].files.some(function (f) { return f.path === file; })) return data.blocks[i].id;
    }
    return null;
  }

  function select(id) {
    leaveZoom();
    view = "block"; openTask = null; openPanel();
    selected = id;
    var reached = reachedFrom(id);
    Object.keys(cards).forEach(function (k) {
      var related = k === id || data.edges.some(function (e) { return (e.from === id && e.to === k) || (e.to === id && e.from === k); });
      cards[k].className = "card" + (k === id ? " selected" : related ? "" : reached[k] ? " reached" : " faded");
    });
    multi = [];
    setHash("block=" + id);
    drawEdges();
    renderPanel(byId[id]);
  }

  function toggleMulti(id) {
    if (selected && multi.length === 0) multi = [selected];
    selected = null;
    var at = multi.indexOf(id);
    if (at >= 0) multi.splice(at, 1); else multi.push(id);
    if (multi.length === 0) return clearSelection();
    if (multi.length === 1) return select(multi[0]);
    renderSelection();
  }

  function renderSelection() {
    leaveZoom();
    view = "selection"; openTask = null; openPanel();
    setHash("blocks=" + multi.join(","));
    Object.keys(cards).forEach(function (k) { cards[k].className = "card" + (multi.indexOf(k) >= 0 ? " selected" : " faded"); });
    drawEdges();
    var panel = document.getElementById("panel");
    panel.innerHTML = "";
    panel.appendChild(el("div", "kicker", tr("Selection · one scope")));
    panel.appendChild(el("h1", null, trn(multi.length, "{n} block", "{n} blocks")));
    panel.appendChild(el("div", "desc", tr("Shift/Ctrl+click adds or removes blocks.")));
    var members = section(tr("Blocks"), String(multi.length));
    members.appendChild(list(multi.map(function (id) { return byId[id].name + " (" + id + ")"; }), "text"));
    panel.appendChild(members);
    var info = section(tr("Scope"));
    info.appendChild(el("div", "empty", live ? tr("Computing…") : tr("Open the live map (cantus serve) for the scope's context budget.")));
    panel.appendChild(info);
    if (live) {
      api("GET", "/api/scope?blocks=" + encodeURIComponent(multi.join(","))).then(function (scope) {
        info.innerHTML = "";
        info.appendChild(el("h4", null, tr("Scope")));
        info.appendChild(el("div", "desc", tr("~{tokens} tokens of context, of ~{total}", { tokens: fmt(scope.contextTokens), total: fmt(data.repoTokens) })));
        info.appendChild(el("div", "empty", tr("Uses from outside: {names}. Callers from outside: {n}.", { names: scope.neighbors.join(", ") || tr("nothing"), n: scope.callers })));
      }).catch(function (error) { info.appendChild(el("div", "finding error", error.message)); });
      var save = section(tr("Save as group"));
      var idInput = el("input"); idInput.placeholder = tr("id, e.g. checkout-flow");
      var nameInput = el("input"); nameInput.placeholder = "name";
      var button = el("button", null, tr("Save group"));
      var status = el("div", "empty");
      button.addEventListener("click", function () {
        api("POST", "/api/groups", { id: idInput.value.trim(), name: nameInput.value.trim() || idInput.value.trim(), blocks: multi })
          .then(function () { location.hash = "group=" + idInput.value.trim(); location.reload(); })
          .catch(function (error) { status.textContent = error.message; status.className = "finding error"; });
      });
      [idInput, nameInput, button, status].forEach(function (node) { save.appendChild(node); });
      panel.appendChild(save);
      panel.appendChild(taskForm({ blocks: multi.slice() }, tr("this selection")));
    }
    var use = section(tr("Use it with your coding agent"));
    use.appendChild(el("code", "cmd", "cantus context " + multi.join(",")));
    use.appendChild(el("code", "cmd", "cantus-scope subagent: blocks " + multi.join(", ")));
    panel.appendChild(use);
  }

  function clearSelection() {
    leaveZoom();
    view = "none"; openTask = null;
    selected = null;
    multi = [];
    setHash("");
    Object.keys(cards).forEach(function (k) { cards[k].className = "card"; });
    drawEdges(); renderPanel(null);
  }

  function selectGroup(id) {
    leaveZoom();
    var g = data.groups.filter(function (x) { return x.id === id; })[0];
    if (!g) return clearSelection();
    view = "group"; openTask = null; openPanel();
    selected = null;
    multi = [];
    setHash("group=" + id);
    Object.keys(cards).forEach(function (k) {
      var member = g.blocks.indexOf(k) >= 0;
      var neighbor = g.neighbors.indexOf(k) >= 0;
      cards[k].className = "card" + (member ? " selected" : neighbor ? "" : " faded");
    });
    drawEdges();
    var panel = document.getElementById("panel");
    panel.innerHTML = "";
    panel.appendChild(el("div", "kicker", tr("Group · sub-agent context")));
    panel.appendChild(el("h1", null, g.name));
    panel.appendChild(el("div", "desc", g.description || g.blocks.join(", ")));
    var budget = section(tr("Context budget"), tr("~{tokens} of ~{total} repo tokens", { tokens: fmt(g.contextTokens), total: fmt(data.repoTokens) }));
    var bar = el("div", "bar"); var fill = el("div"); fill.style.width = Math.max(1, Math.min(100, 100 * g.contextTokens / Math.max(1, data.repoTokens))) + "%";
    bar.appendChild(fill); budget.appendChild(bar); panel.appendChild(budget);
    var members = section(tr("Blocks in the group"), String(g.blocks.length));
    members.appendChild(list(g.blocks.map(function (id) { return byId[id].name + " (" + id + ")"; }), "text"));
    if (g.missing.length) members.appendChild(el("div", "finding warning", tr("No longer in the map: {names}", { names: g.missing.join(", ") })));
    panel.appendChild(members);
    var outside = section(tr("Uses from outside"), String(g.neighbors.length));
    outside.appendChild(g.neighbors.length ? list(g.neighbors.map(function (id) { return byId[id].name + " (" + id + ")"; }), "text") : el("div", "empty", tr("Nothing outside the group.")));
    panel.appendChild(outside);
    var callers = section(tr("Callers from outside"), trn(g.callers, "{n} call site", "{n} call sites"));
    panel.appendChild(callers);
    panel.appendChild(docsSection({ group: g.id }));
    var use = section(tr("Use it with your coding agent"));
    use.appendChild(el("code", "cmd", "group-" + g.id + " " + tr("subagent (cantus agents)")));
    use.appendChild(el("code", "cmd", "cantus context --group " + g.id));
    panel.appendChild(use);
    if (live) {
      var remove = el("button", null, tr("Delete group"));
      remove.addEventListener("click", function () {
        if (!confirm(tr("Delete group {id}? Its blocks are not touched.", { id: g.id }))) return;
        api("DELETE", "/api/groups/" + encodeURIComponent(g.id)).then(function () { location.hash = ""; location.reload(); });
      });
      panel.insertBefore(taskForm({ group: g.id }, tr("this group")), use);
      panel.appendChild(remove);
    }
  }

  /** The block's files, each opening onto what it offers: signatures, doc, and how many places outside use it. */
  function ownedSection(b) {
    var owned = section(tr("① Owned code · full, writable"), trn(b.files.length, "{n} file", "{n} files") + " · " + tok(b.tokens));
    if (!b.files.length) { owned.appendChild(el("div", "empty", tr("No files yet."))); return owned; }
    var byFile = {};
    b.api.forEach(function (entry) { (byFile[entry.file] = byFile[entry.file] || []).push(entry); });
    var withApi = b.files.filter(function (f) { return byFile[f.path]; }).length;
    var used = b.api.filter(function (entry) { return entry.callers > 0; }).length;
    owned.appendChild(el("div", "empty", b.api.length ? trn(b.api.length, "{n} exported name in {files} file(s), {used} used outside the block. Open a file for its signatures.", "{n} exported names in {files} file(s), {used} used outside the block. Open a file for its signatures.", { files: withApi, used: used }) : tr("Nothing exported: other blocks do not use this code directly.")));
    var limit = 60;
    b.files.slice(0, limit).forEach(function (f) {
      var entries = byFile[f.path] || [];
      var changeTag = fileChangeTag(f.path);
      if (!entries.length) {
        var plain = el("div", "file-row");
        plain.appendChild(el("span", "path", f.path));
        plain.appendChild(el("span", "tag", tok(f.tokens)));
        if (minified[f.path]) { var skip = el("span", "tag", tr("minified · not analyzed")); skip.title = tr("Kept in the block; imports and <script src> pointing to it are links, but its code is not read. Set analysis.parseMinified in the map to read it."); plain.appendChild(skip); }
        if (changeTag) plain.appendChild(changeTag);
        owned.appendChild(plain);
        return;
      }
      var det = el("details", "file-api");
      if (withApi <= 2) det.open = true;
      var sum = el("summary");
      sum.appendChild(el("span", "path", f.path));
      sum.appendChild(el("span", "tag", trn(entries.length, "{n} export", "{n} exports")));
      sum.appendChild(el("span", "tag", tok(f.tokens)));
      if (changeTag) sum.appendChild(changeTag);
      det.appendChild(sum);
      entries.forEach(function (entry) {
        var row = el("div", "api-entry");
        var head = el("div", "api-head");
        head.appendChild(el("span", "kind " + entry.kind, entry.kind));
        head.appendChild(el("b", null, entry.name));
        head.appendChild(el("span", "tag" + (entry.callers ? " used" : ""), entry.callers ? trn(entry.callers, "{n} caller outside", "{n} callers outside") : tr("not used outside")));
        if (!entry.complete) head.appendChild(el("span", "tag warn", tr("types inferred")));
        row.appendChild(head);
        row.appendChild(el("code", "signature", entry.signature));
        if (entry.doc) row.appendChild(el("div", "empty", entry.doc));
        det.appendChild(row);
      });
      owned.appendChild(det);
    });
    if (b.files.length > limit) owned.appendChild(el("div", "empty", trn(b.files.length - limit, "… {n} more file", "… {n} more files")));
    // Changed files under the block that the analysis does not list: styles, data, deleted files…
    var listed = {};
    b.files.forEach(function (f) { listed[f.path] = true; });
    var others = Object.keys(data.changes.files).filter(function (file) { return data.changes.files[file].block === b.id && !listed[file]; }).sort();
    if (others.length) {
      owned.appendChild(el("div", "empty", tr("Also changed here:")));
      others.forEach(function (file) {
        var row = el("div", "file-row");
        row.appendChild(el("span", "path", file));
        if (data.changes.files[file].status === "deleted") row.appendChild(el("span", "tag warn", tr("deleted")));
        var tag = fileChangeTag(file);
        if (tag) row.appendChild(tag);
        owned.appendChild(row);
      });
    }
    return owned;
  }

  function renderPanel(b) {
    var panel = document.getElementById("panel");
    panel.innerHTML = "";
    if (!b) {
      panel.appendChild(el("div", "kicker", tr("Sub-agent context")));
      panel.appendChild(el("h1", null, tr("Select a block")));
      panel.appendChild(el("p", "empty", tr("Each block, or group of blocks, is the scope of one agent: its own code, the API of the blocks it uses, and who calls it.")));
      if (live) {
        var toMenu = el("div", "empty");
        var openMenu = el("a", null, tr("Worktrees"));
        openMenu.href = "#"; openMenu.style.color = "var(--blue-soft)";
        openMenu.addEventListener("click", function (event) { event.preventDefault(); setSessions(true); });
        toMenu.appendChild(document.createTextNode(tr("Who works where, and what waits for you, is in the menu") + " "));
        toMenu.appendChild(openMenu);
        panel.appendChild(toMenu);
      }
      if (data.groups.length) {
        var groups = section(tr("Groups"), String(data.groups.length));
        data.groups.forEach(function (g) {
          var row = el("div", "diag");
          var link = el("a", null, g.name);
          link.href = "#"; link.style.color = "var(--blue-soft)";
          link.addEventListener("click", function (event) { event.preventDefault(); selectGroup(g.id); });
          row.appendChild(link);
          row.appendChild(el("span", null, " · " + g.blocks.join(", ") + (g.missing.length ? " · " + tr("missing: {names}", { names: g.missing.join(", ") }) : "")));
          groups.appendChild(row);
        });
        panel.appendChild(groups);
      }
      if (live) {
        var plannedBlocks = data.hasModel ? data.blocks.filter(function (b) { return !b.files.length; }) : [];
        var plannedArrows = data.edges.filter(function (e) { return e.status === "planned"; });
        if (plannedBlocks.length || plannedArrows.length) {
          var about = el("div");
          about.appendChild(el("div", "empty", tr("What the map has and the code does not: Claude Code builds it wave by wave, the blocks that are used before the ones that use them, each through its block's specialist. Each agent decides its block's API.")));
          if (plannedBlocks.length) about.appendChild(el("div", "sub", tr("Blocks: {names}", { names: plannedBlocks.map(function (b) { return b.name; }).join(", ") })));
          if (plannedArrows.length) about.appendChild(el("div", "sub", tr("Arrows: {names}", { names: plannedArrows.map(function (e) { return (byId[e.from] ? byId[e.from].name : e.from) + " → " + (byId[e.to] ? byId[e.to].name : e.to); }).join(", ") })));
          panel.appendChild(taskForm({ build: true }, trn(plannedBlocks.length, "{n} block", "{n} blocks") + " · " + trn(plannedArrows.length, "{n} arrow", "{n} arrows"), about));
        }
        panel.appendChild(taskForm({ orchestrate: true }, tr("the whole project"), tr("Claude Code plans the work on the map, delegates each piece to the block's specialist (run cantus agents to create them) and reports back; each delegation shows on the map.")));
      }
      panel.appendChild(allDocsSection());
      var all = section(tr("Findings"), String(data.findings.length));
      all.appendChild(data.findings.length ? list(data.findings.map(function (f) { return "[" + severityWord(f.severity) + "] " + findingText(f); }), "text") : el("div", "empty", tr("No findings.")));
      panel.appendChild(all);
      var serious = data.diagnostics.filter(function (d) { return d.level !== "info"; });
      var infos = data.diagnostics.filter(function (d) { return d.level === "info"; });
      var log = section(tr("Analysis log"), trn(serious.length, "{n} problem", "{n} problems") + ", " + trn(infos.length, "{n} note", "{n} notes"));
      log.appendChild(serious.length ? diagnosticList(serious) : el("div", "empty", tr("No problems while reading the project.")));
      if (infos.length) { var more = el("details"); more.appendChild(el("summary", null, trn(infos.length, "{n} note", "{n} notes"))); more.appendChild(diagnosticList(infos)); log.appendChild(more); }
      if (data.problems.length) {
        var explain = el("a", "change-link", tr("Explain these problems"));
        explain.addEventListener("click", function () { showProblems(); });
        log.appendChild(explain);
      }
      log.appendChild(el("div", "empty", tr("Full log: {path}", { path: ".cantus/analysis.log" })));
      panel.appendChild(log);
      return;
    }
    panel.appendChild(el("div", "kicker", tr("Sub-agent context")));
    panel.appendChild(el("h1", null, b.name));
    panel.appendChild(el("div", "desc", b.description || (b.layer + " · " + b.include.join(", "))));
    if (editing && !zoomBlock) panel.appendChild(blockEditor(b));

    // The panel answers three things first: who works on this block now, what to look at, and where to ask for work. The briefing the agent gets is behind a closed fold.
    var workers = worktrees && worktrees.checkouts ? worktrees.checkouts.filter(function (c) { return c.blocks && c.blocks.indexOf(b.id) >= 0; }) : [];
    if (live && workers.length) {
      var who = section(tr("Who works here"), String(workers.length));
      workers.forEach(function (c) {
        var standing = worktreeStanding(c);
        var row = el("div", "diag");
        row.appendChild(el("span", "lvl", standing.word + " · "));
        row.appendChild(el("strong", null, worktreeName(c)));
        if (c.current) row.appendChild(el("span", null, " · " + tr("this map")));
        who.appendChild(row);
      });
      panel.appendChild(who);
    }
    var own = data.findings.filter(function (f) { return f.blocks.indexOf(b.id) >= 0; });
    var findings = section(tr("Findings"), String(own.length));
    if (own.length) {
      var ul = el("ul");
      own.forEach(function (f) { var li = el("li", "text finding " + f.severity, "[" + severityWord(f.severity) + "] " + findingText(f)); ul.appendChild(li); });
      findings.appendChild(ul);
    } else findings.appendChild(el("div", "empty", tr("Aligned with the model.")));
    panel.appendChild(findings);

    var blockDiagnostics = data.diagnostics.filter(function (d) { return d.file && blockOfFile(d.file) === b.id; });
    if (blockDiagnostics.length) {
      var diag = section(tr("Analysis problems in this block"), String(blockDiagnostics.length));
      diag.appendChild(diagnosticList(blockDiagnostics));
      panel.appendChild(diag);
    }

    if (live) panel.appendChild(taskForm({ block: b.id }, tr("this block")));
    var brief = el("details", "briefing");
    brief.id = "briefing";
    brief.appendChild(el("summary", null, tr("What the agent sees · briefing ~{tokens} tokens", { tokens: fmt(b.contextTokens) })));
    // Left open or shut as the person last had it: the panel is drawn again for every block they select.
    try { brief.open = sessionStorage.getItem("cantus-briefing") === "1"; } catch (error) { /* private mode */ }
    brief.addEventListener("toggle", function () { try { if (brief.open) sessionStorage.setItem("cantus-briefing", "1"); else sessionStorage.removeItem("cantus-briefing"); } catch (error) { /* private mode */ } });
    panel.appendChild(brief);

    var budget = section(tr("Context budget"), tr("~{tokens} of ~{total} repo tokens", { tokens: fmt(b.contextTokens), total: fmt(data.repoTokens) }));
    var bar = el("div", "bar"); var fill = el("div"); fill.style.width = Math.max(1, Math.min(100, 100 * b.contextTokens / Math.max(1, data.repoTokens))) + "%";
    bar.appendChild(fill); budget.appendChild(bar);
    brief.appendChild(budget);
    if (!zoomBlock) {
      var open = el("button", "secondary", tr("Open the block's files"));
      open.addEventListener("click", function () { zoomInto(b.id); });
      brief.appendChild(open);
    }
    brief.appendChild(docsSection({ block: b.id }));

    brief.appendChild(ownedSection(b));

    // The neighbors' contracts and the call sites into this block: with the page they are all there; a live page asks for this block's own.
    var whenPanelData = [];
    var out = data.edges.filter(function (e) { return e.from === b.id; });
    var neighbors = section(tr("② Neighbor contracts · signatures only"), String(out.length));
    if (!out.length) neighbors.appendChild(el("div", "empty", tr("Depends on no other block.")));
    out.forEach(function (e) {
      var t = byId[e.to];
      var det = el("details");
      var sum = el("summary", null, t.name + (e.symbols.length ? "  ·  " + e.symbols.join(", ") : e.status === "planned" ? "  ·  " + tr("declared, unused") : ""));
      det.appendChild(sum);
      var contractsHere = el("div");
      det.appendChild(contractsHere);
      whenPanelData.push(function (extra) {
        t.publicFiles.forEach(function (file) {
          if (extra.contracts[file] !== undefined) { contractsHere.appendChild(el("div", "sub", file)); contractsHere.appendChild(el("pre", null, extra.contracts[file] || "// " + tr("no exports"))); }
        });
      });
      if (e.status === "undeclared") det.appendChild(el("div", "finding error", tr("Not allowed by the model")));
      if (e.status === "violation") det.appendChild(el("div", "finding warning", tr("Violates layer rules")));
      neighbors.appendChild(det);
    });
    brief.appendChild(neighbors);

    var incoming = data.edges.filter(function (e) { return e.to === b.id && e.status !== "planned"; });
    var callCounts = (data.callSiteCounts || {})[b.id] || { all: 0, from: {} };
    var dependents = section(tr("③ Callers · keep compatible"), trn(callCounts.all, "{n} call site", "{n} call sites"));
    if (!incoming.length) dependents.appendChild(el("div", "empty", tr("No block imports this one.")));
    incoming.forEach(function (e) {
      var det = el("details");
      var rows = el("div");
      var shown = 0;
      det.appendChild(el("summary", null, tr("{name} uses {symbols} ({n})", { name: byId[e.from].name, symbols: e.symbols.join(", ") || tr("it"), n: callCounts.from[e.from] !== undefined ? callCounts.from[e.from] : 0 })));
      det.appendChild(rows);
      dependents.appendChild(det);
      whenPanelData.push(function (extra) {
        var seenCall = {};
        var own = extra.callSites.filter(function (c) {
          if (c.targetBlock !== b.id || c.block !== e.from) return false;
          var key = c.file + ":" + c.line + ":" + c.column + ":" + c.symbol;
          if (seenCall[key]) return false; // a call found by name, linked to several files of this block
          seenCall[key] = true;
          return true;
        });
        var total = callCounts.from[e.from] !== undefined ? callCounts.from[e.from] : own.length;
        var rank = { certain: 0, likely: 1, "by-name": 2 };
        own.sort(function (x, y) { return (rank[x.match] || 0) - (rank[y.match] || 0); });
        own.slice(0, 30).forEach(function (c) {
          var row = el("div", "diag");
          row.appendChild(el("span", "where", c.file + ":" + c.line + " "));
          row.appendChild(el("span", null, c.snippet));
          if (c.match === "by-name" || c.match === "likely") {
            var how = el("span", "badge" + (c.match === "by-name" ? " warn" : ""), c.match === "by-name" ? tr("by name only") : tr("likely"));
            how.title = c.match === "by-name" ? tr("Found only by name (a global, component or route several files could answer): check it") : tr("One candidate, or the one the same page loads: very probably right");
            row.appendChild(document.createTextNode(" ")); row.appendChild(how);
          }
          rows.appendChild(row);
          shown++;
        });
        if (total > shown) rows.appendChild(el("div", "empty", tr("… {n} more", { n: total - shown })));
      });
    });
    brief.appendChild(dependents);
    if (whenPanelData.length) {
      if (!data.lazyPanel) whenPanelData.forEach(function (fill) { fill({ callSites: data.callSites, contracts: data.contracts }); });
      else {
        var waiting = el("div", "empty", tr("Loading…"));
        dependents.appendChild(waiting);
        panelDataOf(b.id).then(function (extra) { waiting.remove(); whenPanelData.forEach(function (fill) { fill(extra); }); })
          .catch(function (error) { waiting.textContent = tr("Could not load this block's contracts and call sites: {message}", { message: error.message }); });
      }
    }

    var indirect = b.dependents.filter(function (d) { return d.distance > 1; });
    if (indirect.length) {
      var through = section(tr("Reach · through other blocks"), trn(indirect.length, "{n} block", "{n} blocks"));
      through.appendChild(el("div", "empty", tr("A change here can also reach these blocks, which use it only through others (outlined in amber on the map). Their callers keep working only if the blocks in between do.")));
      indirect.forEach(function (d) {
        var row = el("div", "diag");
        row.appendChild(el("span", "where", byId[d.id].name + " "));
        row.appendChild(el("span", null, trn(d.distance, "{n} step", "{n} steps")));
        through.appendChild(row);
      });
      brief.appendChild(through);
    }

    if (b.changesWith && b.changesWith.length) {
      var together = section(tr("Usually changed together"), trn(b.changesWith.length, "{n} pair", "{n} pairs"));
      together.appendChild(el("div", "empty", tr("In the git history these files change in the same commits as files outside the block, often with no import between them.")));
      b.changesWith.forEach(function (pair) {
        var row = el("div", "diag");
        row.appendChild(el("span", "where", pair.file + " "));
        row.appendChild(el("span", null, tr("with {other}", { other: pair.other + (pair.otherBlock && byId[pair.otherBlock] ? " (" + byId[pair.otherBlock].name + ")" : "") }) + " · " + trn(pair.commits, "{n} commit", "{n} commits") + ", " + Math.round(pair.share * 100) + "%"));
        together.appendChild(row);
      });
      brief.appendChild(together);
    }

    if (b.externalPackages.length) {
      var ext = section(tr("External packages"), String(b.externalPackages.length));
      ext.appendChild(list(b.externalPackages));
      brief.appendChild(ext);
    }

    if (b.endpoints.length) {
      var served = section(tr("Endpoints it serves (C#)"), String(b.endpoints.length));
      if (b.endpoints.length < 30) served.appendChild(list(b.endpoints));
      else {
        // Many endpoints: grouped by the first part of the route, with a filter.
        var filter = el("input"); filter.placeholder = tr("Filter: route or handler");
        served.appendChild(filter);
        var groupsBox = el("div");
        var byPrefix = {};
        b.endpoints.forEach(function (endpoint) {
          var route = endpoint.split(" ")[1] || "";
          var prefix = "/" + (route.split("/")[1] || "");
          (byPrefix[prefix] = byPrefix[prefix] || []).push(endpoint);
        });
        var renderGroups = function () {
          var needle = filter.value.trim().toLowerCase();
          groupsBox.innerHTML = "";
          Object.keys(byPrefix).sort().forEach(function (prefix) {
            var items = byPrefix[prefix].filter(function (endpoint) { return !needle || endpoint.toLowerCase().indexOf(needle) >= 0; });
            if (!items.length) return;
            var det = el("details");
            if (needle) det.open = true;
            det.appendChild(el("summary", null, prefix + " (" + items.length + ")"));
            det.appendChild(list(items));
            groupsBox.appendChild(det);
          });
        };
        filter.addEventListener("input", renderGroups);
        renderGroups();
        served.appendChild(groupsBox);
      }
      brief.appendChild(served);
    }
    if (b.loadedBy.length) {
      var loaded = section(tr("Loaded by pages"), String(b.loadedBy.length));
      loaded.appendChild(list(b.loadedBy.slice(0, 30).concat(b.loadedBy.length > 30 ? [tr("… {n} more", { n: b.loadedBy.length - 30 })] : [])));
      if (b.scriptFiles) loaded.appendChild(el("div", "empty", trn(b.scriptFiles, "{n} classic script: its globals are this block's API.", "{n} classic scripts: their globals are this block's API.")));
      brief.appendChild(loaded);
    }
    if (b.httpEndpoints.length || b.dynamicHttpCalls) {
      var http = section(tr("Calls to the backend"), String(b.httpEndpoints.length));
      if (b.httpEndpoints.length) http.appendChild(list(b.httpEndpoints));
      if (b.dynamicHttpCalls) http.appendChild(el("div", "empty", trn(b.dynamicHttpCalls, "{n} more call builds the whole URL at run time (see .cantus/analysis.log).", "{n} more calls build the whole URL at run time (see .cantus/analysis.log).")));
      brief.appendChild(http);
    }

    var run = section(tr("Use it with your coding agent"));
    run.appendChild(el("code", "cmd", "block-" + b.id + " " + tr("subagent (cantus agents)")));
    run.appendChild(el("code", "cmd", "cantus context " + b.id));
    brief.appendChild(run);
  }




  // ---- Inside a block: its files as cards, the links between them, and what each one has to do with other blocks.
  function blockOfPath(file) {
    for (var i = 0; i < data.blocks.length; i++) {
      if (data.blocks[i].files.some(function (f) { return f.path === file; })) return data.blocks[i];
    }
    return null;
  }
  function baseName(file) { return file.split("/").pop(); }
  function dirName(file) { var parts = file.split("/"); parts.pop(); return parts.join("/") || "."; }

  function zoomInto(blockId) {
    var b = byId[blockId];
    if (!b) return;
    zoomBlock = blockId; selectedFile = null; selected = blockId; multi = []; view = "zoom"; openTask = null; openPanel();
    setHash("zoom=" + blockId);
    lanes.style.display = "none"; // the lanes' display:flex would override the hidden attribute
    document.getElementById("canvas").scrollTop = 0;
    var zoom = document.getElementById("zoom");
    zoom.hidden = false;
    zoom.innerHTML = "";
    fileCards = {};
    var inBlock = {};
    b.files.forEach(function (f) { inBlock[f.path] = true; });
    var internal = data.fileLinks.filter(function (l) { return inBlock[l.from] && inBlock[l.to]; });

    // Rows by dependency: files nothing in the block uses on top, what they use below.
    var depth = {};
    function depthOf(file, seen) {
      if (depth[file] !== undefined) return depth[file];
      if (seen[file]) return 0;
      seen[file] = true;
      var importers = internal.filter(function (l) { return l.to === file; });
      var d = importers.length ? 1 + Math.max.apply(null, importers.map(function (l) { return depthOf(l.from, seen); })) : 0;
      depth[file] = d;
      return d;
    }
    b.files.forEach(function (f) { depthOf(f.path, {}); });
    var rows = [];
    b.files.forEach(function (f) { (rows[depth[f.path]] = rows[depth[f.path]] || []).push(f); });

    var head = el("div", "zoom-head");
    var back = el("button", null, tr("← All blocks"));
    back.addEventListener("click", zoomOut);
    head.appendChild(back);
    head.appendChild(el("h2", null, b.name));
    head.appendChild(el("span", "sub", trn(b.files.length, "{n} file", "{n} files") + " · " + trn(internal.length, "{n} link", "{n} links") + " " + tr("inside · arrows go from the file that uses to the file used")));
    zoom.appendChild(head);
    var box = el("div", "file-rows");
    rows.forEach(function (row) {
      if (!row) return;
      var line = el("div", "file-row-cards");
      row.forEach(function (f) { line.appendChild(fileCard(b, f)); });
      box.appendChild(line);
    });
    zoom.appendChild(box);
    drawEdges();
    renderPanel(b);
    var panel = document.getElementById("panel");
    panel.querySelector(".kicker").textContent = tr("Inside the block · click a file");
  }

  /** The file itself, raw or as a diff, with Open in VS Code: a changed file as the user last looked at it, any other as it is. */
  function openFile(file) { openFileView(file, data.changes.files[file] ? undefined : "file"); }

  function fileCard(b, f) {
    var card = el("div", "file-card");
    var open = el("button", "file-open", tr("Open"));
    open.title = tr("Open the file: raw or as a diff, with Open in VS Code");
    open.addEventListener("click", function (event) { event.stopPropagation(); openFile(f.path); });
    card.appendChild(open);
    card.appendChild(el("h3", null, baseName(f.path)));
    card.appendChild(el("div", "sub", dirName(f.path) + " · " + tok(f.tokens)));
    var badges = el("div", "badges");
    var exports = b.api.filter(function (e) { return e.file === f.path; });
    if (exports.length) badges.appendChild(el("span", "badge", trn(exports.length, "{n} export", "{n} exports")));
    var callers = exports.reduce(function (sum, e) { return sum + e.callers; }, 0);
    if (callers) badges.appendChild(el("span", "badge hot", tr("← {n} from outside", { n: callers })));
    var changeTag = fileChangeTag(f.path);
    if (changeTag) badges.appendChild(changeTag);
    card.appendChild(badges);
    var outside = {};
    data.fileLinks.forEach(function (l) {
      if (l.from !== f.path) return;
      var target = blockOfPath(l.to);
      if (target && target.id !== b.id) outside[target.name] = true;
    });
    var names = Object.keys(outside);
    if (names.length) card.appendChild(el("div", "out", "→ " + names.join(", ")));
    card.addEventListener("click", function () { selectFile(b, f.path); });
    fileCards[f.path] = card;
    return card;
  }

  function selectFile(b, file) {
    selectedFile = file;
    var related = {};
    related[file] = true;
    data.fileLinks.forEach(function (l) { if (l.from === file) related[l.to] = true; if (l.to === file) related[l.from] = true; });
    Object.keys(fileCards).forEach(function (k) { fileCards[k].className = "file-card" + (k === file ? " selected" : related[k] ? "" : " faded"); });
    drawEdges();
    var panel = document.getElementById("panel");
    panel.innerHTML = "";
    panel.appendChild(el("div", "kicker", tr("File · {name}", { name: b.name })));
    panel.appendChild(el("h1", null, baseName(file)));
    panel.appendChild(el("div", "desc", file));
    var exports = b.api.filter(function (e) { return e.file === file; });
    var api = section(tr("What it offers"), String(exports.length));
    if (!exports.length) api.appendChild(el("div", "empty", tr("Nothing exported.")));
    exports.forEach(function (entry) {
      var row = el("div", "api-entry");
      var headLine = el("div", "api-head");
      headLine.appendChild(el("span", "kind " + entry.kind, entry.kind));
      headLine.appendChild(el("b", null, entry.name));
      headLine.appendChild(el("span", "tag" + (entry.callers ? " used" : ""), entry.callers ? trn(entry.callers, "{n} caller outside", "{n} callers outside") : tr("not used outside")));
      row.appendChild(headLine);
      row.appendChild(el("code", "signature", entry.signature));
      if (entry.doc) row.appendChild(el("div", "empty", entry.doc));
      api.appendChild(row);
    });
    panel.appendChild(api);
    function links(title, list, other) {
      var box = section(title, String(list.length));
      if (!list.length) box.appendChild(el("div", "empty", tr("None.")));
      list.forEach(function (l) {
        var row = el("div", "diag");
        var target = other(l);
        var owner = blockOfPath(target);
        row.appendChild(el("span", "where", target + " "));
        row.appendChild(el("span", null, (owner && owner.id !== b.id ? "(" + owner.name + ") " : "") + l.symbols.join(", ")));
        box.appendChild(row);
      });
      return box;
    }
    panel.appendChild(links(tr("Uses"), data.fileLinks.filter(function (l) { return l.from === file; }), function (l) { return l.to; }));
    panel.appendChild(links(tr("Used by"), data.fileLinks.filter(function (l) { return l.to === file; }), function (l) { return l.from; }));
    var openIt = el("button", null, tr("Open"));
    openIt.title = tr("Open the file: raw or as a diff, with Open in VS Code");
    openIt.addEventListener("click", function () { openFile(file); });
    panel.appendChild(openIt);
    var backLink = el("button", null, tr("Back to the block"));
    backLink.addEventListener("click", function () { zoomInto(b.id); });
    panel.appendChild(backLink);
  }

  /** Back to the map of blocks, without choosing what to show. */
  function leaveZoom() {
    fromChanges = false;
    if (statsOpen) {
      statsOpen = false;
      document.getElementById("statsview").hidden = true;
      document.getElementById("statsview").innerHTML = "";
      lanes.style.display = "";
    }
    if (changesOpen) {
      changesOpen = false;
      document.getElementById("changesview").hidden = true;
      document.getElementById("changesview").innerHTML = "";
      lanes.style.display = "";
    }
    if (fileViewOpen) {
      fileViewOpen = false;
      fileNav = null;
      lineActions = null;
      document.getElementById("fileview").hidden = true;
      document.getElementById("fileview").innerHTML = "";
      if (!zoomBlock) lanes.style.display = "";
    }
    markTabs();
    if (!zoomBlock) return;
    zoomBlock = null; selectedFile = null; fileCards = {};
    document.getElementById("zoom").hidden = true;
    document.getElementById("zoom").innerHTML = "";
    lanes.style.display = "";
  }

  function zoomOut() {
    var id = zoomBlock;
    leaveZoom();
    if (id) select(id); else clearSelection();
  }

  function drawFileEdges() {
    var canvas = document.getElementById("canvas");
    svg.setAttribute("width", canvas.scrollWidth); svg.setAttribute("height", canvas.scrollHeight);
    var defs = document.createElementNS(NS, "defs");
    defs.appendChild(marker("m-file", "var(--muted)"));
    defs.appendChild(marker("m-file-active", "var(--blue)"));
    svg.appendChild(defs);
    var base = canvas.getBoundingClientRect();
    function box(file) {
      var r = fileCards[file].getBoundingClientRect();
      return { x: r.left - base.left + canvas.scrollLeft, y: r.top - base.top + canvas.scrollTop, w: r.width, h: r.height };
    }
    data.fileLinks.forEach(function (l) {
      if (!fileCards[l.from] || !fileCards[l.to]) return;
      var a = box(l.from), b = box(l.to);
      var active = selectedFile && (l.from === selectedFile || l.to === selectedFile);
      var sameRow = Math.abs(a.y - b.y) < 5;
      var x1 = a.x + a.w / 2, y1 = sameRow ? a.y + a.h / 2 : a.y + a.h, x2 = b.x + b.w / 2, y2 = sameRow ? b.y + b.h / 2 : b.y - 2;
      if (sameRow) { x1 = a.x + (b.x > a.x ? a.w : 0); x2 = b.x + (b.x > a.x ? -2 : b.w + 2); }
      var path = document.createElementNS(NS, "path");
      var mid = (y1 + y2) / 2;
      path.setAttribute("d", sameRow ? "M" + x1 + "," + y1 + " L" + x2 + "," + y2 : "M" + x1 + "," + y1 + " C" + x1 + "," + mid + " " + x2 + "," + mid + " " + x2 + "," + y2);
      path.setAttribute("fill", "none");
      path.style.stroke = active ? "var(--blue)" : "var(--muted)";
      path.setAttribute("stroke-width", active ? "2" : "1.3");
      path.setAttribute("opacity", selectedFile && !active ? "0.25" : "0.9");
      if (l.kind === "call") path.setAttribute("stroke-dasharray", "5 4");
      path.setAttribute("marker-end", "url(#" + (active ? "m-file-active" : "m-file") + ")");
      var title = document.createElementNS(NS, "title");
      title.textContent = l.symbols.join(", ");
      path.appendChild(title);
      svg.appendChild(path);
    });
  }


  // ---- Exports that changed since the last commit, and who relies on them.
  function apiChangeList(list) {
    var box = el("div", "api-changes");
    list.forEach(function (c) {
      var row = el("div", "diag");
      var label = c.kind === "removed" ? tr("removed") : c.kind === "added" ? tr("new") : tr("changed");
      row.appendChild(el("span", "badge " + (c.kind === "added" ? "" : c.callerCount ? "warn" : ""), label));
      row.appendChild(document.createTextNode(" "));
      row.appendChild(el("code", null, c.name));
      if (c.kind === "changed") row.appendChild(el("div", "sub", (c.before || "").replace(/\\s+/g, " ") + "  →  " + (c.after || "").replace(/\\s+/g, " ")));
      if (c.kind !== "added") {
        var who = el("div", "sub", c.callerCount ? trn(c.callerCount, "{n} call site in other blocks", "{n} call sites in other blocks") + ": " + c.callers.map(function (s) { return s.file + ":" + s.line + (s.match === "by-name" ? " (" + tr("by name only") + ")" : ""); }).join(", ") + (c.callerCount > c.callers.length ? ", …" : "") : tr("No call site in other blocks."));
        row.appendChild(who);
      }
      box.appendChild(row);
    });
    return box;
  }

  function showApiChanges() {
    leaveZoom();
    view = "api"; openTask = null; openPanel();
    setHash("api");
    var panel = document.getElementById("panel");
    panel.innerHTML = "";
    panel.appendChild(el("div", "kicker", tr("Since the last commit")));
    panel.appendChild(el("h1", null, tr("API changes")));
    panel.appendChild(el("p", "empty", tr("Exports changed, removed or added in the uncommitted work. Changed and removed ones list the code in other blocks that uses them: update it, or keep the old form.")));
    var files = [];
    data.apiChanges.forEach(function (c) { if (files.indexOf(c.file) < 0) files.push(c.file); });
    files.forEach(function (file) {
      var sec = section(file);
      var open = el("a", "change-link", tr("See the changes"));
      open.addEventListener("click", function () { openFileView(file); });
      sec.appendChild(open);
      sec.appendChild(apiChangeList(data.apiChanges.filter(function (c) { return c.file === file; })));
      panel.appendChild(sec);
    });
  }

  // ---- What went wrong while reading the project, by cause: what it is, where, and what to do.
  function problemText(code) {
    if (code === "syntax-error") return { title: tr("Code that cannot be parsed"), why: tr("The parser stops at these places, so the imports and exports of the file are missing from the map."), action: tr("Fix the syntax at the line shown. If the code is valid, report it as a Cantus bug.") };
    if (code === "declarations-blocked") return { title: tr("Types Cantus cannot write down"), why: tr("The compiler cannot describe the type of these exports, so the contract of their block (its API as the agents see it) is partial."), action: tr("Give the export at the line shown an explicit type, naming the type it comes from (for a library type: import it with 'import type', then annotate with it).") };
    if (code === "missing-package") return { title: tr("Packages that are not installed"), why: tr("The code imports packages that cannot be found in node_modules, so their types are unknown and the compiler guesses."), action: tr("Install the project's dependencies (for example 'pnpm install'), then analyze again.") };
    if (code === "unresolved-path") return { title: tr("Imports that lead to no file"), why: tr("These imports point to a path or an alias that does not resolve to a file of the project, so they are not arrows on the map."), action: tr("Check the path: the file may have been renamed, or the alias is not in the tsconfig.json 'paths' closest to the file.") };
    if (code === "tsconfig") return { title: tr("A configuration the compiler does not accept"), why: tr("Cantus reads types with the project's own TypeScript and its tsconfig.json, and the compiler rejects part of it."), action: tr("Fix the option named, or leave it: it only affects how precisely types are read.") };
    if (code === "tool-failed") return { title: tr("A tool Cantus relies on failed"), why: tr("A reader or a compiler did not run or did not finish, so part of the code is in the map by file only."), action: tr("Reinstall Cantus, or the project's TypeScript if the compiler is the one named. If it persists, report it with .cantus/analysis.log.") };
    if (code === "compiler-types") return { title: tr("Type errors the compiler reported"), why: tr("These come from the compiler Cantus uses to read types. They are not Cantus's checks and the map does not depend on them."), action: tr("Your editor or 'tsc' shows them with more context. Nothing to do for the map.") };
    return { title: tr("Other problems"), why: tr("Problems Cantus has no explanation for yet."), action: tr("Read the message; the full log is .cantus/analysis.log.") };
  }
  function problemGroup(g) {
    var text = problemText(g.code);
    var body = el("div");
    body.appendChild(el("div", "empty", text.why));
    var box = el("div");
    g.items.forEach(function (item) {
      var row = el("div", "diag " + item.level);
      if (item.file) {
        var place = item.file + (item.line ? ":" + item.line + (item.column ? ":" + item.column : "") : "");
        if (live) { var link = el("a", "where", place + " "); link.href = editorUrl(item.file, item.line); link.title = tr("Open in VS Code"); row.appendChild(link); }
        else row.appendChild(el("span", "where", place + " "));
      }
      row.appendChild(el("span", null, item.text));
      if (item.detail) { var det = el("details"); det.appendChild(el("summary", null, tr("details"))); det.appendChild(el("pre", null, item.detail)); row.appendChild(det); }
      box.appendChild(row);
    });
    body.appendChild(box);
    body.appendChild(el("div", "sub", tr("What to do: {action}", { action: text.action })));
    return { title: text.title, body: body };
  }
  function showProblems() {
    leaveZoom();
    view = "problems"; openTask = null; openPanel();
    setHash("problems");
    var panel = document.getElementById("panel");
    panel.innerHTML = "";
    panel.appendChild(el("div", "kicker", tr("Analysis")));
    panel.appendChild(el("h1", null, tr("Analysis problems")));
    panel.appendChild(el("p", "empty", tr("What Cantus could not read or check while analyzing the project. Each group says what it is and what to do; the full log is {path}.", { path: ".cantus/analysis.log" })));
    if (!data.problems.length) panel.appendChild(el("p", "empty", tr("No problems while reading the project.")));
    [["yours", tr("To fix in your code")], ["setup", tr("To check in your setup")], ["cantus", tr("Cantus limits, nothing to do")]].forEach(function (entry) {
      var groups = data.problems.filter(function (g) { return g.who === entry[0]; });
      if (!groups.length) return;
      panel.appendChild(el("div", "kicker", entry[1]));
      groups.forEach(function (g) {
        var made = problemGroup(g);
        if (entry[0] === "cantus") {
          var fold = el("details");
          fold.appendChild(el("summary", null, made.title + " · " + trn(g.items.length, "{n} problem", "{n} problems")));
          fold.appendChild(made.body);
          panel.appendChild(fold);
        } else {
          var sec = section(made.title, trn(g.items.length, "{n} problem", "{n} problems"));
          sec.appendChild(made.body);
          panel.appendChild(sec);
        }
      });
    });
  }

  // ---- How the briefings and tools were used (live only): where a note or a change in the map would help.
  var statsDays = 30;
  function showStats() {
    leaveZoom();
    statsOpen = true;
    view = "stats"; openTask = null; selected = null; multi = []; openPanel();
    setHash("stats");
    Object.keys(cards).forEach(function (k) { cards[k].className = "card"; });
    lanes.style.display = "none";
    var box = document.getElementById("statsview");
    box.hidden = false;
    box.innerHTML = "";
    document.getElementById("canvas").scrollTop = 0;
    markTabs();
    drawEdges();
    box.appendChild(el("h2", "title", tr("How Cantus was used")));
    box.appendChild(el("div", "sub", tr("What the agents asked of Cantus and did in this project, from the log on this machine. Token sizes are estimates.")));
    var periods = el("div", "periods");
    [7, 30, 90].forEach(function (days) {
      var button = el("button", days === statsDays ? "on" : "", trn(days, "{n} day", "{n} days"));
      button.addEventListener("click", function () { statsDays = days; showStats(); });
      periods.appendChild(button);
    });
    box.appendChild(periods);
    var body = el("div");
    box.appendChild(body);
    body.appendChild(el("p", "empty", tr("Reading the log…")));
    api("GET", "/api/stats?days=" + statsDays).then(function (stats) {
      if (!statsOpen) return;
      body.innerHTML = "";
      renderStats(body, stats);
    }).catch(function (error) {
      body.innerHTML = "";
      body.appendChild(el("p", "empty", error.message));
    });
    var panel = document.getElementById("panel");
    panel.innerHTML = "";
    panel.appendChild(el("div", "kicker", tr("Monitoring")));
    panel.appendChild(el("h1", null, tr("Statistics")));
    panel.appendChild(el("p", "empty", tr("It shows where a note, a context file or a change to the map would spare the agents a detour, and whether the briefings need tuning. Cantus records tool names, paths, sizes and the words of find_api searches, never prompts or file contents; CANTUS_STATS=off turns it off.")));
  }

  function blockName(id) { return byId[id] ? byId[id].name : id; }
  function adviceLine(item) {
    var name = blockName(item.block || "");
    if (item.kind === "outside-read") return trn(item.count, "{block}: its specialists opened {file} ({where}) {n} time. Say in a note of the block what is there that the briefing does not give.", "{block}: its specialists opened {file} ({where}) {n} times. Say in a note of the block what is there that the briefing does not give.", { block: name, file: item.file, where: item.ownedBy ? tr("block {owner}", { owner: blockName(item.ownedBy) }) : tr("in no block") });
    if (item.kind === "outside-edit") return trn(item.count, "{block}: {n} edit by its specialists outside the block. Its paths may be too narrow, or a neighbor is missing from the map.", "{block}: {n} edits by its specialists outside the block. Its paths may be too narrow, or a neighbor is missing from the map.", { block: name });
    if (item.kind === "always-shortened") return tr("{block}: every briefing was shortened (up to {tokens} tokens). Split the block, or list what it uses more narrowly.", { block: name, tokens: fmt(item.max) });
    if (item.kind === "no-briefing") return tr("{block}: {edits} edits and no briefing asked for. The agents work there without Cantus's context: check that the instructions reach them.", { block: name, edits: item.edits });
    if (item.kind === "search-miss") return trn(item.count, "Searching find_api for \\"{query}\\" found nothing {n} time. A description or a note that uses those words would help, or the term lives in another language.", "Searching find_api for \\"{query}\\" found nothing {n} times. A description or a note that uses those words would help, or the term lives in another language.", { query: item.query });
    return trn(item.count, "{block}: map tasks asked {n} time to write outside their scope. Check the block's paths.", "{block}: map tasks asked {n} times to write outside their scope. Check the block's paths.", { block: name });
  }

  function statsGroup(parent, title) {
    var group = el("div", "group");
    group.appendChild(el("h3", null, title));
    parent.appendChild(group);
    return group;
  }

  function renderStats(body, stats) {
    if (!stats.events && !stats.tasks.count) {
      body.appendChild(el("p", "empty", tr("Nothing recorded in this period. Cantus logs the briefings, searches, edits and reads of your agents once the MCP server or the hooks run in a session.")));
      return;
    }
    var advice = statsGroup(body, tr("Where to add context"));
    if (stats.advice.length) {
      var ul = el("ul", "advice");
      stats.advice.forEach(function (item) { ul.appendChild(el("li", null, adviceLine(item))); });
      advice.appendChild(ul);
    } else {
      advice.appendChild(el("p", "empty", tr("Nothing stands out yet. The advice appears when the same detour happens three times.")));
      advice.lastChild.style.padding = "8px 14px";
    }

    var active = stats.blocks.filter(function (b) { return b.briefings || b.edits || b.outsideReads.length || stats.tasks.outsideScope[b.id]; });
    if (active.length) {
      var table = el("table");
      var head = el("tr");
      [tr("Block"), tr("Briefings"), tr("Avg tokens"), tr("Max tokens"), tr("Shortened"), tr("Edits"), tr("Outside"), tr("Notes"), tr("Broken")].forEach(function (label) { head.appendChild(el("th", null, label)); });
      table.appendChild(head);
      active.forEach(function (b) {
        var row = el("tr");
        var name = el("td", byId[b.id] ? "link" : "", blockName(b.id));
        if (byId[b.id]) name.addEventListener("click", function () { select(b.id); });
        row.appendChild(name);
        [b.briefings, b.briefingTokens.average, b.briefingTokens.max, b.shortened, b.edits, b.outsideEdits, b.notes, b.broken].forEach(function (n, index) {
          var cell = el("td", (index === 5 || index === 7) && n ? "warn" : "", String(n));
          if (index === 1 || index === 2) cell.textContent = fmt(n);
          row.appendChild(cell);
        });
        table.appendChild(row);
      });
      var blocks = statsGroup(body, tr("Blocks"));
      var scroll = el("div", "tscroll");
      scroll.appendChild(table);
      blocks.appendChild(scroll);
      var legend = el("p", "empty", tr("Shortened: briefings cut down to fit the limit (giving the exports used instead of whole files is normal and not counted). Outside: edits by the block's specialists outside it. Notes: edits for which the hook had a note. Broken: references an edit left broken."));
      legend.style.padding = "6px 14px 8px";
      blocks.appendChild(legend);
    }

    var reads = [];
    stats.blocks.forEach(function (b) { b.outsideReads.forEach(function (read) { reads.push({ agentBlock: b.id, file: read.file, ownedBy: read.ownedBy, count: read.count }); }); });
    reads.sort(function (a, b) { return b.count - a.count; });
    if (reads.length) {
      var readGroup = statsGroup(body, tr("Files specialists opened outside their block"));
      reads.slice(0, 10).forEach(function (read) {
        var line = el("div", "srow");
        line.appendChild(el("span", "path", blockName(read.agentBlock) + " → " + read.file + (read.ownedBy ? " (" + blockName(read.ownedBy) + ")" : "")));
        line.appendChild(el("span", "n", "×" + read.count));
        readGroup.appendChild(line);
      });
    }
    if (stats.misses.length) {
      var missGroup = statsGroup(body, tr("Searches that found nothing"));
      stats.misses.slice(0, 10).forEach(function (miss) {
        var line = el("div", "srow");
        line.appendChild(el("span", "path", miss.query));
        line.appendChild(el("span", "n", "×" + miss.count));
        missGroup.appendChild(line);
      });
    }
    var tools = Object.keys(stats.tools).sort(function (a, b) { return stats.tools[b].calls - stats.tools[a].calls; });
    if (tools.length) {
      var toolTable = el("table");
      var toolHead = el("tr");
      [tr("Tool"), tr("Calls"), tr("Failed"), tr("Tokens per answer")].forEach(function (label) { toolHead.appendChild(el("th", null, label)); });
      toolTable.appendChild(toolHead);
      tools.forEach(function (tool) {
        var t = stats.tools[tool];
        var row = el("tr");
        row.appendChild(el("td", null, tool));
        row.appendChild(el("td", null, String(t.calls)));
        row.appendChild(el("td", t.errors ? "warn" : "", String(t.errors)));
        row.appendChild(el("td", null, fmt(Math.round(t.tokens / t.calls))));
        toolTable.appendChild(row);
      });
      var toolScroll = el("div", "tscroll");
      toolScroll.appendChild(toolTable);
      statsGroup(body, tr("Tools")).appendChild(toolScroll);
    }
    if (stats.tasks.count) {
      var taskGroup = statsGroup(body, tr("Tasks from the map"));
      var models = Object.keys(stats.tasks.byModel).map(function (m) { return (m === "default" ? tr("default model") : m) + " " + stats.tasks.byModel[m].count + " ($" + stats.tasks.byModel[m].costUsd.toFixed(2) + ")"; }).join(", ");
      var line = el("div", "srow");
      line.appendChild(el("span", "path", trn(stats.tasks.count, "{n} task", "{n} tasks") + " · $" + stats.tasks.costUsd.toFixed(2) + " · " + trn(stats.tasks.delegations, "{n} delegation", "{n} delegations") + " · " + models));
      taskGroup.appendChild(line);
    }
  }

  // ---- Every file changed since the last commit, by block; a click opens the file's diff.
  function showChanges() {
    leaveZoom();
    changesOpen = true;
    view = "changes"; openTask = null; selected = null; multi = []; openPanel();
    setHash("changes");
    Object.keys(cards).forEach(function (k) { cards[k].className = "card"; });
    lanes.style.display = "none";
    var box = document.getElementById("changesview");
    box.hidden = false;
    box.innerHTML = "";
    document.getElementById("canvas").scrollTop = 0;
    markTabs();
    drawEdges();
    var files = Object.keys(data.changes.files);
    box.appendChild(el("h2", "title", tr("Changed since the last commit")));
    var summary = el("div", "sub");
    summary.appendChild(document.createTextNode(trn(files.length, "{n} file", "{n} files") + " · "));
    summary.appendChild(el("span", "plus", "+" + data.changes.added));
    summary.appendChild(document.createTextNode(" "));
    summary.appendChild(el("span", "minus", "−" + data.changes.removed));
    summary.appendChild(document.createTextNode(" · " + (live ? tr("staged, unstaged and new files. A commit empties the list.") : tr("static export: open the live map to see the diffs."))));
    box.appendChild(summary);
    if (!files.length) box.appendChild(el("p", "empty", tr("Nothing changed since the last commit.")));
    var grouped = changedByBlock();
    var groups = grouped.groups;
    grouped.ranked.forEach(function (key) {
      var group = el("div", "group");
      var head = el("h3");
      head.appendChild(el("span", null, key ? byId[key].name : tr("Outside the blocks")));
      var list = groups[key];
      head.appendChild(changeBadge(list.reduce(function (sum, f) { return sum + data.changes.files[f].added; }, 0), list.reduce(function (sum, f) { return sum + data.changes.files[f].removed; }, 0)));
      group.appendChild(head);
      list.forEach(function (file) { group.appendChild(changedRow(file)); });
      box.appendChild(group);
    });
    var panel = document.getElementById("panel");
    panel.innerHTML = "";
    panel.appendChild(el("div", "kicker", tr("Since the last commit")));
    panel.appendChild(el("h1", null, tr("Changed files")));
    panel.appendChild(el("p", "empty", tr("Grouped by block. Open a file to see its diff; lines an agent wrote while the map was open are marked.")));
    var breaking = data.apiChanges.filter(function (c) { return c.kind !== "added" && c.callerCount > 0; });
    if (breaking.length) {
      var api = section(tr("API to check"), String(breaking.length));
      api.appendChild(apiChangeList(breaking));
      panel.appendChild(api);
    }
  }

  /** The changed files by block, in the order the Changes tab lists them: the blocks as on the map, then what no block owns. */
  function changedByBlock() {
    var groups = {};
    Object.keys(data.changes.files).sort().forEach(function (file) {
      var key = data.changes.files[file].block || "";
      if (!groups[key]) groups[key] = [];
      groups[key].push(file);
    });
    var ranked = data.blocks.map(function (b) { return b.id; }).filter(function (id) { return groups[id]; }).concat(groups[""] ? [""] : []);
    var flat = [];
    ranked.forEach(function (key) { groups[key].forEach(function (file) { flat.push(file); }); });
    return { groups: groups, ranked: ranked, flat: flat };
  }

  function changedRow(file) {
    var change = data.changes.files[file];
    var row = el("div", "frow" + (live ? " open" : ""));
    var letter = change.status === "added" ? "A" : change.status === "deleted" ? "D" : "M";
    var st = el("span", "st " + change.status, letter);
    st.title = change.status === "added" ? tr("New file") : change.status === "deleted" ? tr("Deleted") : tr("Modified");
    row.appendChild(st);
    var pathBox = el("span", "path");
    var dir = dirName(file);
    if (dir !== ".") pathBox.appendChild(el("i", null, dir + "/"));
    pathBox.appendChild(el("b", null, baseName(file)));
    row.appendChild(pathBox);
    var calls = data.apiChanges.filter(function (c) { return c.file === file && c.kind !== "added" && c.callerCount > 0; }).reduce(function (sum, c) { return sum + c.callerCount; }, 0);
    if (calls) {
      var warn = el("span", "tag warn", "API · " + trn(calls, "{n} call site", "{n} call sites"));
      warn.title = tr("Exports of this file changed or removed that other blocks use");
      row.appendChild(warn);
    }
    if (change.agents && change.agents.length) {
      var who = el("span", "tag", change.agents.length > 1 ? trn(change.agents.length, "{n} agent", "{n} agents") : change.agents[0]);
      who.title = tr("Lines written by {names} while this map was open", { names: change.agents.join(", ") });
      row.appendChild(who);
    }
    if (change.binary) row.appendChild(el("span", "badge chg", change.status === "added" ? tr("new · binary") : tr("binary changed")));
    else row.appendChild(changeBadge(change.added, change.removed));
    if (live) row.addEventListener("click", function () { openFileView(file, undefined, true); });
    return row;
  }

  // ---- A file against the last commit: as it is now with the changes marked, or as a diff.
  // Open a line in VS Code, or ask the open Claude Code session about it; set while a file is shown.
  var lineActions = null;
  function editorUrl(file, line) {
    var full = (live.root + "/" + file).replace(/\\\\/g, "/");
    return "vscode://file" + (full.charAt(0) === "/" ? "" : "/") + encodeURI(full).replace(/#/g, "%23").replace(/\\?/g, "%3F") + (line ? ":" + line : "");
  }
  /** Two small buttons over the line number of a line that exists in the file as it is now. */
  function addLineActions(line, op) {
    if (!lineActions || !op || op.type === "del" || !op.newLine) return;
    var cell = line.querySelector(".no");
    if (!cell) return;
    var acts = el("span", "acts");
    if (lineActions.url) {
      var open = el("a", "act", "↗");
      open.href = lineActions.url(op.newLine);
      open.title = tr("Open this line in VS Code");
      acts.appendChild(open);
    }
    if (lineActions.ask) {
      var ask = el("span", "act", "✎");
      ask.title = tr("Ask Claude about this line (or about the lines you selected)");
      ask.addEventListener("click", function (event) { event.stopPropagation(); lineActions.ask(op.newLine); });
      acts.appendChild(ask);
    }
    cell.appendChild(acts);
  }

  var FILE_MODES = ["diff", "side", "file"];
  function savedMode() {
    try { var m = localStorage.getItem("cantus-file-mode"); if (FILE_MODES.indexOf(m) >= 0) return m; } catch (error) { /* private mode */ }
    return "diff";
  }
  function saveMode(m) { try { localStorage.setItem("cantus-file-mode", m); } catch (error) { /* private mode */ } }
  function savedMarks() { try { return localStorage.getItem("cantus-file-marks") === "1"; } catch (error) { return false; } }
  function saveMarks(on) { try { localStorage.setItem("cantus-file-marks", on ? "1" : "0"); } catch (error) { /* private mode */ } }
  var fileNav = null;

  function openFileView(file, mode, fromList) {
    var from = fromList || changesOpen ? { changes: true } : zoomBlock ? { zoom: zoomBlock } : { block: selected || (blockOfPath(file) || {}).id };
    leaveZoom();
    fileViewOpen = true;
    fromChanges = !!from.changes;
    markTabs();
    lanes.style.display = "none";
    var box = document.getElementById("fileview");
    box.hidden = false;
    box.innerHTML = "";
    document.getElementById("canvas").scrollTop = 0;
    setHash((from.changes ? "changes=" : "file=") + encodeURIComponent(file));
    drawEdges();
    var current = mode || savedMode();
    var host = box;
    var order = from.changes ? changedByBlock().flat : [];
    var at = order.indexOf(file);
    if (from.changes && order.length > 1 && at >= 0) {
      // Reviewing: the changed files at the side, previous and next, keys p and n.
      var split = el("div", "fv-split");
      var list = el("div", "fv-list");
      var grouped = changedByBlock();
      grouped.ranked.forEach(function (key) {
        list.appendChild(el("div", "fv-group", key ? byId[key].name : tr("Outside the blocks")));
        grouped.groups[key].forEach(function (f) {
          var c = data.changes.files[f];
          var item = el("div", "fv-item" + (f === file ? " on" : ""));
          item.title = f;
          item.appendChild(el("span", "st " + c.status, c.status === "added" ? "A" : c.status === "deleted" ? "D" : "M"));
          item.appendChild(el("span", "nm", baseName(f)));
          item.appendChild(changeBadge(c.added, c.removed));
          item.addEventListener("click", function () { if (f !== file) openFileView(f, current, true); });
          list.appendChild(item);
        });
      });
      host = el("div", "fv-main");
      split.appendChild(list);
      split.appendChild(host);
      box.appendChild(split);
      var active = list.querySelector(".fv-item.on");
      if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
      fileNav = function (delta) {
        var next = order[(at + delta + order.length) % order.length];
        openFileView(next, current, true);
      };
    }
    var head = el("div", "zoom-head");
    var back = el("button", null, tr("← Back"));
    back.addEventListener("click", function () {
      if (from.changes) return showChanges();
      leaveZoom();
      if (from.zoom) zoomInto(from.zoom); else if (from.block && byId[from.block]) select(from.block); else clearSelection();
    });
    head.appendChild(back);
    head.appendChild(el("h2", null, file));
    var change = data.changes.files[file];
    if (change) head.appendChild(changeBadge(change.added, change.removed));
    var buttons = {};
    [["diff", tr("Diff")], ["side", tr("Side by side")], ["file", tr("File")]].forEach(function (m) {
      var button = el("button", null, m[1]);
      buttons[m[0]] = button;
      button.addEventListener("click", function () { saveMode(m[0]); show(m[0]); });
      head.appendChild(button);
    });
    var marks = el("label", "marks");
    var marksBox = document.createElement("input");
    marksBox.type = "checkbox";
    marksBox.checked = savedMarks();
    marks.appendChild(marksBox);
    marks.appendChild(document.createTextNode(" " + tr("mark changes")));
    marksBox.addEventListener("change", function () { saveMarks(marksBox.checked); show("file"); });
    head.appendChild(marks);
    head.appendChild(el("span", "empty", tr("against the last commit")));
    var note = el("span", "agent-note");
    head.appendChild(note);
    if (fileNav) {
      var nav = el("span", "fv-nav");
      var prev = el("button", null, "‹"), next = el("button", null, "›");
      prev.title = tr("Previous changed file (p)"); next.title = tr("Next changed file (n)");
      prev.addEventListener("click", function () { fileNav(-1); });
      next.addEventListener("click", function () { fileNav(1); });
      nav.appendChild(prev); nav.appendChild(el("span", "empty", (at + 1) + " / " + order.length)); nav.appendChild(next);
      head.appendChild(nav);
    }
    host.appendChild(head);
    var mine = data.apiChanges.filter(function (c) { return c.file === file; });
    if (mine.length) host.appendChild(apiChangeList(mine));
    var body = el("div", "code");
    body.appendChild(el("div", "gap", tr("Loading…")));
    host.appendChild(body);
    var result = null;
    var block = blockOfPath(file);
    /** The line of the first change in the file as it is now (for a removal, the line after it). */
    function firstChanged() {
      var ops = (result && result.ops) || [];
      for (var i = 0; i < ops.length; i++) {
        if (ops[i].type === "same") continue;
        for (var j = i; j < ops.length; j++) if (ops[j].newLine) return ops[j].newLine;
        return undefined;
      }
      return undefined;
    }
    /** The lines asked about: the ones selected in the page if the clicked line is among them, else the clicked line. */
    function pickedLines(line) {
      var sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount) {
        var range = sel.getRangeAt(0);
        // The lines of the file as it is now: a removed line has no number there, so an end on one moves to the nearest kept line inside the selection.
        var ends = [[range.startContainer, "nextElementSibling"], [range.endContainer, "previousElementSibling"]].map(function (end) {
          var node = end[0].nodeType === 1 ? end[0] : end[0].parentNode;
          var ln = node && node.closest ? node.closest(".ln") : null;
          while (ln && ln.classList.contains("del")) ln = ln[end[1]];
          var no = ln && ln.querySelector(".no");
          return no && /^[0-9]+$/.test(no.firstChild ? no.firstChild.textContent : "") ? Number(no.firstChild.textContent) : 0;
        });
        if (ends[0] && ends[1] && ends[0] <= ends[1] && line >= ends[0] && line <= ends[1]) return ends;
      }
      return [line, line];
    }
    function askBox(range) {
      var old = host.querySelector(".ask-box");
      if (old) old.remove();
      var ask = el("div", "ask-box");
      var fence = String.fromCharCode(96, 96, 96);
      var lines = [];
      if (range) (result.ops || []).forEach(function (op) { if (op.type !== "del" && op.newLine >= range[0] && op.newLine <= range[1]) lines.push(op.text); });
      var where = file + (range ? ":" + range[0] + (range[1] > range[0] ? "-" + range[1] : "") : "");
      ask.appendChild(el("div", "ask-title", tr("Ask Claude about {where}", { where: where })));
      var quote = lines.slice(0, 40);
      if (quote.length) { var pre = el("pre", null, quote.join("\\n") + (lines.length > quote.length ? "\\n…" : "")); ask.appendChild(pre); }
      var text = document.createElement("textarea");
      text.rows = 3;
      text.placeholder = tr("What should the session do here?");
      var send = el("button", "primary", tr("Send to my session"));
      var cancel = el("button", null, tr("Cancel"));
      var status = el("span", "empty");
      cancel.addEventListener("click", function () { ask.remove(); });
      send.addEventListener("click", function () {
        if (!text.value.trim()) { status.textContent = tr("Write what the session should do."); return; }
        send.disabled = true;
        var prompt = "About " + where + " in the working tree" + (quote.length ? ":\\n\\n" + fence + "\\n" + quote.join("\\n") + (lines.length > quote.length ? "\\n…" : "") + "\\n" + fence : ".") + "\\n\\n" + text.value.trim();
        api("POST", "/api/requests", block ? { prompt: prompt, block: block.id } : { prompt: prompt }).then(function (r) {
          keepRequest(r);
          ask.innerHTML = "";
          ask.appendChild(el("div", "ask-title", tr("Sent as request {id}", { id: r.id })));
          ask.appendChild(requestLine(r.id));
          var close = el("button", null, tr("Close"));
          close.addEventListener("click", function () { ask.remove(); });
          ask.appendChild(close);
        }).catch(function (error) { send.disabled = false; status.textContent = error.message; });
      });
      [text, send, cancel, status].forEach(function (n) { ask.appendChild(n); });
      host.insertBefore(ask, body);
      text.focus();
    }
    var openable = !!live.root && !(change && change.status === "deleted");
    lineActions = {
      url: openable ? function (line) { return editorUrl(file, line); } : null,
      ask: live.session ? function (line) { askBox(pickedLines(line)); } : null,
    };
    var edit = null;
    if (openable) {
      edit = el("a", "btn", tr("Open in VS Code"));
      edit.href = editorUrl(file);
      edit.title = tr("Opens the file at the first change; the ↗ over a line number opens that line");
      head.appendChild(edit);
    }
    if (live.session) {
      var askButton = el("button", null, tr("Ask Claude"));
      askButton.title = tr("Write a request about this file for your open Claude Code session");
      askButton.addEventListener("click", function () { askBox(null); });
      head.appendChild(askButton);
    }
    function show(which) {
      current = which;
      Object.keys(buttons).forEach(function (m) { buttons[m].className = m === which ? "on" : ""; });
      marks.style.display = which === "file" ? "" : "none";
      body.innerHTML = "";
      if (!result) return;
      if (result.binary) { body.appendChild(el("div", "gap", tr("Binary or very large file: no line view."))); return; }
      if (result.status === "unchanged" && which !== "file") body.appendChild(el("div", "gap", tr("No changes since the last commit.")));
      if (result.status === "deleted" && which === "file") { body.appendChild(el("div", "gap removed", tr("Deleted since the last commit. Switch to Diff to see what it held."))); return; }
      if (which === "diff") renderDiff(result.ops, body);
      else if (which === "side") renderSide(result.ops, body);
      else if (marksBox.checked) renderNormal(result.ops, body);
      else renderPlain(result.ops, body);
    }
    show(current);
    api("GET", "/api/file-diff?path=" + encodeURIComponent(file)).then(function (r) { result = r; agentNote(note, r.ops || []); if (edit) edit.href = editorUrl(file, firstChanged()); show(current); })
      .catch(function (error) { body.innerHTML = ""; body.appendChild(el("div", "gap removed", error.message)); });
    var b = blockOfPath(file);
    view = "file"; openTask = null; multi = []; openPanel();
    if (b) { selected = b.id; renderPanel(b); }
  }

  /** Who among the agents wrote the added lines; the rest are the developer's or unknown. */
  function agentNote(note, ops) {
    var counts = {};
    ops.forEach(function (op) { if (op.agent) counts[op.agent] = (counts[op.agent] || 0) + 1; });
    var names = Object.keys(counts);
    if (!names.length) return;
    note.appendChild(el("i"));
    note.appendChild(document.createTextNode(names.map(function (name) { return trn(counts[name], "{n} line by {name}", "{n} lines by {name}", { name: name }); }).join(", ")));
    note.title = tr("Lines agents added while this map was open. Other added lines are yours, or written when the map was not running.");
  }

  function codeLine(op) {
    var line = el("div", "ln" + (op.type === "same" ? "" : " " + op.type) + (op.agent ? " agent" : ""));
    if (op.agent) line.title = tr("Written by {name}", { name: op.agent });
    line.appendChild(el("span", "no", String(op.type === "del" ? op.oldLine : op.newLine)));
    line.appendChild(el("span", "mark", op.type === "add" ? "+" : op.type === "del" ? "−" : ""));
    line.appendChild(el("span", "txt", op.text || " "));
    addLineActions(line, op);
    return line;
  }

  /** The file as it is: added lines marked, removed ones folded into a marker you can open. */
  function renderNormal(ops, body) {
    var removed = [];
    function flush() {
      if (!removed.length) return;
      var hidden = removed;
      removed = [];
      var gap = el("div", "gap removed", "▸ " + trn(hidden.length, "{n} line removed here", "{n} lines removed here"));
      gap.addEventListener("click", function () {
        var anchor = gap;
        hidden.forEach(function (op) { var line = codeLine(op); anchor.parentNode.insertBefore(line, anchor.nextSibling); anchor = line; });
        gap.remove();
      });
      body.appendChild(gap);
    }
    ops.slice(0, 20000).forEach(function (op) {
      if (op.type === "del") { removed.push(op); return; }
      flush();
      body.appendChild(codeLine(op));
    });
    flush();
  }

  /** The file as it is now, nothing marked. */
  function renderPlain(ops, body) {
    ops.slice(0, 20000).forEach(function (op) {
      if (op.type === "del") return;
      var line = el("div", "ln");
      line.appendChild(el("span", "no", String(op.newLine)));
      line.appendChild(el("span", "txt", op.text || " "));
      addLineActions(line, op);
      body.appendChild(line);
    });
  }

  /** The old text on the left, the new one on the right; a run of removed lines faces the run of added ones that replaced it. */
  function sideRows(ops) {
    var rows = [];
    var i = 0;
    while (i < ops.length) {
      if (ops[i].type === "same") { rows.push({ l: ops[i], r: ops[i] }); i++; continue; }
      var dels = [], adds = [];
      while (i < ops.length && ops[i].type !== "same") { (ops[i].type === "del" ? dels : adds).push(ops[i]); i++; }
      for (var k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ l: dels[k] || null, r: adds[k] || null });
    }
    return rows;
  }

  function sideLine(op, side) {
    var cls = "ln" + (!op ? " empty" : op.type === "same" ? "" : " " + op.type) + (op && op.agent ? " agent" : "");
    var line = el("div", cls);
    line.appendChild(el("span", "no", op ? String(side === "l" ? op.oldLine : op.newLine) : ""));
    line.appendChild(el("span", "mark", op && op.type === "add" ? "+" : op && op.type === "del" ? "−" : ""));
    line.appendChild(el("span", "txt", op ? op.text || " " : " "));
    if (op && op.agent) line.title = tr("Written by {name}", { name: op.agent });
    if (side === "r") addLineActions(line, op);
    return line;
  }

  /** Side by side: only what changed with three lines around it; the rest folded, in both columns. */
  function renderSide(ops, body) {
    var rows = sideRows(ops.slice(0, 20000));
    var keep = new Array(rows.length);
    rows.forEach(function (row, i) {
      if (row.l === row.r) return;
      for (var j = Math.max(0, i - 3); j <= Math.min(rows.length - 1, i + 3); j++) keep[j] = true;
    });
    var opened = {};
    function draw() {
      body.innerHTML = "";
      var wrap = el("div", "sbs");
      var cols = { l: el("div", "sbs-col"), r: el("div", "sbs-col") };
      var inner = { l: el("div", "sbs-in"), r: el("div", "sbs-in") };
      cols.l.appendChild(inner.l); cols.r.appendChild(inner.r);
      wrap.appendChild(cols.l); wrap.appendChild(cols.r);
      var i = 0;
      while (i < rows.length) {
        if (keep[i] || opened[i]) { inner.l.appendChild(sideLine(rows[i].l, "l")); inner.r.appendChild(sideLine(rows[i].r, "r")); i++; continue; }
        var from = i;
        while (i < rows.length && !keep[i]) i++;
        (function (start, count) {
          ["l", "r"].forEach(function (side) {
            var gap = el("div", "gap", "⋯ " + trn(count, "{n} unchanged line", "{n} unchanged lines"));
            gap.addEventListener("click", function () { for (var k = start; k < start + count; k++) opened[k] = true; draw(); });
            inner[side].appendChild(gap);
          });
        })(from, i - from);
      }
      // One horizontal scroll for both sides.
      cols.l.addEventListener("scroll", function () { if (cols.r.scrollLeft !== cols.l.scrollLeft) cols.r.scrollLeft = cols.l.scrollLeft; });
      cols.r.addEventListener("scroll", function () { if (cols.l.scrollLeft !== cols.r.scrollLeft) cols.l.scrollLeft = cols.r.scrollLeft; });
      body.appendChild(wrap);
    }
    draw();
  }

  /** Only what changed, with three lines around it; the rest folded. */
  function renderDiff(ops, body) {
    var keep = new Array(ops.length);
    ops.forEach(function (op, i) {
      if (op.type === "same") return;
      for (var j = Math.max(0, i - 3); j <= Math.min(ops.length - 1, i + 3); j++) keep[j] = true;
    });
    var hidden = [];
    function flush() {
      if (!hidden.length) return;
      var lines = hidden;
      hidden = [];
      var gap = el("div", "gap", "⋯ " + trn(lines.length, "{n} unchanged line", "{n} unchanged lines"));
      gap.addEventListener("click", function () {
        var anchor = gap;
        lines.forEach(function (op) { var line = codeLine(op); anchor.parentNode.insertBefore(line, anchor.nextSibling); anchor = line; });
        gap.remove();
      });
      body.appendChild(gap);
    }
    ops.forEach(function (op, i) {
      if (!keep[i]) { hidden.push(op); return; }
      flush();
      body.appendChild(codeLine(op));
    });
    flush();
  }

  // ---- Team documents: Markdown notes given to agents next to the code's context.
  function docTargets(d) {
    return [d.common ? tr("common") : null, (d.blocks || []).length ? tr("blocks: {names}", { names: d.blocks.join(", ") }) : null, (d.groups || []).length ? tr("groups: {names}", { names: d.groups.join(", ") }) : null].filter(Boolean).join(" · ");
  }
  function docRow(d, extra) {
    var row = el("div", "diag doc-row");
    var name = el(live ? "a" : "span", null, d.path);
    if (live) { name.href = "#"; name.addEventListener("click", function (event) { event.preventDefault(); openDoc(d.path); }); }
    row.appendChild(name);
    row.appendChild(el("span", "tag", d.exists ? tok(d.tokens) : tr("missing")));
    if (extra) extra(row);
    if (d.description) row.appendChild(el("span", "empty", d.description));
    return row;
  }
  function failTo(node) { return function (error) { node.textContent = error.message; node.className = "finding error"; }; }
  function reloadHere() { location.reload(); }

  /** Pick an existing Markdown file or create one from the template, for a target ({block}, {group} or {common}). */
  function docAdder(target, defaultPath, already) {
    var who = target.block ? { blocks: [target.block] } : target.group ? { groups: [target.group] } : { common: true };
    var box = el("div");
    var status = el("div", "empty");
    var pick = el("select");
    var first = el("option", null, tr("Assign an existing .md file…")); first.value = ""; pick.appendChild(first);
    api("GET", "/api/markdown-files").then(function (files) {
      files.filter(function (f) { return already.indexOf(f) < 0; }).forEach(function (f) { var o = el("option", null, f); o.value = f; pick.appendChild(o); });
    }).catch(failTo(status));
    var assign = el("button", "secondary", tr("Assign"));
    assign.addEventListener("click", function () {
      if (!pick.value) { status.textContent = tr("Choose a file first."); return; }
      var body = { path: pick.value }; Object.keys(who).forEach(function (k) { body[k] = who[k]; });
      api("POST", "/api/docs", body).then(reloadHere).catch(failTo(status));
    });
    var newPath = el("input"); newPath.value = defaultPath; newPath.placeholder = tr("path of the new document");
    var desc = el("input"); desc.placeholder = tr("What it is about (optional)");
    var create = el("button", null, tr("Create and assign"));
    create.addEventListener("click", function () {
      var body = { path: newPath.value.trim() || undefined, description: desc.value.trim() || undefined, create: true };
      Object.keys(who).forEach(function (k) { body[k] = who[k]; });
      api("POST", "/api/docs", body).then(function (r) { location.hash = "doc=" + encodeURIComponent(r.path); location.reload(); }).catch(failTo(status));
    });
    var row = el("div", "buttons"); row.appendChild(pick); pick.style.flex = "1"; row.appendChild(assign);
    [row, el("div", "empty", tr("…or a new one, from a short template:")), newPath, desc, create, status].forEach(function (n) { box.appendChild(n); });
    return box;
  }

  function docsSection(target) {
    var own = data.docs.filter(function (d) { return target.block ? (d.blocks || []).indexOf(target.block) >= 0 : (d.groups || []).indexOf(target.group) >= 0; });
    var common = data.docs.filter(function (d) { return d.common && own.indexOf(d) < 0; });
    var box = section(tr("Team documents"), tr("{here} here · {common} common", { here: own.length, common: common.length }));
    box.appendChild(el("div", "empty", tr("Given to the agent with the code's context: the common ones first, then these. Up to ~3k tokens each they are included whole.")));
    own.forEach(function (d) {
      box.appendChild(docRow(d, live ? function (row) {
        var remove = el("button", "secondary", tr("Remove"));
        remove.addEventListener("click", function () { api("POST", "/api/docs/unassign", target.block ? { path: d.path, blocks: [target.block] } : { path: d.path, groups: [target.group] }).then(reloadHere); });
        row.appendChild(remove);
      } : null));
    });
    common.forEach(function (d) { box.appendChild(docRow(d, function (row) { row.appendChild(el("span", "tag", tr("common"))); })); });
    if (!own.length && !common.length) box.appendChild(el("div", "empty", tr("None yet.")));
    if (live) {
      var suggested = target.block ? "docs/blocks/" + target.block + ".md" : "docs/groups/" + target.group + ".md";
      var taken = data.docs.some(function (d) { return d.path === suggested; });
      var add = el("details"); add.appendChild(el("summary", null, tr("Add a document")));
      add.appendChild(docAdder(target, taken ? "" : suggested, own.map(function (d) { return d.path; })));
      box.appendChild(add);
    }
    return box;
  }

  function allDocsSection() {
    var box = section(tr("Team documents"), String(data.docs.length));
    if (!data.docs.length) box.appendChild(el("div", "empty", tr("Markdown notes for the agents: rules, decisions, pitfalls the code does not show. Assign them from a block or group; mark the ones every agent needs as common.")));
    data.docs.forEach(function (d) {
      box.appendChild(docRow(d, function (row) {
        if (live) {
          var label = el("label", "check"); var flag = el("input"); flag.type = "checkbox"; flag.checked = !!d.common;
          flag.addEventListener("change", function () {
            (flag.checked ? api("POST", "/api/docs", { path: d.path, common: true }) : api("POST", "/api/docs/unassign", { path: d.path, common: true })).then(reloadHere).catch(function (error) { flag.checked = !flag.checked; alert(error.message); });
          });
          label.appendChild(flag); label.appendChild(document.createTextNode("common")); row.appendChild(label);
        } else if (d.common) row.appendChild(el("span", "tag", tr("common")));
        var where = [(d.blocks || []).length ? d.blocks.join(", ") : null, (d.groups || []).length ? tr("groups: {names}", { names: d.groups.join(", ") }) : null].filter(Boolean).join(" · ");
        if (where) row.appendChild(el("span", "empty", where));
      }));
    });
    if (live) {
      var more = el("details"); more.appendChild(el("summary", null, tr("Add a common document")));
      more.appendChild(docAdder({ common: true }, "docs/common.md", data.docs.filter(function (d) { return d.common; }).map(function (d) { return d.path; })));
      box.appendChild(more);
    }
    return box;
  }

  function openDoc(docPath) {
    leaveZoom();
    var d = data.docs.filter(function (x) { return x.path === docPath; })[0];
    if (!d || !live) return;
    var back = location.hash.indexOf("#doc=") === 0 ? "" : location.hash;
    view = "doc"; openTask = null; openPanel();
    setHash("doc=" + encodeURIComponent(docPath));
    var panel = document.getElementById("panel");
    panel.innerHTML = "";
    panel.appendChild(el("div", "kicker", tr("Team document")));
    panel.appendChild(el("h1", null, d.path));
    panel.appendChild(el("div", "desc", docTargets(d) + (d.description ? " — " + d.description : "")));
    var editor = el("textarea", "doc-editor"); editor.value = tr("Loading…"); editor.disabled = true;
    var status = el("div", "empty", tr("Saved files are read by the next briefing; the map does not reload."));
    var buttons = el("div", "buttons");
    var save = el("button", "ok", tr("Save"));
    var close = el("button", "secondary", tr("Back"));
    save.addEventListener("click", function () {
      save.disabled = true;
      api("PUT", "/api/docs/content?path=" + encodeURIComponent(d.path), { text: editor.value })
        .then(function () { status.textContent = tr("Saved."); status.className = "empty"; save.disabled = false; })
        .catch(function (error) { save.disabled = false; failTo(status)(error); });
    });
    close.addEventListener("click", function () { location.hash = back; location.reload(); });
    buttons.appendChild(save); buttons.appendChild(close);
    [editor, buttons, status].forEach(function (n) { panel.appendChild(n); });
    api("GET", "/api/docs/content?path=" + encodeURIComponent(d.path)).then(function (r) {
      editor.value = r.text; editor.disabled = false;
      if (!r.exists) status.textContent = tr("The file does not exist yet: saving creates it.");
    }).catch(failTo(status));
  }

  // ---- Tasks (live map only): start Claude Code on a scope, answer its questions, review its work.
  var tasks = {};
  var requests = {};
  var diffs = {};
  var openTask = null;
  var panelDirty = false;
  var reloadPending = false;


  // ---- What waits for the person right now, from the tasks, requests and worktrees the panel already knows: one list, the most urgent first.
  var attended = {};
  function attentionItems() {
    var items = [];
    Object.keys(tasks).forEach(function (id) {
      var t = tasks[id];
      var text = taskTitle(t, 80);
      if (t.status === "waiting") items.push({ rank: 0, word: tr("a decision is waiting"), text: text, task: id });
      else if ((t.status === "blocked" || t.status === "failed") && attended[id] !== t.status) items.push({ rank: 1, word: t.status === "blocked" ? tr("blocked") : tr("failed"), text: text, task: id });
      else if (t.worktree && t.status === "done") items.push({ rank: 3, word: tr("ready to merge"), text: text, task: id });
      else if (t.worktree && t.status === "stopped" && attended[id] !== t.status) items.push({ rank: 3, word: tr("stopped, worktree left"), text: text, task: id });
      else if (t.status === "prepared") items.push({ rank: 4, word: tr("ready for your session"), text: text, task: id });
    });
    Object.keys(requests).forEach(function (id) {
      var r = requests[id];
      if (r.status === "delivered" && Date.now() - Date.parse(r.deliveredAt) > UNCONFIRMED_MS) items.push({ rank: 2, word: tr("the session has not confirmed it"), text: firstLine(r.prompt, 80) });
    });
    (worktrees ? worktrees.worktrees : []).forEach(function (w) {
      if (tasks[w.task] || (w.state !== "review" && w.state !== "uncommitted")) return;
      items.push({ rank: 4, word: worktreeWord(w.state), text: w.branch + (w.prompt ? " · " + firstLine(w.prompt, 60) : ""), worktree: true });
    });
    return items.sort(function (a, b) { return a.rank - b.rank; });
  }
  /** The Sessions button in the header: how many things wait for the person, how many sessions work; it opens the menu. */
  function refreshNeeds() {
    if (!live) return;
    var items = attentionItems();
    var button = document.getElementById("sessions-btn");
    if (!button) {
      button = el("button", "chip"); button.id = "sessions-btn"; button.type = "button";
      button.title = tr("Every worktree of this repository: who works in it, what waits for you, what is ready to review");
      button.addEventListener("click", function () { setSessions(!sessionsOpen); });
      var chipsBox = document.getElementById("chips");
      chipsBox.insertBefore(button, chipsBox.firstChild);
    }
    // One chip for everything that works or waits: the old Requests chip is a line of the worktree it is for.
    var waiting = items.length + peerWorktreeRequests.length;
    var count = worktrees && worktrees.checkouts ? worktrees.checkouts.length : 0;
    button.textContent = tr("Worktrees");
    if (waiting) { var waitBadge = el("span", "n wait", String(waiting)); waitBadge.id = "needs-chip"; waitBadge.title = trn(waiting, "{n} waiting for you", "{n} waiting for you"); button.appendChild(waitBadge); }
    if (count > 1) { var countBadge = el("span", "n", String(count)); countBadge.title = trn(count, "{n} worktree", "{n} worktrees"); button.appendChild(countBadge); }
    button.classList.toggle("warning", !!items.length && items[0].rank <= 2);
    button.classList.toggle("on", sessionsOpen);
    if (sessionsOpen) renderSessionsSoon();
  }

  // ---- The Sessions menu: everything that works or waits, in one place instead of four chips; and the rules of a new worktree.
  var sessionsOpen = false;
  var sessionsHeld = false;
  var sessionsTimer = null;
  try { sessionsOpen = !!live && sessionStorage.getItem("cantus-sessions") === "1"; } catch (error) { sessionsOpen = false; }
  function setSessions(on) {
    sessionsOpen = on;
    try { if (on) sessionStorage.setItem("cantus-sessions", "1"); else sessionStorage.removeItem("cantus-sessions"); } catch (error) { /* private mode */ }
    var box = document.getElementById("sessions");
    box.hidden = !on;
    var button = document.getElementById("sessions-btn");
    if (button) button.classList.toggle("on", on);
    if (on) { renderSessions(); renderRules(); }
  }
  function renderSessionsSoon() { clearTimeout(sessionsTimer); sessionsTimer = setTimeout(renderSessions, 50); }
  function placeSessions() {
    var box = document.getElementById("sessions");
    box.style.top = document.querySelector("header").getBoundingClientRect().bottom + "px";
  }
  window.addEventListener("resize", placeSessions);
  function renderSessions() {
    if (!sessionsOpen || !live) return;
    // Not under a click or a half-typed rule: the column is drawn again when it ends.
    var rules = document.getElementById("worktree-rules");
    var busy = pressing || (rules.contains(document.activeElement) && typing()) || !!rules.querySelector("[data-touched]");
    if (busy) { sessionsHeld = true; return; }
    sessionsHeld = false;
    placeSessions();
    var head = document.querySelector("#sessions .sx-head");
    if (!head.firstChild) {
      head.appendChild(el("h3", null, tr("Worktrees")));
      var newWorktree = el("button", "secondary", tr("+ New"));
      newWorktree.title = tr("A new worktree: Cantus makes it and gives the lines that open the lead in a terminal");
      newWorktree.addEventListener("click", openNewWorktree);
      head.appendChild(newWorktree);
      var close = el("button", "panel-x", "×"); close.type = "button"; close.style.position = "static"; close.title = tr("Close"); close.setAttribute("aria-label", tr("Close"));
      close.addEventListener("click", function () { setSessions(false); });
      head.appendChild(close);
    }
    var more = document.getElementById("sessions-more");
    if (!more.querySelector("summary").firstChild) {
      more.querySelector("summary").textContent = tr("Rules for a new worktree");
      try { more.open = sessionStorage.getItem("cantus-sessions-more") === "1"; } catch (error) { /* private mode */ }
      more.addEventListener("toggle", function () { try { if (more.open) sessionStorage.setItem("cantus-sessions-more", "1"); else sessionStorage.removeItem("cantus-sessions-more"); } catch (error) { /* private mode */ } });
    }
    var scroll = document.querySelector("#sessions .sx-scroll");
    var kept = scroll.scrollTop;
    document.getElementById("worktree-column").replaceChildren(worktreeColumn());
    scroll.scrollTop = kept;
  }

  // ---- The Worktrees column: a card for every worktree of the repository, the one this map is of included. Who works in it, what waits for you, what to do next.
  var WORKTREE_FRESH_MS = 90000;
  // A lead that was last heard at a prompt or a tool call is in the middle of its turn, however long a test run takes; past this it is read as lost.
  var WORKTREE_WORKING_MAX_MS = 15 * 60000;
  function worktreeName(c) { return c.branch || c.path.split(/[\\/]/).filter(Boolean).pop(); }
  /** Where a worktree stands, in the words the person needs (working, just opened, waiting for you, to review, merged) and "off" for the rest. */
  function worktreeStanding(c) {
    var ask = peerWorktreeRequests.filter(function (r) { return r.branch === c.branch; })[0];
    if (c.merged) return { key: "merged", word: tr("merged"), rank: 4 };
    if (ask) return { key: "waiting", word: tr("waiting for you"), rank: 0, ask: ask };
    if (c.capo || (c.current && live.session)) {
      var seen = c.current ? seenAt || c.capoSeenAt : c.capoSeenAt;
      var via = c.current ? seenVia || c.capoVia : c.capoVia;
      var quiet = seen ? Date.now() - Date.parse(seen) : 0;
      // Nothing from it yet: the session was just opened, and it is not the person's turn.
      if (!seen) return { key: "opened", word: tr("just opened"), rank: 1 };
      // It asked the person for a permission and nothing came after (the next tool call, message or end of turn would say so).
      if (via === "permission") return { key: "waiting", word: tr("asking for a permission"), rank: 0, since: seen };
      if (via === "prompt" || via === "tool") {
        // Mid-turn, until it ends its turn: a long test run is not silence.
        if (quiet < WORKTREE_WORKING_MAX_MS) return { key: "working", word: tr("working"), rank: 1 };
        return { key: "waiting", word: tr("waiting for you"), rank: 0, since: seen, silent: Math.round(quiet / 60000) };
      }
      if (via === "stop") {
        // Its turn ended: finished, if the report it gave is about the work as it stands, otherwise it is the person's turn.
        var report = c.made && c.made.report;
        if (report && report.commit && c.head && report.commit === c.head) return { key: "review", word: tr("to review"), rank: 2, since: seen };
        return { key: "waiting", word: tr("waiting for you"), rank: 0, since: seen };
      }
      // A session whose plugin does not say what it did: a lead that got in touch a moment ago is working, one that did not has finished its turn.
      if (quiet < WORKTREE_FRESH_MS) return { key: "working", word: tr("working"), rank: 1 };
      return { key: "waiting", word: tr("waiting for you"), rank: 0, since: seen };
    }
    if (c.ahead || (!c.current && c.uncommitted)) return { key: "review", word: tr("to review"), rank: 2 };
    return { key: "off", word: c.made && c.made.state === "prepared" ? tr("off · ready") : tr("off"), rank: 3 };
  }
  /** The terminal lines that take a worktree up again: where it is, and its last conversation there. */
  function worktreeLines(c) {
    // The server says what to type there: the task file of a worktree nobody opened yet, the conversation it has (claude --resume with its id), or a plain claude when it has none (--continue would end in "No conversation found").
    return 'cd "' + c.path + '"\\n' + (c.claude || "claude");
  }
  // The terminal this person opens worktrees with, from their own settings: "lines" (the default) has Cantus open nothing.
  var terminal = null;
  function terminalLabels() { return { lines: tr("Lines to copy"), warp: tr("Warp"), wt: tr("Windows Terminal"), custom: tr("My own command") }; }
  function loadTerminal() {
    if (terminal || !live) return;
    terminal = { app: "lines", apps: [] };
    api("GET", "/api/personal/terminal").then(function (r) { terminal = r; renderSessionsSoon(); }).catch(function () { /* the lines to copy still work */ });
  }
  function worktreeColumn() {
    var column = el("div", "wtcol");
    // A step of a task that asks the person on this map (the setup commands of a new worktree, a task a session started): it waits here until answered.
    var waiting = Object.keys(tasks).map(function (id) { return tasks[id]; }).filter(function (task) { return task.status === "waiting" && task.approvals.length; });
    if (waiting.length) {
      var ask = el("div", "wtc-asks");
      waiting.forEach(function (task) {
        var row = el("div", "diag");
        var link = el("a", "change-link", taskTitle(task, 90));
        link.href = "#task=" + task.id;
        link.addEventListener("click", function (event) { event.preventDefault(); setSessions(false); showTask(task.id); });
        row.appendChild(el("span", "lvl", tr("Waiting for your approval") + " · "));
        row.appendChild(link);
        ask.appendChild(row);
      });
      column.appendChild(ask);
    }
    var checkouts = worktrees && worktrees.checkouts && worktrees.checkouts.length ? worktrees.checkouts.slice() : [{ path: "", current: true, ahead: 0, behind: 0, files: 0, uncommitted: 0, blocks: [], capo: !!live.session }];
    var rows = checkouts.map(function (c) { return { c: c, standing: worktreeStanding(c) }; });
    rows.sort(function (a, b) { return a.standing.rank - b.standing.rank || (b.c.current ? 1 : 0) - (a.c.current ? 1 : 0); });
    // With more than one worktree they are told apart by where they stand, the ones that wait for you first.
    var heading = null;
    rows.forEach(function (row) {
      if (rows.length > 1 && row.standing.rank !== heading) {
        heading = row.standing.rank;
        column.appendChild(el("div", "wtc-group", { 0: tr("Waiting for you"), 1: tr("Working"), 2: tr("To review"), 3: tr("Off"), 4: tr("Merged") }[heading] || ""));
      }
      column.appendChild(worktreeCard(row.c, row.standing));
    });
    if (plans.length) {
      column.appendChild(el("div", "wtc-group", tr("Plans")));
      plans.forEach(function (plan) {
        var done = plan.tasks.filter(function (t) { return t.status === "merged"; }).length;
        var line = el("div", "wtc-line");
        line.appendChild(el("strong", null, firstLine(plan.goal, 70)));
        var bits = [planWord(plan), done + "/" + plan.tasks.length];
        if (plan.elapsedMs) bits.push(Math.max(1, Math.round(plan.elapsedMs / 60000)) + " min");
        if (plan.costUsd) bits.push("$" + plan.costUsd.toFixed(2));
        line.appendChild(el("span", null, " · " + bits.join(" · ")));
        if (plan.blockedBy) line.appendChild(el("div", "empty", plan.blockedBy.task + ": " + firstLine(plan.blockedBy.why, 140)));
        column.appendChild(line);
      });
      column.appendChild(el("div", "empty", tr("A plan is started and approved from the command line: cantus plan.")));
    }
    // Merged ones Cantus made, and entries whose folder is gone: what the clean-up takes away.
    var goes = rows.filter(function (row) { return row.standing.key === "merged" && row.c.cantus; }).length + (worktrees ? worktrees.worktrees.filter(function (w) { return w.state === "orphan"; }).length : 0);
    if (goes) {
      var clean = el("button", "secondary", trn(goes, "Clean up {n} merged or gone", "Clean up {n} merged or gone"));
      var status = el("div", "empty");
      clean.addEventListener("click", function () { cleanUpWorktrees(clean, status); });
      column.appendChild(clean);
      column.appendChild(status);
    }
    if (worktreeNote) column.appendChild(el("div", "empty", worktreeNote));
    // What the cards open a terminal with: the choice is kept in the person's own settings, never in the map.
    loadTerminal();
    if (terminal && terminal.apps.length > 1 && rows.some(function (row) { return !row.c.current && row.c.claude; })) {
      var choose = el("label", "field", tr("Open terminals with"));
      var pick = el("select"); pick.id = "terminal-app";
      terminal.apps.forEach(function (a) { var o = el("option", null, terminalLabels()[a.app] || a.label); o.value = a.app; if (a.app === terminal.app) o.selected = true; pick.appendChild(o); });
      pick.addEventListener("change", function () {
        api("PUT", "/api/personal/terminal", { app: pick.value }).then(function () { terminal.app = pick.value; renderSessionsSoon(); }).catch(function (error) { worktreeNote = error.message; renderSessionsSoon(); });
      });
      choose.appendChild(pick);
      column.appendChild(choose);
      column.appendChild(el("div", "empty", tr("Choosing Warp or Windows Terminal adds a button that opens it in the worktree, with the line typed. The choice stays in your own settings.")));
    }
    // Where the merges will meet: blocks that more than one worktree changes.
    if (worktrees && worktrees.shared.length) {
      var shared = el("details", "wtc-shared");
      shared.appendChild(el("summary", null, trn(worktrees.shared.length, "{n} block changed in more than one", "{n} blocks changed in more than one")));
      worktrees.shared.forEach(function (entry) { shared.appendChild(el("div", "empty", (byId[entry.block] ? byId[entry.block].name : entry.block) + ": " + entry.in.join(", "))); });
      column.appendChild(shared);
    }
    return column;
  }
  function worktreeCard(c, standing) {
    var card = el("div", "wtc " + standing.key + (c.current ? " here" : ""));
    card.setAttribute("data-branch", c.branch || "");
    var head = el("div", "wtc-head");
    head.appendChild(el("i", "dot"));
    var linked = !c.current && c.mapUrl;
    var name = linked ? el("a", "wtc-name") : el("strong", "wtc-name");
    name.textContent = worktreeName(c);
    if (linked) {
      name.href = c.mapUrl;
      name.title = tr("Go to the map of this worktree");
      // The selection goes along, as the page's own address: a block that is not in the other map is just ignored there.
      name.addEventListener("click", function () { name.href = c.mapUrl + location.hash; });
    } else if (!c.current) name.title = tr("No map is open for this worktree");
    head.appendChild(name);
    if (c.current) head.appendChild(el("span", "tag", tr("this map")));
    head.appendChild(el("span", "wtc-state", standing.word + (standing.silent ? " · " + tr("silent for {n} min", { n: standing.silent }) : standing.since ? " · " + ago(standing.since) : "")));
    card.appendChild(head);
    if (c.made && c.made.prompt) card.appendChild(el("div", "wtc-line", "«" + firstLine(c.made.prompt, 90) + "»"));
    if (c.made && c.made.report) card.appendChild(el("div", "wtc-line", tr("Session report") + ": " + firstLine(c.made.report.summary, 160)));
    // Who wrote the files, as the hooks saw the edits: said plainly, with no judgement attached.
    if (c.made && c.made.report && c.made.report.writers) {
      var writers = c.made.report.writers;
      var by = [trn(writers.lead, "lead {n} file", "lead {n} files")];
      Object.keys(writers.specialists).forEach(function (agent) { by.push(agent + " " + trn(writers.specialists[agent], "{n} file", "{n} files")); });
      var writtenBy = el("div", "wtc-line", tr("Written by") + ": " + by.join(" · "));
      writtenBy.title = tr("Files edited, from the hooks' record. Edits made with the shell are not counted.");
      card.appendChild(writtenBy);
    }
    var numbers = [];
    if (c.ahead) numbers.push(trn(c.ahead, "{n} commit", "{n} commits"));
    if (c.uncommitted) numbers.push(trn(c.uncommitted, "{n} file not committed", "{n} files not committed"));
    else if (c.files) numbers.push(trn(c.files, "{n} file", "{n} files"));
    if (standing.key === "review" && !c.capo && !(c.current && live.session)) numbers.push(tr("lead off"));
    if (c.behind && standing.key !== "merged") numbers.push(tr("{n} behind the main line", { n: c.behind }));
    if (numbers.length) card.appendChild(el("div", "wtc-line", numbers.join(" · ")));
    if (c.blocks && c.blocks.length) {
      var blocksLine = el("div", "wtc-line");
      blocksLine.appendChild(document.createTextNode(tr("Blocks") + ": "));
      c.blocks.forEach(function (id, i) {
        if (i) blocksLine.appendChild(document.createTextNode(", "));
        var link = el("a", null, byId[id] ? byId[id].name : id);
        link.href = "#"; link.style.color = "var(--blue-soft)";
        link.addEventListener("click", function (event) { event.preventDefault(); if (byId[id]) select(id); });
        blocksLine.appendChild(link);
      });
      card.appendChild(blocksLine);
    }
    if (standing.ask) {
      var approve = el("a", "change-link", tr("Waiting for your approval") + " · " + standing.ask.id);
      approve.href = standing.ask.url;
      var askLine = el("div", "wtc-line"); askLine.appendChild(approve);
      card.appendChild(askLine);
    }
    if (c.current) {
      var queued = Object.keys(requests).map(function (id) { return requests[id]; }).filter(isOpenRequest).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
      if (queued.length) {
        var queue = el("div", "wtc-queue");
        queue.appendChild(el("div", "wtc-q-title", tr("Requests") + " · " + queued.length));
        queued.forEach(function (r) {
          var one = el("div", "wtc-req");
          one.appendChild(el("div", null, firstLine(r.prompt, 90) + (r.scope.orchestrate ? " · " + tr("whole project") : r.scope.group ? " · " + tr("group {id}", { id: r.scope.group }) : r.scope.blocks ? " · " + r.scope.blocks.join(", ") : r.scope.block ? " · " + r.scope.block : "")));
          one.appendChild(requestLine(r.id));
          queue.appendChild(one);
        });
        card.appendChild(queue);
      }
    }
    // Where there is no lead open, the way to one: its lines, to paste in a terminal. Opening a terminal there is the person's choice (their own settings); the map follows no conversations.
    if (c.path && !c.current && !c.capo && standing.key !== "merged") {
      var lines = worktreeLines(c);
      var copy = el("button", "secondary", tr("Copy for the terminal"));
      copy.title = lines;
      copy.addEventListener("click", function () { if (navigator.clipboard) navigator.clipboard.writeText(lines).then(function () { copy.textContent = tr("Copied"); }); });
      card.appendChild(copy);
      // The app is the person's choice: a terminal opens in the worktree with the line typed. It starts no agent of its own and follows no conversation.
      if (terminal && terminal.app !== "lines") {
        var openIn = el("button", "secondary", tr("Open in {app}", { app: terminalLabels()[terminal.app] || terminal.app }));
        var openNote = el("div", "empty");
        openIn.addEventListener("click", function () {
          openIn.disabled = true;
          api("POST", "/api/worktrees/open", { path: c.path }).then(function (r) { openIn.disabled = false; openNote.className = "empty"; openNote.textContent = r.message; }).catch(function (error) { openIn.disabled = false; openNote.className = "finding error"; openNote.textContent = error.message; });
        });
        card.appendChild(openIn);
        card.appendChild(openNote);
      }
    }
    // To review: a separate, read-only reviewer is a command in a terminal, not something the map starts.
    // Run in the worktree: there it knows the task, the lead's report and where the worktree started, and goes through the lead's own map.
    if (standing.key === "review" && c.path) {
      var verifyLine = 'cantus verify -C "' + c.path + '"';
      var verifyCopy = el("button", "secondary", tr("Copy the verify command"));
      verifyCopy.title = verifyLine;
      verifyCopy.addEventListener("click", function () { if (navigator.clipboard) navigator.clipboard.writeText(verifyLine).then(function () { verifyCopy.textContent = tr("Copied"); }); });
      card.appendChild(verifyCopy);
    }
    if (c.made && tasks[c.made.task] && standing.key !== "merged") {
      var open = el("button", "secondary", standing.key === "review" ? tr("Review") : tr("Open"));
      open.addEventListener("click", function () { setSessions(false); showTask(c.made.task); });
      card.appendChild(open);
    }
    return card;
  }

  /** The map's rules for a new worktree: where it starts (named once for the project), branch and folder; commands are only shown. */
  function renderRules() {
    var holder = document.getElementById("worktree-rules");
    if (!live || !holder || holder.querySelector("[data-touched]")) return;
    api("GET", "/api/map/worktree-rules").then(function (r) { drawRules(holder, r, ""); }).catch(function (error) { holder.textContent = ""; holder.appendChild(el("div", "finding warning", error.message)); });
  }
  function drawRules(holder, r, note) {
    holder.textContent = "";
    var box = section(tr("New worktree"));
    box.appendChild(el("div", "empty", tr("For every task in its own worktree, and every worktree prepared for your session. Kept in the map (agent.worktree).")));
    var field = function (label, input) { var l = el("label", "field", label); l.appendChild(input); box.appendChild(l); return input; };
    var base = el("select"); base.id = "wt-rule-base";
    var options = [["", tr("The main branch, found by itself ({label})", { label: r.automatic || tr("none found") })], ["HEAD", tr("Where you are when the task starts (HEAD)")]].concat(r.branches.map(function (b) { return [b, b]; }));
    if (r.rules.base && r.rules.base !== "default" && r.rules.base !== "HEAD" && r.branches.indexOf(r.rules.base) < 0) options.push([r.rules.base, r.rules.base]);
    options.forEach(function (o) { var opt = el("option", null, o[1]); opt.value = o[0]; if ((r.rules.base === "default" ? "" : r.rules.base || "") === o[0]) opt.selected = true; base.appendChild(opt); });
    field(tr("Starts from"), base);
    var branch = el("input"); branch.id = "wt-rule-branch"; branch.value = r.rules.branch || ""; branch.placeholder = "cantus/task-{id}";
    field(tr("Branch"), branch);
    var folder = el("input"); folder.id = "wt-rule-path"; folder.value = r.rules.path || ""; folder.placeholder = tr("Default: inside .git, or .cantus/worktrees/{name} for your session");
    field(tr("Folder"), folder);
    // The browser gives a page no folder paths: the server lists the folders, and the chosen one is written as the rule would be (relative to the repository when it can).
    var browse = el("button", "secondary", tr("Choose a folder…")); browse.type = "button"; browse.id = "wt-rule-browse";
    var picker = el("div"); picker.id = "wt-rule-picker";
    var pickAt = function (at) {
      api("GET", "/api/folders" + (at ? "?path=" + encodeURIComponent(at) : "")).then(function (list) {
        picker.textContent = "";
        picker.appendChild(el("div", "empty", list.path));
        var row = function (label, to) { var a = el("a", null, label); a.href = "#"; a.style.color = "var(--blue-soft)"; a.style.display = "block"; a.addEventListener("click", function (event) { event.preventDefault(); pickAt(to); }); picker.appendChild(a); };
        if (list.parent) row(".. ", list.parent);
        (list.drives || []).forEach(function (d) { row(d, d); });
        list.folders.forEach(function (name) { row(name, list.path + (list.path.slice(-1) === "/" || list.path.slice(-1) === String.fromCharCode(92) ? "" : "/") + name); });
        if (!list.folders.length) picker.appendChild(el("div", "empty", tr("No folders here.")));
        var use = el("button", null, tr("Use this folder")); use.type = "button";
        use.addEventListener("click", function () { useFolder(list.rule); });
        picker.appendChild(use);
        picker.appendChild(el("div", "empty", tr("Each worktree gets its own folder inside it, named after the task ({slug}).")));
      }).catch(function (error) { picker.textContent = ""; picker.appendChild(el("div", "finding warning", error.message)); });
    };
    var useFolder = function (rule) { folder.value = (rule === "." ? "" : rule + "/") + "{slug}"; folder.setAttribute("data-touched", "1"); picker.textContent = ""; };
    browse.addEventListener("click", function () {
      if (picker.firstChild) { picker.textContent = ""; return; }
      // The system's own dialog first (this server runs on your machine); the list below is for a machine with no screen.
      browse.disabled = true;
      api("POST", "/api/folders/pick", { path: folder.value && folder.value.indexOf("{") < 0 ? folder.value : "" })
        .then(function (r) { browse.disabled = false; if (r.path) useFolder(r.rule); else if (r.unavailable) pickAt(""); })
        .catch(function () { browse.disabled = false; pickAt(""); });
    });
    box.appendChild(browse);
    box.appendChild(picker);
    var copy = el("input"); copy.id = "wt-rule-copy"; copy.value = (r.rules.copy || []).join(", "); copy.placeholder = ".env";
    var link = el("input"); link.id = "wt-rule-link"; link.value = (r.rules.link || []).join(", "); link.placeholder = "node_modules";
    // A script makes the worktree whole: copies, links and setup commands are not used, so they are not offered.
    if (r.rules.script) {
      box.appendChild(el("div", "empty", tr("With a script, the script decides the folder (it gets this one as CANTUS_PATH) and what goes in the worktree: files to copy or link and setup commands are not used.")));
    } else {
      field(tr("Copied in (comma-separated)"), copy);
      field(tr("Linked to yours (comma-separated)"), link);
    }
    var commands = r.rules.script ? [r.rules.script + (r.rules.scriptArgs ? " " + r.rules.scriptArgs.join(" ") : "")] : r.rules.setup || [];
    if (!commands.length) box.appendChild(el("div", "empty", tr("To make the worktree with a script of yours (.ps1, .sh, .mjs), set agent.worktree.script and scriptArgs in .cantus/model.json: commands are never set from this page.")));
    if (commands.length) {
      box.appendChild(el("div", "empty", r.rules.script ? tr("Your script makes the worktree:") : tr("Commands run in the new worktree:")));
      commands.forEach(function (c) { box.appendChild(el("div", "cmd", c)); });
      box.appendChild(el("div", "empty", tr("Commands are changed in .cantus/model.json only, never from this page; each task asks before running them.")));
    }
    if (r.problem) box.appendChild(el("div", "finding warning", r.problem));
    var save = el("button", null, tr("Save the rules"));
    var status = el("div", "empty", note);
    save.addEventListener("click", function () {
      save.disabled = true;
      var split = function (input) { return input.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean); };
      api("PUT", "/api/map/worktree-rules", { base: base.value, branch: branch.value, path: folder.value, copy: split(copy), link: split(link) })
        .then(function (next) { drawRules(holder, next, tr("Saved.")); })
        .catch(function (error) { save.disabled = false; status.textContent = error.message; status.className = "finding error"; });
    });
    box.appendChild(save);
    box.appendChild(status);
    holder.appendChild(box);
  }


  // ---- Worktrees Cantus made: what each is for, where it stands, which can go. Only those; the person's own are in the cantus worktrees command.
  var worktrees = null;
  var worktreeNote = "";
  var plans = [];
  function planWord(plan) { return { draft: tr("to approve"), approved: tr("approved"), running: tr("running"), blocked: tr("blocked"), finished: tr("finished"), stopped: tr("stopped"), interrupted: tr("interrupted") }[plan.status] || plan.status; }
  function worktreeWord(state) { return { running: tr("running"), waiting: tr("waiting for you"), prepared: tr("ready for your session"), uncommitted: tr("not committed"), review: tr("to review"), merged: tr("merged: can go"), empty: tr("nothing yet"), orphan: tr("folder gone") }[state] || state; }
  /** Takes away the worktrees Cantus made that can go (merged, or gone); what was done stays written under the list. */
  function cleanUpWorktrees(button, status) {
    button.disabled = true;
    cleaningWorktrees = true;
    api("POST", "/api/worktrees/cleanup").then(function (result) {
      cleaningWorktrees = false;
      // The list is rebuilt without them: what was done stays written under it.
      worktreeNote = result.removed.length ? tr("Removed: {names}", { names: result.removed.join(", ") }) : tr("Nothing could go.");
      // The map may reload itself because git changed: the note outlives that for a minute.
      try { sessionStorage.setItem("cantus-worktree-note", JSON.stringify({ text: worktreeNote, at: Date.now() })); } catch (error) { /* private mode */ }
      worktreeJson = "";
      updateWorktrees();
    }).catch(function (error) { cleaningWorktrees = false; button.disabled = false; failTo(status)(error); });
  }

  /** The list is git's, not an event's: asked again when the tasks change and from time to time. A badge on each block says how many worktrees touch it. */
  var worktreeTimer = null;
  var worktreeJson = "";
  var noteShown = false;
  // A clean-up in flight: git changes under it and the map would reload before its answer arrives and is written down.
  var cleaningWorktrees = false;
  function updateWorktreesSoon() { clearTimeout(worktreeTimer); worktreeTimer = setTimeout(updateWorktrees, 1500); }
  function updateWorktrees() {
    if (!live) return Promise.resolve();
    return Promise.all([api("GET", "/api/worktrees"), api("GET", "/api/plans").catch(function () { return { plans: [] }; })]).then(function (both) {
      var found = both[0];
      var changed = JSON.stringify(both) !== worktreeJson;
      worktreeJson = JSON.stringify(both);
      plans = both[1].plans || [];
      worktrees = found;
      var per = {};
      found.worktrees.forEach(function (w) { w.blocks.forEach(function (id) { (per[id] = per[id] || []).push(w.branch); }); });
      Object.keys(cards).forEach(function (k) {
        var holder = cards[k].querySelector(".badges");
        if (!holder) return;
        var old = holder.querySelector(".badge.wt");
        if (old) old.remove();
        if (!per[k]) return;
        var badge = el("span", "badge wt", trn(per[k].length, "{n} worktree", "{n} worktrees"));
        badge.title = per[k].join(", ");
        holder.appendChild(badge);
      });
      // The map reloads itself when git changes, and a clean-up does that: the panel shows again with what was done written in it.
      if (!noteShown) {
        noteShown = true;
        try { var kept = JSON.parse(sessionStorage.getItem("cantus-worktree-note") || "null"); if (kept && Date.now() - kept.at < 60000 && found.worktrees.length) openPanel(); } catch (error) { /* none */ }
      }
      refreshNeeds();
      // The panel is rebuilt only when the list changed and nothing in it is half typed.
      if (changed && view === "none" && !unsaved()) redrawPanel();
    }).catch(function () {});
  }

  function openNewWorktree() {
    var scope = view === "group" ? { group: decodeURIComponent(location.hash.slice(7)) } : selected ? { block: selected } : multi.length ? { blocks: multi.slice() } : { orchestrate: true };
    setSessions(false);
    clearSelection();
    view = "new-worktree";
    openPanel();
    var form = taskForm(scope, "", null, true);
    document.getElementById("panel").replaceChildren(form);
    form.querySelector("input").focus();
  }

  function taskForm(scope, label, about, personal) {
    var box = section(personal ? tr("New worktree") : scope.build ? tr("Build the plan") : tr("Start a task on {label}", { label: label }), scope.build ? label : undefined);
    if (about) box.appendChild(about.nodeType ? about : el("div", "empty", about));
    var prompt = el("textarea"); prompt.placeholder = scope.build ? tr("Notes for the agents (optional): stack, conventions, what to do first…") : tr("What should the agent do here?");
    // One question: where does the work go. Three answers, and none of them runs an agent from the map: the lead of this
    // worktree (the Claude Code session open here, the map was started by its MCP server), the lead of another worktree
    // that has one open, or a new worktree, which gives the lines to open a session there (the lead of that one).
    var where = el("select");
    var places = [];
    if (live.session && !scope.build && !personal) places.push(["here", tr("Here, in this worktree: the lead takes it")]);
    if (!scope.build && !personal) {
      ((worktrees && worktrees.checkouts) || []).forEach(function (c) {
        if (c.capo && c.capoUrl && !c.current) places.push(["peer:" + c.capoUrl, tr("In {branch}: its lead takes it", { branch: c.branch || c.path.split(/[\\/]/).filter(Boolean).pop() })]);
      });
    }
    places.push(["new", tr("In a new worktree (you open the terminal)")]);
    places.forEach(function (o) { var opt = el("option", null, o[1]); opt.value = o[0]; where.appendChild(opt); });
    where.setAttribute("aria-label", tr("Where the work goes"));
    where.value = places[0][0];
    var isNew = function () { return where.value === "new"; };
    var peerMap = function () { return where.value.indexOf("peer:") === 0 ? where.value.slice(5) : ""; };
    var branch = el("input"); branch.placeholder = tr("New branch (optional)"); branch.setAttribute("aria-label", branch.placeholder);
    var from = el("input"); from.placeholder = tr("Base branch or tag (optional)"); from.setAttribute("aria-label", from.placeholder);
    var taskPrompt = function () { return prompt.value.trim() || (personal ? tr("Work in this branch using the map as context.") : ""); };
    var refs = function (request) {
      if (branch.value.trim()) request.branch = branch.value.trim();
      if (from.value.trim()) request.from = from.value.trim();
    };
    // Cheaper models for small jobs: the session opened in a new worktree starts with the model chosen here.
    var model = el("select");
    [["", tr("Default model (the map's setting, else Claude Code's)")], ["opus", tr("Opus: the most capable, the most expensive")], ["sonnet", tr("Sonnet: balanced")], ["haiku", tr("Haiku: the cheapest, for small changes")]].forEach(function (o) { var opt = el("option", null, o[1]); opt.value = o[0]; model.appendChild(opt); });
    var toSession = function () { return where.value === "here"; };
    var start = el("button", null, tr("Prepare the worktree"));
    var status = el("div", "empty");
    var sentLine = null;
    // The worktree the map's rules (agent.worktree) would give this task, shown before it starts. Commands to run
    // need the person's agreement, asked again every time the form is used.
    var wt = el("div", "empty"); wt.style.display = "none";
    var agree = el("input"); agree.type = "checkbox";
    var agreeLabel = el("label"); agreeLabel.style.display = "none";
    agreeLabel.appendChild(agree); agreeLabel.appendChild(document.createTextNode(" " + tr("I agree to run these commands for this task")));
    var setup = [];
    var previewSeq = 0;
    var previewTimer = null;
    var preview = function () {
      var seq = ++previewSeq;
      if (!isNew()) { setup = []; agree.checked = false; agreeLabel.style.display = "none"; wt.textContent = ""; wt.style.display = "none"; return; }
      var request = { prompt: taskPrompt(), session: true };
      refs(request);
      Object.keys(scope).forEach(function (k) { request[k] = scope[k]; });
      api("POST", "/api/worktree-preview", request).then(function (plan) {
        if (seq !== previewSeq) return;
        wt.textContent = ""; wt.className = "empty"; wt.style.display = "";
        if (plan.script) wt.appendChild(el("div", null, tr("Your script makes the worktree: branch {branch}, name {name}", { name: plan.name, branch: plan.branch })));
        else {
          wt.appendChild(el("div", null, tr("Branch {branch}", { branch: plan.branch }) + " · " + tr("from {base}", { base: plan.baseLabel })));
          wt.appendChild(el("div", null, tr("Folder") + ": " + plan.path));
        }
        if (plan.copy.length) wt.appendChild(el("div", null, tr("Copied in: {files}", { files: plan.copy.join(", ") })));
        if (plan.link.length) wt.appendChild(el("div", null, tr("Linked to yours: {files}", { files: plan.link.join(", ") })));
        var commands = (plan.script ? [plan.scriptLine] : []).concat(plan.setup);
        // The tick stays while the commands are the same ones the person agreed to; any other commands need it again.
        if (setup.join("|") !== commands.join("|")) agree.checked = false;
        setup = commands;
        agreeLabel.style.display = "none";
        if (commands.length) {
          wt.appendChild(el("div", null, tr("These commands run on this computer in the new worktree:")));
          commands.forEach(function (command) { wt.appendChild(el("code", null, command)); wt.appendChild(document.createElement("br")); });
          agreeLabel.style.display = "";
        }
      }).catch(function (error) {
        if (seq !== previewSeq) return;
        setup = []; agree.checked = false; agreeLabel.style.display = "none";
        wt.textContent = error.message; wt.className = "finding warning"; wt.style.display = "";
      });
    };
    // Who else works where this task would: shown before the task starts, with the way to keep them apart.
    var collide = el("div", "empty"); collide.style.display = "none";
    var collisions = function () {
      if (scope.build || scope.orchestrate) return; // the whole project meets everyone: a warning there says nothing
      var request = { prompt: prompt.value };
      Object.keys(scope).forEach(function (k) { request[k] = scope[k]; });
      api("POST", "/api/collisions", request).then(function (found) {
        collide.textContent = "";
        collide.style.display = found.length ? "" : "none";
        collide.className = "finding warning";
        // One line each, with how many blocks: the names are one click away, not a wall of text between the form and its button.
        found.forEach(function (c) {
          var line = c.kind === "task" ? trn(c.blocks.length, "Another task works on {n} block of this one: {what}", "Another task works on {n} blocks of this one: {what}", { what: c.what })
            : c.kind === "agent" ? trn(c.blocks.length, "A specialist of your session works on {n} block of this one: {what}", "A specialist of your session works on {n} blocks of this one: {what}", { what: c.what })
            : trn(c.blocks.length, "The worktree {branch} changes {n} block of this one", "The worktree {branch} changes {n} blocks of this one", { branch: c.what });
          var detail = el("details", "collision");
          detail.appendChild(el("summary", null, line));
          detail.appendChild(el("div", "empty", c.blocks.join(", ")));
          collide.appendChild(detail);
        });
        if (found.length) collide.appendChild(el("div", null, tr("Two agents on the same files step on each other: a worktree keeps their changes apart until you merge.")));
      }).catch(function () { collide.style.display = "none"; });
    };
    collisions();
    where.addEventListener("change", function () { explain(); preview(); });
    [prompt, branch, from].forEach(function (field) {
      field.addEventListener("input", function () {
        previewSeq++;
        agree.checked = false;
        clearTimeout(previewTimer);
        previewTimer = setTimeout(preview, 400);
      });
    });
    var explain = function () {
      where.style.display = personal ? "none" : "";
      model.style.display = branch.style.display = from.style.display = isNew() ? "" : "none";
      start.textContent = isNew() ? tr("Prepare the worktree") : tr("Send to the lead");
      status.className = "empty";
      status.textContent = toSession()
        ? tr("The lead gets it with your next message in Claude Code, after its next tool call if it is busy, or when it is about to stop (the plugin's hooks); at once if it was started with the Cantus channel (see the plugin's README). It gives the work to the specialist of the block and does it with its own permissions.")
        : peerMap() ? tr("It goes to the session open in that worktree, which gets it the same way. Follow it on that worktree's map.")
        : tr("Prepare the worktree, then open Claude Code in it: the session you open there is the lead of that worktree. Any setup approval waits at the top of the Worktrees column.");
    };
    explain();
    preview();
    start.addEventListener("click", function () {
      if (!scope.build && !personal && !prompt.value.trim()) { status.textContent = tr("Write what the agent should do."); status.className = "finding warning"; return; }
      if (!personal && isNew() && setup.length && !agree.checked) { status.textContent = tr("Agree to run the commands above to start."); status.className = "finding warning"; return; }
      start.disabled = true;
      if (toSession()) {
        var request = { prompt: prompt.value };
        Object.keys(scope).forEach(function (k) { request[k] = scope[k]; });
        api("POST", "/api/requests", request).then(function (r) {
          keepRequest(r); prompt.value = ""; start.disabled = false;
          status.textContent = tr("Sent as request {id}.", { id: r.id });
          status.className = "empty";
          if (sentLine) sentLine.remove();
          sentLine = requestLine(r.id);
          box.appendChild(sentLine);
        }).catch(function (error) { start.disabled = false; status.textContent = error.message; status.className = "finding error"; });
        return;
      }
      if (peerMap()) {
        var forwarded = { prompt: prompt.value, map: peerMap() };
        Object.keys(scope).forEach(function (k) { forwarded[k] = scope[k]; });
        api("POST", "/api/peer-requests", forwarded).then(function (r) {
          prompt.value = ""; start.disabled = false;
          status.className = "empty"; status.textContent = tr("Sent as request {id}.", { id: r.id }) + " ";
          var follow = el("a", null, tr("Follow it on that worktree's map")); follow.href = r.url; follow.target = "_blank"; follow.rel = "noopener"; follow.style.color = "var(--blue-soft)";
          status.appendChild(follow);
        }).catch(function (error) { start.disabled = false; status.textContent = error.message; status.className = "finding error"; });
        return;
      }
      var body = { prompt: taskPrompt(), mode: "edit", isolation: "worktree" };
      refs(body);
      if (personal) body.confirmOnMap = true;
      else if (setup.length && agree.checked) body.confirmSetup = true;
      if (model.value) body.model = model.value;
      Object.keys(scope).forEach(function (k) { body[k] = scope[k]; });
      api("POST", "/api/worktrees", body).then(function (t) { keep(t); updateTasks(); showTask(t.id); })
        .catch(function (error) { start.disabled = false; status.textContent = error.message; status.className = "finding error"; });
    });
    [prompt].concat(personal ? [] : [where], [branch, from, wt], personal ? [collide, model] : [agreeLabel, collide, model], [start, status]).forEach(function (node) { box.appendChild(node); });
    return box;
  }

  /** Requests written for the open session: waiting, delivered, confirmed by it, or finished with its summary. */
  var seenAt = null;
  var seenVia = null;
  var requestLines = [];
  var UNCONFIRMED_MS = 60000;
  var VIA = { prompt: tr("with your next message"), tool: tr("while it was working"), stop: tr("when it was about to stop"), session: tr("when it asked for it") };
  function ago(iso) {
    var s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    return s < 5 ? tr("just now") : s < 90 ? tr("{n} s ago", { n: s }) : s < 5400 ? tr("{n} min ago", { n: Math.round(s / 60) }) : tr("{n} h ago", { n: Math.round(s / 3600) });
  }
  function isOpenRequest(r) { return r.status === "pending" || r.status === "delivered" || r.status === "accepted"; }
  /** What the user should know about one request: a short label, the detail, and whether sending it again makes sense. */
  function requestState(r) {
    var again = r.resent ? " (" + trn(r.resent, "sent again {n} time", "sent again {n} times") + ")" : "";
    if (r.status === "pending") {
      var fresh = seenAt && Date.now() - Date.parse(seenAt) < 90000;
      return { label: tr("In queue") + again, tone: "", resend: false, detail: fresh
        ? tr("Your session is active: it gets this after its next tool call, or when it is about to stop.")
        : seenAt ? tr("Your session was last heard {ago}: it gets this with your next message in Claude Code (or at once with the channel).", { ago: ago(seenAt) })
        : tr("Your session has not been heard from yet: it gets this with your next message in Claude Code (or at once with the channel).") };
    }
    if (r.status === "delivered") {
      var late = Date.now() - Date.parse(r.deliveredAt) > UNCONFIRMED_MS;
      return { label: late ? tr("Delivered, no confirmation yet") : tr("Delivered"), tone: late ? "warn" : "", resend: late,
        detail: tr("Handed to your session {via} {ago}", { via: VIA[r.via] || "", ago: ago(r.deliveredAt) }) + (late ? tr(". It has not said it read it: it may have ignored it.") : tr(". Waiting for it to confirm.")) };
    }
    if (r.status === "accepted") return { label: tr("Taken"), tone: "ok", resend: false, detail: r.understood || tr("Your session confirmed it and is working on it.") };
    return { label: tr("Done"), tone: "ok", resend: false, detail: r.reply || "" };
  }
  function fillRequestLine(box, r) {
    var st = requestState(r);
    box.innerHTML = "";
    box.className = "req-line" + (st.tone ? " " + st.tone : "");
    box.appendChild(el("span", "lvl", st.label));
    if (st.detail) box.appendChild(document.createTextNode(" · " + st.detail));
    if (r.status === "pending") {
      var withdraw = el("a", null, " · " + tr("withdraw")); withdraw.href = "#";
      withdraw.addEventListener("click", function (event) { event.preventDefault(); api("DELETE", "/api/requests/" + r.id).then(function () { keepRequest({ id: r.id, status: "withdrawn" }); }).catch(function (error) { alert(error.message); }); });
      box.appendChild(withdraw);
    }
    if (st.resend) {
      var again = el("a", null, " · " + tr("Send again")); again.href = "#";
      again.addEventListener("click", function (event) { event.preventDefault(); api("POST", "/api/requests/" + r.id + "/resend").then(keepRequest).catch(function (error) { alert(error.message); }); });
      box.appendChild(again);
    }
  }
  /** A line that follows one request by itself, wherever the user sent it from. */
  function requestLine(id) {
    var box = el("div", "req-line");
    var refresh = function () { if (requests[id]) fillRequestLine(box, requests[id]); else box.textContent = tr("Withdrawn."); };
    requestLines.push({ box: box, refresh: refresh });
    refresh();
    return box;
  }
  function refreshRequestUi() {
    requestLines = requestLines.filter(function (line) { return document.body.contains(line.box); });
    requestLines.forEach(function (line) { line.refresh(); });
    var open = Object.keys(requests).map(function (id) { return requests[id]; }).filter(isOpenRequest);
    var chip = document.getElementById("session-chip");
    if (!live || !live.session || !chip) return;
    var queued = open.filter(function (r) { return r.status === "pending"; }).length;
    var silent = open.filter(function (r) { return r.status === "delivered" && Date.now() - Date.parse(r.deliveredAt) > UNCONFIRMED_MS; }).length;
    var working = open.filter(function (r) { return r.status === "accepted"; }).length;
    var waiting = open.filter(function (r) { return r.status === "delivered"; }).length - silent;
    var pieces = [];
    if (queued) pieces.push(tr("{n} in queue", { n: queued }));
    if (waiting) pieces.push(tr("{n} delivered", { n: waiting }));
    if (silent) pieces.push(tr("{n} not confirmed", { n: silent }));
    if (working) pieces.push(tr("{n} in progress", { n: working }));
    chip.className = "diag" + (silent ? " warning" : "");
    chip.textContent = tr("Session") + ": " + (pieces.length ? pieces.join(" · ") : seenAt ? tr("active {ago}", { ago: ago(seenAt) }) : tr("not heard yet"));
    chip.title = seenAt ? tr("Your Claude Code session last got in touch {ago}", { ago: ago(seenAt) }) : tr("Your Claude Code session has not got in touch yet");
  }
  function keepRequest(r) {
    if (!r || !r.id) return;
    if (r.status === "withdrawn") delete requests[r.id]; else requests[r.id] = r;
    refreshRequestUi();
    refreshNeeds();
    if (view === "none" && !typing()) redrawPanel();
  }
  var peerWorktreeRequests = [];
  function refreshPeerRequests() {
    api("GET", "/api/worktree-requests").then(function (found) {
      if (JSON.stringify(found) === JSON.stringify(peerWorktreeRequests)) return;
      peerWorktreeRequests = found;
      refreshNeeds();
    }).catch(function () {});
  }



  /** Keeps the newest copy of a task: API responses and live events can arrive in any order. */
  function keep(t) {
    if (!t || !t.id) return false;
    var before = tasks[t.id];
    if (before && before.revision > t.revision) return false;
    if (before && before.status !== t.status && diffs[t.id] !== undefined) delete diffs[t.id];
    tasks[t.id] = t;
    return true;
  }
  /** Blocks a task is working on: for a coordinated task, those of its running delegations and the files it touched. */
  function taskBlocks(t) {
    if (!t.orchestrated) return t.touchedBlocks.length ? t.touchedBlocks : t.scope.blocks;
    var blocks = t.touchedBlocks.slice();
    (t.delegations || []).forEach(function (d) { if (d.status === "running") d.blocks.forEach(function (b) { if (blocks.indexOf(b) < 0) blocks.push(b); }); });
    return blocks;
  }
  function firstLine(text, max) { var line = String(text).split("\\n")[0]; return line.length > max ? line.slice(0, max - 1) + "…" : line; }
  /** What a task is called in lists and in its panel: a verification has no prompt, it is named by what it compares with. */
  function taskTitle(t, max) { return firstLine(t.prompt, max); }
  function isActive(t) { return t.status === "running" || t.status === "waiting"; }
  function statusWord(status) { return { running: tr("running"), waiting: tr("waiting for you"), done: tr("done"), blocked: tr("blocked"), failed: tr("failed"), stopped: tr("stopped"), merged: tr("merged"), discarded: tr("discarded"), prepared: tr("ready for your session") }[status] || status; }
  function statusLabel(t) { return statusWord(t.status); }
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && popoverOpen()) { closePopovers(); return; }
    if (event.key === "Escape" && sessionsOpen && !typing()) { setSessions(false); return; }
    if (event.key === "Escape" && panelOpen && !typing()) { closePanel(); return; }
    if (!fileNav || typing() || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "n") fileNav(1); else if (event.key === "p") fileNav(-1);
  });
  function typing() { var a = document.activeElement; return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT"); }

  // The panel can be wide, to follow a session or read a diff without squinting; the choice stays in this browser.
  function setWidePanel(on) {
    document.body.classList.toggle("panel-wide", on);
    try { if (on) localStorage.setItem("cantus-panel-wide", "1"); else localStorage.removeItem("cantus-panel-wide"); } catch (error) { /* private mode */ }
    drawEdges();
  }
  try { if (localStorage.getItem("cantus-panel-wide") === "1") document.body.classList.add("panel-wide"); } catch (error) { /* private mode */ }


  function showTask(id) {
    leaveZoom();
    if (!tasks[id]) return;
    view = "task"; openTask = id; selected = null; multi = []; openPanel();
    setHash("task=" + id);
    renderTask();
  }

  function renderTask() {
    var t = tasks[openTask];
    if (!t) return;
    panelDirty = false;
    var touched = t.touchedBlocks.length ? t.touchedBlocks : [];
    var working = taskBlocks(t);
    Object.keys(cards).forEach(function (k) {
      cards[k].className = "card" + (t.orchestrated
        ? (working.indexOf(k) >= 0 ? " selected" : "")
        : (t.scope.blocks.indexOf(k) >= 0 ? " selected" : touched.indexOf(k) >= 0 ? "" : " faded"));
    });
    drawEdges();
    var panel = document.getElementById("panel");
    var scrolled = panel.scrollTop;
    var opened = openDetails(panel);
    panel.innerHTML = "";
    panel.appendChild(el("div", "kicker", tr("Task · {status}", { status: statusLabel(t) })));
    panel.appendChild(el("h1", null, taskTitle(t, 90)));
    panel.appendChild(el("div", "desc", t.scope.name + " · " + (t.mode === "plan" ? tr("plan first") : "edit") + " · " + t.isolation + (t.model ? " · " + t.model : "") + (t.costUsd ? " · $" + t.costUsd.toFixed(2) : "")));
    var wide = el("button", "secondary", document.body.classList.contains("panel-wide") ? tr("Narrower panel") : tr("Wider panel"));
    wide.addEventListener("click", function () { setWidePanel(!document.body.classList.contains("panel-wide")); renderTask(); });
    panel.appendChild(wide);
    var feedback = el("div", "empty");
    function act(promise) { promise.then(function (rec) { keep(rec); updateTasks(); }).catch(function (error) { feedback.textContent = error.message; feedback.className = "finding error"; }); }

    // The one thing the page still asks: the commands that make a worktree wait for the person's yes, because they run on this machine.
    t.approvals.filter(function (a) { return a.tool === "WorktreeSetup" && Array.isArray(a.input.commands); }).forEach(function (a) {
      var box = section(tr("Waiting for your approval"), a.tool);
      box.className += " approval";
      box.appendChild(el("div", "desc", a.summary));
      box.appendChild(el("pre", "plan", a.input.commands.join("\\n")));
      if (t.personalWorktree && t.worktree && t.worktree.script) {
        var attach = el("button", "secondary", tr("Attach manually prepared worktree"));
        attach.addEventListener("click", function () {
          if (confirm(tr("Attach the worktree on branch {branch}? Run the required setup before attaching.", { branch: t.worktree.branch }))) {
            act(api("POST", "/api/tasks/" + t.id + "/attach-worktree"));
          }
        });
        box.appendChild(attach);
      }
      var reason = el("input"); reason.placeholder = tr("Why not, or what to do instead (optional)");
      var buttons = el("div", "buttons");
      var allow = el("button", "ok", tr("Allow"));
      allow.addEventListener("click", function () { act(api("POST", "/api/tasks/" + t.id + "/approvals/" + a.id, { allow: true })); });
      buttons.appendChild(allow);
      var deny = el("button", "danger", tr("Deny"));
      deny.addEventListener("click", function () { act(api("POST", "/api/tasks/" + t.id + "/approvals/" + a.id, { allow: false, message: reason.value.trim() || undefined })); });
      buttons.appendChild(deny);
      box.appendChild(reason);
      box.appendChild(buttons);
      panel.appendChild(box);
    });

    var controls = el("div", "buttons");
    if (t.changedFiles.length || t.worktree) {
      var showDiff = el("button", "secondary", diffs[t.id] !== undefined ? tr("Refresh diff") : tr("Show diff"));
      showDiff.addEventListener("click", function () { api("GET", "/api/tasks/" + t.id + "/diff").then(function (r) { diffs[t.id] = r.diff; renderTask(); }).catch(function (error) { feedback.textContent = error.message; feedback.className = "finding error"; }); });
      controls.appendChild(showDiff);
    }
    if (t.session) {
      var how = section(tr("Your Claude Code session"), t.status === "prepared" ? undefined : "");
      how.appendChild(el("div", "empty", tr("Open a terminal and run these two lines. The task and the briefing of the scope are in {file}; commit your work there, then merge it here.", { file: t.session.promptFile })));
      var lines = el("pre", "plan", t.session.commands.join("\\n"));
      how.appendChild(lines);
      var copyLines = el("button", "secondary", tr("Copy"));
      copyLines.addEventListener("click", function () { if (navigator.clipboard) navigator.clipboard.writeText(t.session.commands.join("\\n")).then(function () { copyLines.textContent = tr("Copied"); }); });
      how.appendChild(copyLines);
      panel.appendChild(how);
      // What the session said when it finished, written by its worktree_done and read from the list of worktrees.
      var mine = worktrees ? worktrees.worktrees.filter(function (w) { return w.task === t.id && w.report; })[0] : null;
      if (mine) {
        var said = section(tr("Session report"), new Date(mine.report.doneAt).toLocaleTimeString());
        said.appendChild(el("pre", "plan", mine.report.summary));
        if (mine.report.tests) said.appendChild(el("div", "empty", tr("Tests") + ": " + mine.report.tests));
        if (mine.report.dirty) said.appendChild(el("div", "finding warning", trn(mine.report.dirty, "{n} file was not committed when it reported", "{n} files were not committed when it reported")));
        panel.appendChild(said);
      }
    }
    if (t.worktree && (t.status === "done" || t.status === "prepared")) {
      var merge = el("button", "ok", tr("Merge into your branch"));
      merge.addEventListener("click", function () { act(api("POST", "/api/tasks/" + t.id + "/merge")); });
      controls.appendChild(merge);
    }
    if (t.worktree && !t.worktree.unconfirmed && (t.status === "done" || t.status === "blocked" || t.status === "failed" || t.status === "stopped" || t.status === "prepared")) {
      var discard = el("button", "danger", tr("Discard"));
      discard.addEventListener("click", function () { if (confirm(tr("Discard the branch {branch} and its worktree?", { branch: t.worktree.branch }))) act(api("POST", "/api/tasks/" + t.id + "/discard")); });
      controls.appendChild(discard);
    }
    if (controls.childNodes.length) panel.appendChild(controls);
    panel.appendChild(feedback);

    if (t.error) panel.appendChild(el("div", "finding error", t.error));
    if (t.result) { var result = section(tr("Report")); result.appendChild(el("pre", "plan", t.result)); panel.appendChild(result); }

    var files = section(tr("Files changed"), String(t.changedFiles.length));
    files.appendChild(t.changedFiles.length ? list(t.changedFiles.map(function (f) { var owner = blockOfFile(f); return f + (owner && t.scope.blocks.indexOf(owner) < 0 ? "  (" + tr("outside the scope: {block}", { block: owner }) + ")" : ""); })) : el("div", "empty", tr("None yet.")));
    if (t.touchedBlocks.length) files.appendChild(el("div", "empty", tr("Blocks touched: {names}", { names: t.touchedBlocks.join(", ") })));
    if (t.worktree) files.appendChild(el("div", "empty", tr("Branch {branch}", { branch: t.worktree.branch }) + (t.status === "merged" ? " (" + tr("merged") + ")" : t.status === "discarded" ? " (" + tr("discarded") + ")" : "")));
    panel.appendChild(files);

    if (diffs[t.id] !== undefined) {
      var diffBox = section(tr("Diff"));
      var pre = el("pre", "diff");
      var lines = diffs[t.id].split("\\n");
      lines.slice(0, 3000).forEach(function (line) {
        var cls = /^\\+(?!\\+\\+)/.test(line) ? "add" : /^-(?!--)/.test(line) ? "del" : /^@@/.test(line) ? "hunk" : null;
        pre.appendChild(el("span", cls, line + "\\n"));
      });
      if (lines.length > 3000) pre.appendChild(el("span", "hunk", tr("… {n} more lines", { n: lines.length - 3000 })));
      diffBox.appendChild(diffs[t.id] ? pre : el("div", "empty", tr("No changes.")));
      panel.appendChild(diffBox);
    }

    reopenDetails(panel, opened);
    panel.scrollTop = scrolled;
  }

  /** The little robot on a block a specialist of the open Claude Code session is working on. */
  var ROBOT = '<svg viewBox="0 0 30 30" aria-hidden="true"><line x1="15" y1="7" x2="15" y2="3" style="stroke:var(--agent-soft);stroke-width:1.6" stroke-linecap="round"/><circle class="bulb" cx="15" cy="2.4" r="2.1" style="fill:var(--agent)"/><rect x="3" y="12" width="3" height="7" rx="1.5" style="fill:var(--agent-soft)"/><rect x="24" y="12" width="3" height="7" rx="1.5" style="fill:var(--agent-soft)"/><rect x="6" y="7" width="18" height="16" rx="5" style="fill:var(--bg);stroke-width:1.8" style="stroke:var(--agent)"/><circle class="eye" cx="11.5" cy="14.5" r="2" style="fill:var(--agent-pale)"/><circle class="eye" cx="18.5" cy="14.5" r="2" style="fill:var(--agent-pale)"/><rect x="11" y="18.6" width="8" height="1.6" rx=".8" style="fill:var(--agent)"/></svg>';
  var agents = [];
  /** Draws the robot on the blocks of the specialists at work, and takes it off the others. */
  function updateAgents(list) {
    agents = list || [];
    var working = {};
    agents.forEach(function (a) {
      a.blocks.forEach(function (id) {
        var note = tr("{type} is working here", { type: a.type }) + (a.file ? " · " + a.file : "");
        working[id] = working[id] ? working[id] + "\\n" + note : note;
      });
    });
    Object.keys(cards).forEach(function (k) {
      var card = cards[k];
      var robot = card.querySelector(":scope > .robot");
      if (!working[k]) { delete card.dataset.agent; if (robot) robot.remove(); return; }
      card.dataset.agent = "working";
      if (!robot) { robot = el("span", "robot"); robot.innerHTML = ROBOT; card.appendChild(robot); }
      robot.title = working[k];
    });
    maybeReload();
  }

  /** Header chip and card highlights from the running tasks. */
  function updateTasks() {
    var all = Object.keys(tasks).map(function (id) { return tasks[id]; });
    var active = all.filter(isActive);
    var waiting = active.filter(function (t) { return t.status === "waiting"; });
    updateWorktreesSoon();
    refreshNeeds();
    var state = {};
    active.forEach(function (t) {
      taskBlocks(t).forEach(function (id) { if (state[id] !== "waiting") state[id] = t.status; });
    });
    Object.keys(cards).forEach(function (k) { if (state[k]) cards[k].dataset.task = state[k]; else delete cards[k].dataset.task; });
    var inPanel = document.getElementById("panel").contains(document.activeElement) && typing();
    if (view === "task") { if (inPanel) panelDirty = true; else redrawPanel(); }
    else if (view === "none" && !inPanel) redrawPanel();
    maybeReload();
  }

  // A field the user touched keeps the flag until the page rebuilds it: a reload now would lose what was typed.
  function touch(event) { var t = event.target; if (t && t.dataset && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) t.dataset.touched = "1"; }
  document.addEventListener("input", touch);
  document.addEventListener("change", touch);

  /** Something the user is in the middle of that a reload would throw away. */
  function unsaved() {
    return typing() || gesturing || draftShown || cleaningWorktrees || !!document.querySelector("#canvas form, #panel [data-touched], #canvas [data-touched], #sessions [data-touched]");
  }

  // The person at work on the page: a button held down, the mouse moving, a key, the wheel. A reload, or a panel rebuilt
  // under the pointer, in that moment swallows the click (the button is gone before it is released) and the screen with it.
  var pressing = false;
  var lastInput = 0;
  var QUIET_MS = 2000;
  var LOADED_AT = Date.now();
  // Tasks and specialists change files all the time: the page follows, but not more than once in this long.
  var WORKING_RELOAD_MS = 10000;
  function noteInput() { lastInput = Date.now(); }
  document.addEventListener("pointerdown", function () { pressing = true; noteInput(); }, true);
  ["pointerup", "pointercancel"].forEach(function (type) {
    document.addEventListener(type, function () {
      pressing = false; noteInput();
      // A rebuild held back while the button was down: after the click has gone through.
      if (panelHeld) setTimeout(function () { if (!pressing && panelHeld) redrawPanel(); }, 200);
      if (sessionsHeld) setTimeout(function () { if (!pressing && sessionsHeld) renderSessions(); }, 200);
    }, true);
  });
  ["pointermove", "keydown", "wheel"].forEach(function (type) { document.addEventListener(type, noteInput, { capture: true, passive: true }); });

  /** Rebuilds the open task, or the panel with nothing selected, unless a button in it is held down right now. */
  var panelHeld = false;
  function redrawPanel() {
    if (pressing) { panelHeld = true; return; }
    panelHeld = false;
    if (view === "task") renderTask();
    else if (view === "none" && !unsaved()) renderPanel(null);
  }

  /** The <details> open in a box, by their title, to open them again once it is rebuilt. */
  function openDetails(box) {
    return Array.prototype.map.call(box.querySelectorAll("details[open] > summary"), function (s) { return s.textContent; });
  }
  function reopenDetails(box, titles) {
    if (!titles.length) return;
    box.querySelectorAll("details > summary").forEach(function (s) { if (titles.indexOf(s.textContent) >= 0) s.parentNode.open = true; });
  }

  // Views the address brings back by itself after a reload. The others (a form being filled, a draft) wait for the person.
  var RESTORABLE = { none: true, block: true, selection: true, group: true, zoom: true };
  /** Nothing to lose and nobody at work: the page may reload by itself. A panel being read (a task, a diff, a document) waits for the person to go back to the map. */
  function atRest() {
    return !unsaved() && !pressing && inFlight === 0 && RESTORABLE[view] === true && Date.now() - lastInput >= QUIET_MS;
  }

  /** Where the person was looking, kept for the page that loads next: the scroll of the panel and of the map, the open sections. */
  function reload() {
    try {
      var panel = document.getElementById("panel");
      sessionStorage.setItem("cantus-restore", JSON.stringify({ hash: location.hash, panel: panel.scrollTop, x: window.scrollX, y: window.scrollY, open: openDetails(panel), at: Date.now() }));
    } catch (error) { /* private mode: the address alone */ }
    location.reload();
  }
  function restoreScroll() {
    var kept = null;
    try { kept = JSON.parse(sessionStorage.getItem("cantus-restore") || "null"); sessionStorage.removeItem("cantus-restore"); } catch (error) { kept = null; }
    if (!kept || kept.hash !== location.hash || Date.now() - kept.at > 30000) return function () {};
    window.scrollTo(kept.x, kept.y);
    var apply = function () { var panel = document.getElementById("panel"); reopenDetails(panel, kept.open || []); panel.scrollTop = kept.panel; };
    apply();
    return apply;
  }

  /** The code changed: reload now, or once no task is running and nothing of the user's is half done. */
  function maybeReload() {
    if (!reloadPending) return;
    var working = agents.length > 0 || Object.keys(tasks).some(function (id) { return isActive(tasks[id]); });
    var busy = !atRest() || (working && Date.now() - LOADED_AT < WORKING_RELOAD_MS);
    if (!busy) return reload();
    var chip = document.getElementById("stale-chip");
    if (!chip) { chip = el("span", "chip warning stale", tr("code changed · reload")); chip.id = "stale-chip"; chip.title = tr("The map reloads by itself once you have nothing half done (a form, an arrow, a draft), you are back on the map and have left the page alone for a couple of seconds (while tasks work, at most every ten seconds); where you were stays. Click to reload now."); chip.addEventListener("click", function () { reload(); }); document.getElementById("chips").appendChild(chip); }
  }

  document.getElementById("canvas").addEventListener("click", function (event) {
    if (zoomBlock) return;
    if (event.target.id === "canvas" || event.target.id === "lanes" || event.target.className === "cards") clearSelection();
  });
  window.addEventListener("resize", drawEdges);
  renderPanel(null);
  drawEdges();

  // Restore the selection from the URL (it survives live reloads).
  var state = [];
  function restoreFromHash() {
    state = location.hash.slice(1).split("=");
    if (state[0] === "block" && byId[state[1]]) select(state[1]);
    if (state[0] === "group") selectGroup(decodeURIComponent(state[1]));
    if (state[0] === "doc") openDoc(decodeURIComponent(state.slice(1).join("=")));
    if (state[0] === "zoom" && byId[state[1]]) zoomInto(state[1]);
    if (state[0] === "file" && live) openFileView(decodeURIComponent(state.slice(1).join("=")));
    if (state[0] === "stats" && live) showStats();
    if (state[0] === "api") showApiChanges();
    if (state[0] === "problems") showProblems();
    if (state[0] === "signals") showSignals();
    if (state[0] === "changes" && data.changes.git) {
      if (state[1] && live) openFileView(decodeURIComponent(state.slice(1).join("=")), undefined, true); else showChanges();
    }
    if (state[0] === "blocks") {
      multi = decodeURIComponent(state[1]).split(",").filter(function (id) { return byId[id]; });
      if (multi.length > 1) renderSelection(); else if (multi.length === 1) select(multi[0]);
    }
  }
  restoreFromHash();
  var restored = restoreScroll();
  // A link to another part of the page (a new URL with only the # changed) is followed without a reload.
  window.addEventListener("hashchange", restoreFromHash);

  if (live) {
    var chip = el("span", "chip live", "live");
    document.getElementById("facts").appendChild(chip);
    var events = new EventSource("/api/events");
    events.addEventListener("changed", function () { reloadPending = true; maybeReload(); });
    // What blocks the reload (a form, a drag) ends without any event: look again from time to time.
    setInterval(function () { if (reloadPending) maybeReload(); }, 2000);
    events.addEventListener("task", function (event) {
      if (keep(JSON.parse(event.data))) updateTasks();
    });
    events.addEventListener("request", function (event) { keepRequest(JSON.parse(event.data)); });
    events.addEventListener("seen", function (event) { var data = JSON.parse(event.data); seenAt = data.at; seenVia = data.via || null; if (seenVia === "stop") updateWorktreesSoon(); refreshRequestUi(); if (sessionsOpen) renderSessionsSoon(); });
    events.addEventListener("agents", function (event) { updateAgents(JSON.parse(event.data)); });
    events.onopen = function () {
      chip.textContent = "live"; chip.className = "chip live";
      api("GET", "/api/tasks").then(function (list) { list.forEach(keep); updateTasks(); }).catch(function () {});
    };
    events.onerror = function () { chip.textContent = tr("live: disconnected"); chip.className = "chip warning"; };
    document.getElementById("panel").addEventListener("focusout", function () {
      setTimeout(function () { if (typing()) return; if (panelDirty && view === "task") renderTask(); maybeReload(); }, 250);
    });
    if (live.session) {
      api("GET", "/api/requests").then(function (r) { seenAt = r.seen || null; seenVia = r.seenVia || null; r.requests.forEach(function (x) { requests[x.id] = x; }); refreshRequestUi(); }).catch(function () {});
      // "No confirmation yet" and "last heard" depend on the clock, not on an event.
      setInterval(refreshRequestUi, 10000);
    }
    refreshPeerRequests();
    setInterval(refreshPeerRequests, 5000);
    api("GET", "/api/agents").then(updateAgents).catch(function () {});
    refreshNeeds();
    if (sessionsOpen) setSessions(true);
    updateWorktrees();
    setInterval(updateWorktrees, 20000);
    api("GET", "/api/tasks").then(function (list) {
      list.forEach(keep);
      updateTasks();
      if (state[0] === "task") {
        var id = decodeURIComponent(state[1]);
        if (tasks[id] && tasks[id].status === "waiting") setSessions(false);
        showTask(id); restored();
      }
    }).catch(function () {});
  }
})();
`;
