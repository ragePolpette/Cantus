// Exported symbols from a Cantus analysis (analyze --json) -> symbols.json for lsp-refs.mjs.
// Usage: node extract-symbols.mjs <root> <analysis.json> <out.json> [max]
import fs from "node:fs";
import path from "node:path";
const [root, aFile, out, max = "300"] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(aFile, "utf8")).analysis;
const res = [];
for (const e of a.catalog) {
  const lines = fs.readFileSync(path.join(root, e.file), "utf8").split(/\r?\n/);
  let line = e.line;
  let col = -1;
  for (let k = 0; k < 6 && line - 1 + k < lines.length; k++) {
    const t = lines[line - 1 + k]; const m = new RegExp(`\\b${e.name.replace(/[$]/g, "\\$")}\\b`).exec(t);
    if (m && !/^\s*(#|\/\/|\[)/.test(t)) { col = m.index + 1; line = line + k; break; }
  }
  if (col < 0) continue;
  res.push({ name: e.name, file: e.file, line, column: col, kind: e.kind, block: e.block });
}
res.sort((x, y) => (x.file + x.line).localeCompare(y.file + y.line));
const step = Math.max(1, res.length / +max);
const pick = []; for (let i = 0; i < res.length; i += step) pick.push(res[Math.floor(i)]);
fs.writeFileSync(out, JSON.stringify(pick, null, 1));
console.error(`${res.length} symbols with a position, ${pick.length} picked`);
