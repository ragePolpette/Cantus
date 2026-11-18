import type { Analysis, BackendEndpoint, HttpCall } from "./analyze.js";
import { findCallers } from "./callers.js";
import { endpointDetail } from "./csharp.js";

/** Endpoints, pages and calls shown per target before "… N more". */
const LIMIT = 10;
const CSHARP_LINES = 6;
/** Scripts of a page listed by `trace`: pages with more than this many are rare, and the list is cut with its count. */
const PAGE_SCRIPTS = 100;
const PAGE_EXTENSIONS = /\.(?:aspx|ashx|html?|cshtml|razor|php|jsp|vue)$/i;

const normalize = (route: string) => route.toLowerCase().replace(/^\/+|\/+$/g, "").replace(/\{[^}]*\}/g, "{}").replace(/^(?:\.\.?\/)+/, "");

/**
 * The chain behind a target, for "where does this call come from / where does it go": give a route
 * (`/api/orders`, `POST /Servizio/Azione`), a handler (`OrdersController.Get`, or a bare method name)
 * or a page (`ordine.aspx`), and get page → HTTP call → handler, without the rest of a block's briefing.
 */
export function traceTarget(analysis: Analysis, target: string): string {
  const wanted = target.trim();
  if (!wanted) throw new Error("Pass a route, a handler or a page.");
  const verbMatch = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+(.+)$/i.exec(wanted);
  const verb = verbMatch?.[1].toUpperCase();
  const text = (verbMatch?.[2] ?? wanted).trim();

  const pageFiles = pagesNamed(analysis, text);
  if (pageFiles.length > 0) return renderPages(analysis, pageFiles);

  const endpoints = endpointsFor(analysis, text, verb);
  const calls = analysis.httpCalls.filter((call) => matchesCall(call, text, verb) || call.handlers?.some((h) => endpoints.some((endpoint) => endpoint.handler === h.handler && endpoint.file === h.file)));
  if (endpoints.length === 0 && calls.length === 0) {
    return [
      `Nothing in the map matches \`${wanted}\`.`,
      "Cantus knows routes of the C# code (controllers, WCF, ASMX, handlers), the HTTP calls found in scripts and pages, and pages that load scripts, have inline code or are linked from code. Give a route like `/api/orders`, a handler like `OrdersController.Get`, or such a page's file name.",
    ].join("\n");
  }

  const lines: string[] = [];
  const shown = endpoints.slice(0, LIMIT);
  for (const endpoint of shown) lines.push(...renderEndpoint(analysis, endpoint), "");
  if (endpoints.length > shown.length) lines.push(`… ${endpoints.length - shown.length} more endpoint(s): narrow the route.`, "");
  const orphans = calls.filter((call) => !call.handlers?.length);
  if (orphans.length > 0) {
    lines.push("HTTP calls that match this text but no endpoint found in the C# code (a route registered at run time, or a service outside the map):");
    for (const call of orphans.slice(0, LIMIT)) lines.push(`- ${callLine(analysis, call)}`);
    if (orphans.length > LIMIT) lines.push(`- … ${orphans.length - LIMIT} more`);
  }
  return lines.join("\n").trimEnd() + "\n";
}

function endpointsFor(analysis: Analysis, text: string, verb: string | undefined): BackendEndpoint[] {
  const lower = text.toLowerCase();
  const routeLike = text.includes("/");
  const found = analysis.endpoints.filter((endpoint) => {
    if (verb && verb !== "ANY" && endpoint.method && endpoint.method !== verb) return false;
    if (routeLike) {
      const route = normalize(endpoint.route);
      return route.includes(normalize(text)) || (route.length > 0 && normalize(text).includes(route));
    }
    const handler = endpoint.handler.toLowerCase();
    return handler === lower || handler.endsWith(`.${lower}`) || normalize(endpoint.route).endsWith(`/${lower}`) || normalize(endpoint.route) === lower;
  });
  return found.sort((a, b) => a.route.localeCompare(b.route) || a.handler.localeCompare(b.handler));
}

function matchesCall(call: HttpCall, text: string, verb: string | undefined): boolean {
  if (verb && verb !== "ANY" && call.method && call.method !== verb) return false;
  const url = normalize(call.url);
  const wanted = normalize(text);
  return wanted.includes("/") ? url.includes(wanted) : url.endsWith(`/${wanted}`) || url === wanted;
}

function renderEndpoint(analysis: Analysis, endpoint: BackendEndpoint): string[] {
  const lines = [`### ${endpoint.method ?? "ANY"} ${endpoint.route} → ${endpoint.handler} (${endpoint.file}:${endpoint.line})`];
  const detail = endpointDetail(endpoint);
  if (detail) lines.push(`Contract: ${detail}.`);
  const calls = analysis.httpCalls.filter((call) => call.handlers?.some((h) => h.handler === endpoint.handler && h.file === endpoint.file));
  if (calls.length === 0) lines.push("Called from: no HTTP call found in the scripts or pages of the map. A link built in the backend, a call from outside, or a URL assembled at run time are not seen.");
  else {
    lines.push("Called from:");
    for (const call of calls.slice(0, LIMIT)) lines.push(`- ${callLine(analysis, call)}`);
    if (calls.length > LIMIT) lines.push(`- … ${calls.length - LIMIT} more (\`callers\` with \`symbol: "${endpoint.handler}"\` lists them all)`);
  }
  const csharp = findCallers(analysis, { symbol: endpoint.handler, includeSameBlock: true }).sites.filter((site) => site.via !== "http" && site.file !== endpoint.file);
  if (csharp.length > 0) {
    lines.push(`Used by other C# code (found by name, in files that use \`${endpoint.handler.split(".")[0]}\`):`);
    for (const site of csharp.slice(0, CSHARP_LINES)) lines.push(`- \`${site.file}:${site.line}\` (${site.block ?? "no block"}): \`${site.snippet}\``);
    if (csharp.length > CSHARP_LINES) lines.push(`- … ${csharp.length - CSHARP_LINES} more`);
  }
  return lines;
}

/** One HTTP call with where it sits and which pages load the script that makes it. */
function callLine(analysis: Analysis, call: HttpCall): string {
  const pages = pagesOf(analysis, call.file);
  const where = pages.length === 0 ? "" : call.file && analysis.pages.some((page) => page.file === call.file) ? " (inline in the page)" : `; loaded by ${pages.slice(0, 4).map((page) => `\`${page}\``).join(", ")}${pages.length > 4 ? `, … ${pages.length - 4} more` : ""}`;
  const handlers = call.handlers?.length ? ` → ${call.handlers.map((h) => `${h.handler} (${h.file}:${h.line})`).join(", ")}` : "";
  return `\`${call.file}:${call.line}\` (${call.block ?? "no block"}) ${call.method ?? "?"} ${call.url}${handlers}${where}: \`${call.snippet}\``;
}

function pagesOf(analysis: Analysis, file: string): string[] {
  const own = analysis.pages.filter((page) => page.file === file).map((page) => page.file);
  return [...own, ...analysis.pages.filter((page) => page.scripts.includes(file)).map((page) => page.file)];
}

function pagesNamed(analysis: Analysis, text: string): string[] {
  if (!PAGE_EXTENSIONS.test(text.split(/[?#]/)[0])) return [];
  const name = text.split(/[?#]/)[0].replace(/\\/g, "/").replace(/^\.?\/+/, "").toLowerCase();
  // Pages with scripts or inline code, and pages only a link in the backend leads to.
  const known = new Set([...analysis.pages.map((page) => page.file), ...analysis.callSites.filter((site) => site.via === "link").map((site) => site.targetFile)]);
  return [...known].filter((file) => file.toLowerCase() === name || file.toLowerCase().endsWith(`/${name}`)).sort();
}

function renderPages(analysis: Analysis, files: string[]): string {
  const lines: string[] = [];
  for (const file of files.slice(0, 5)) {
    const page = analysis.pages.find((candidate) => candidate.file === file) ?? { file, block: analysis.callSites.find((site) => site.targetFile === file)?.targetBlock, scripts: [] as string[], includes: undefined as string[] | undefined };
    lines.push(`### Page \`${file}\`${page.block ? ` (${page.block})` : ""}`);
    const links = analysis.callSites.filter((site) => site.via === "link" && site.targetFile === file);
    if (links.length > 0) {
      lines.push("Links to it are built in:");
      for (const site of links.slice(0, LIMIT)) lines.push(`- \`${site.file}:${site.line}\` (${site.block ?? "no block"})${site.match === "by-name" ? " (by name only)" : ""}: \`${site.snippet}\``);
      if (links.length > LIMIT) lines.push(`- … ${links.length - LIMIT} more`);
    } else lines.push("Links to it built in code: none found (a link written in another page, or assembled at run time, is not seen).");
    // The scripts in the order the page loads them: whoever traces a page wants them all, not the first few.
    if (page.scripts.length > 0) lines.push(`Loads ${page.scripts.length} script(s), in page order: ${page.scripts.slice(0, PAGE_SCRIPTS).map((script) => `\`${script}\``).join(", ")}${page.scripts.length > PAGE_SCRIPTS ? `, … ${page.scripts.length - PAGE_SCRIPTS} more (\`analyze --json\` lists them all)` : ""}`);
    if (page.includes?.length) lines.push(`Built from: ${page.includes.map((included) => `\`${included}\``).join(", ")} (master page, user controls and includes; their scripts run with this page).`);
    const sources = new Set([file, ...page.scripts]);
    const calls = analysis.httpCalls.filter((call) => sources.has(call.file));
    if (calls.length === 0) lines.push("HTTP calls: none found in the page or in the scripts it loads.");
    else {
      lines.push("HTTP calls (page and the scripts it loads):");
      for (const call of calls.slice(0, 25)) lines.push(`- ${callLine(analysis, call)}`);
      if (calls.length > 25) lines.push(`- … ${calls.length - 25} more`);
    }
    lines.push("");
  }
  if (files.length > 5) lines.push(`… ${files.length - 5} more page(s) with that name.`);
  return lines.join("\n").trimEnd() + "\n";
}
