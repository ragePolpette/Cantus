#!/usr/bin/env node
// Measures what the live map costs on a project: the analysis (warm and after a change), the page's data and size, and the
// server's answer to a page request. Writes nothing to the project except what Cantus keeps in `.cantus/cache` and `.cantus/analysis.log`.
// Usage: node scripts/measure-map.mjs <project-dir> [--cold] [--json] [--profile <dir>] [out.json]
//   --cold   also analyzes with no cache on disk. The cache is moved aside for the run and put back at the end (it is rebuilt by any run anyway).
//   --profile <dir>   writes a CPU profile of the three re-analyses only (what a map edit costs), not of the first analysis; read it with
//                     `node scripts/top-cpuprofile.cjs <dir>`.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import inspector from "node:inspector";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const profileAt = args.indexOf("--profile");
const profileDir = profileAt === -1 ? undefined : path.resolve(args[profileAt + 1] ?? "");
if (profileAt !== -1) args.splice(profileAt, 2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const positional = args.filter((arg) => !arg.startsWith("--"));
const root = path.resolve(positional[0] ?? ".");
const out = positional[1];
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const { ProjectState, buildViewData, lightView, renderViewHtml, startMapServer } = await load("index.js");
const { readChanges } = await load("state", "changes.js");

const results = {};
const ms = (from) => Math.round(performance.now() - from);
function step(label, run) {
  const started = performance.now();
  const value = run();
  results[label] = ms(started);
  console.error(`${label.padEnd(44)} ${String(results[label]).padStart(7)} ms`);
  return value;
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let first = 0;
    http
      .get({ host: "127.0.0.1", port, path: pathname, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let bytes = 0;
        res.on("data", (chunk) => {
          if (!first) first = ms(started);
          bytes += chunk.length;
        });
        res.on("end", () => resolve({ first, total: ms(started), bytes }));
      })
      .on("error", reject);
  });
}

const cache = path.join(root, ".cantus", "cache");
const aside = `${cache}.measure-aside`;
if (flags.has("--cold") && fs.existsSync(cache)) {
  if (fs.existsSync(aside)) throw new Error(`${aside} is left from an earlier run: put it back as ${cache} (or delete it) first.`);
  fs.renameSync(cache, aside);
}
try {
  console.error(`Project: ${root}\n`);
  const state = new ProjectState(root);
  step("scan for changes (what the page polls)", () => state.fingerprint());
  step("scan for changes, again", () => state.fingerprint());
  const snapshot = step(flags.has("--cold") ? "analysis, no cache on disk" : "analysis (cache on disk as it is)", () => state.get());
  const files = snapshot.analysis.blocks.reduce((sum, info) => sum + info.files.length, 0);
  results.blocks = snapshot.analysis.blocks.length;
  results.files = files;
  console.error(`${"".padEnd(44)} ${files} files, ${results.blocks} blocks`);
  step("analysis, nothing changed (kept)", () => state.get());
  let profiler;
  if (profileDir) {
    profiler = new inspector.Session();
    profiler.connect();
    const post = (method, params) => new Promise((resolve, reject) => profiler.post(method, params, (error, result) => (error ? reject(error) : resolve(result))));
    profiler.run = post;
    await post("Profiler.enable");
    await post("Profiler.start");
  }
  for (let i = 1; i <= 3; i++) {
    state.invalidate();
    step(`analysis after a map edit or a code change #${i}`, () => state.get());
  }
  if (profiler) {
    const { profile } = await profiler.run("Profiler.stop");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, "reanalysis.cpuprofile"), JSON.stringify(profile));
    profiler.disconnect();
    console.error(`${"CPU profile of the three re-analyses".padEnd(44)} ${path.join(profileDir, "reanalysis.cpuprofile")}`);
  }
  const changes = step("changes since the last commit (git)", () => readChanges(root));
  const view = step("page data (buildViewData)", () => buildViewData(snapshot.analysis, snapshot.model, snapshot.findings, changes, () => []));
  const html = step("page text (renderViewHtml), as the live map serves it", () => renderViewHtml(lightView(view), { live: { token: "x", root } }));
  results.pageKB = Math.round(html.length / 1024);
  results.pageWholeKB = Math.round(renderViewHtml(view, { live: { token: "x", root } }).length / 1024);
  results.pageParts = Object.fromEntries(
    Object.entries(view)
      .map(([key, value]) => [key, Math.round((JSON.stringify(value)?.length ?? 0) / 1024)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6),
  );
  console.error(`${"".padEnd(44)} page ${results.pageKB} KB (${results.pageWholeKB} KB with the call sites and contracts a live page leaves out); biggest parts of the whole (KB): ${Object.entries(results.pageParts).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  const server = await startMapServer(new ProjectState(root), { port: 0, warm: false });
  try {
    const page = [];
    for (let i = 0; i < 4; i++) page.push(await get(server.port, "/"));
    results.serverPage = page.map((entry) => ({ firstByteMs: entry.first, totalMs: entry.total, bytes: entry.bytes }));
    console.error(`${"GET / on the map server (1st, then 3 more)".padEnd(44)} ${page.map((entry) => `${entry.total} ms`).join(", ")} (${Math.round(page[0].bytes / 1024)} KB)`);
  } finally {
    await server.close();
  }
} finally {
  if (fs.existsSync(aside)) {
    fs.rmSync(cache, { recursive: true, force: true });
    fs.renameSync(aside, cache);
  }
}

if (flags.has("--json")) console.log(JSON.stringify(results, null, 2));
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2));
