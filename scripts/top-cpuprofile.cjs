// Usage: node scripts/top-cpuprofile.cjs <dir-with-.cpuprofile> [rows]   — prints where the time went (self and total, per function).
const fs = require("fs");
const dir = process.argv[2];
const rows = Number(process.argv[3] ?? 25);
const file = fs.readdirSync(dir).filter((name) => name.endsWith(".cpuprofile")).map((name) => ({ name, size: fs.statSync(dir + "/" + name).size })).sort((a, b) => b.size - a.size)[0].name;
const p = JSON.parse(fs.readFileSync(dir + "/" + file));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
p.nodes.forEach((n) => (n.children || []).forEach((c) => parent.set(c, n.id)));
const self = new Map(), total = new Map(), dt = p.timeDeltas;
const key = (n) => n.callFrame.functionName + " " + n.callFrame.url.split(/[\\/]/).slice(-2).join("/") + ":" + (n.callFrame.lineNumber + 1);
p.samples.forEach((id, i) => {
  const n = byId.get(id);
  self.set(key(n), (self.get(key(n)) || 0) + dt[i]);
  const seen = new Set();
  for (let c = id; c; c = parent.get(c)) {
    const k = key(byId.get(c));
    if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) || 0) + dt[i]); }
  }
});
const show = (m, t) => console.log(t + "\n" + [...m].sort((a, b) => b[1] - a[1]).slice(0, rows).map(([k, v]) => (v / 1000).toFixed(0) + " ms  " + k).join("\n") + "\n");
show(self, "SELF (time inside the function itself)");
show(total, "TOTAL (function and what it calls)");
