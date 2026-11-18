// Precision/recall of Cantus callers against language-server references, cross-file only.
// Usage: node compare.mjs <analysis.json> <refs.json> [ignore-lines.json]
// ignore-lines.json: {file: [lines]} import statements / re-exports to drop on the ground-truth side (Cantus reports uses, not the import line).
// ONLY_FILES=files.json (a JSON list): count only the files the language server could see (Go: the files built for this system, from `go list`).
// CANTUS_DIST: the compiled Cantus (default: ../../dist).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Cantus does not report uses in tests/docs (support files): the ground truth must not count them either.
const dist = process.env.CANTUS_DIST || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dist");
const { isSupportFile } = await import(pathToFileURL(path.join(dist, "analysis/support.js")).href);
const [aFile, rFile, ignFile] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(aFile, "utf8")).analysis;
const refs = JSON.parse(fs.readFileSync(rFile, "utf8"));
const ign = ignFile ? JSON.parse(fs.readFileSync(ignFile, "utf8")) : {};
const only = process.env.ONLY_FILES ? new Set(JSON.parse(fs.readFileSync(process.env.ONLY_FILES, "utf8"))) : undefined;
const ignored = (f, l) => isSupportFile(f) || (ign[f] || []).includes(l);
let tp = 0, fp = 0, fn = 0, tpF = 0, fpF = 0, fnF = 0, n = 0, empty = 0;
const rows = [];
for (const [key, truth] of Object.entries(refs)) {
  const name = key.slice(0, key.indexOf("@")), file = key.slice(key.indexOf("@") + 1);
  const T = new Set(truth.filter((r) => r.file !== file && !ignored(r.file, r.line)).map((r) => `${r.file}:${r.line}`));
  // Cantus reads tests in C# and Java and reports uses in them: they leave the count on this side too, as on the truth side.
  const C = new Set(a.callSites.filter((s) => s.symbol === name && s.targetFile === file && s.file !== file && !isSupportFile(s.file) && (!only || (only.has(s.file) && only.has(s.targetFile)))).map((s) => `${s.file}:${s.line}`));
  const Tf = new Set([...T].map((x) => x.split(":")[0])), Cf = new Set([...C].map((x) => x.split(":")[0]));
  const inter = (A, B) => [...A].filter((x) => B.has(x)).length;
  if (T.size === 0 && C.size === 0) { empty++; continue; }
  n++; tp += inter(C, T); fp += C.size - inter(C, T); fn += T.size - inter(C, T);
  tpF += inter(Cf, Tf); fpF += Cf.size - inter(Cf, Tf); fnF += Tf.size - inter(Cf, Tf);
  rows.push({ key, truth: T.size, cantus: C.size, hit: inter(C, T), onlyCantus: [...C].filter((x) => !T.has(x)).slice(0, 4), onlyTruth: [...T].filter((x) => !C.has(x)).slice(0, 4) });
}
const f = (x) => (x * 100).toFixed(1) + "%";
console.log(JSON.stringify({ symbolsWithUses: n, symbolsNoUsesBoth: empty,
  callSite: { tp, fp, fn, precision: f(tp / (tp + fp || 1)), recall: f(tp / (tp + fn || 1)) },
  file: { tp: tpF, fp: fpF, fn: fnF, precision: f(tpF / (tpF + fpF || 1)), recall: f(tpF / (tpF + fnF || 1)) } }, null, 1));
fs.writeFileSync(rFile.replace(/\.json$/, ".diff.json"), JSON.stringify(rows.filter((r) => r.truth !== r.hit || r.cantus !== r.hit), null, 1));
