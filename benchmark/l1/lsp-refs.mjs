// Ground truth for L1: ask a language server (pyright, rust-analyzer) for the references of each symbol.
// Usage: node lsp-refs.mjs <server-cmd> <langId> <root> <symbols.json> <out.json>
// symbols.json: [{name, file, line (1-based), column (1-based)}]; out: {name@file: [{file,line,column}]}
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const [cmd, langId, root, symFile, outFile] = process.argv.slice(2);
const syms = JSON.parse(fs.readFileSync(symFile, "utf8"));
const args = cmd.includes("pyright") ? ["--stdio"] : [];
const p = spawn(cmd, args, { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
let buf = Buffer.alloc(0), id = 0; const pending = new Map(); const notifs = [];
p.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const i = buf.indexOf("\r\n\r\n"); if (i < 0) return;
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, i).toString()); const len = +m[1];
    if (buf.length < i + 4 + len) return;
    const msg = JSON.parse(buf.slice(i + 4, i + 4 + len).toString()); buf = buf.slice(i + 4 + len);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error) && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.id !== undefined && msg.method) send({ jsonrpc: "2.0", id: msg.id, result: null }); // server->client requests
    else notifs.push(msg);
  }
});
function send(o) { const s = JSON.stringify(o); p.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); }
const req = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); send({ jsonrpc: "2.0", id: i, method, params }); });
const note = (method, params) => send({ jsonrpc: "2.0", method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rootUri = pathToFileURL(path.resolve(root)).href;
await req("initialize", { processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: "r" }], capabilities: { textDocument: { references: {} }, window: { workDoneProgress: true } }, initializationOptions: { cargo: { buildScripts: { enable: false } }, procMacro: { enable: false }, checkOnSave: false } /* nothing from the analysed repo or its dependencies is executed: no build.rs, no proc-macros */ });
note("initialized", {});
const opened = new Set();
async function open(file) {
  if (opened.has(file)) return; opened.add(file);
  note("textDocument/didOpen", { textDocument: { uri: pathToFileURL(path.resolve(root, file)).href, languageId: langId, version: 1, text: fs.readFileSync(path.resolve(root, file), "utf8") } });
}
const wait = +(process.env.LSP_WARMUP_MS || 15000);
// Warm-up: rust-analyzer indexes after initialize; give it time, then probe until references stop being empty.
await sleep(wait);
const out = {}; let n = 0;
for (const s of syms) {
  await open(s.file);
  let r;
  for (let attempt = 0; attempt < 6; attempt++) {
    r = await req("textDocument/references", { textDocument: { uri: pathToFileURL(path.resolve(root, s.file)).href }, position: { line: s.line - 1, character: s.column - 1 }, context: { includeDeclaration: false } });
    if (!r.error || (r.error.code !== -32801 && r.error.code !== -32802)) break; // ContentModified / ServerCancelled: retry
    await sleep(2000);
  }
  out[`${s.name}@${s.file}`] = (r.result || []).map((l) => ({ file: path.relative(root, fileURLToPath(l.uri)).replaceAll("\\", "/"), line: l.range.start.line + 1, column: l.range.start.character + 1 }));
  if (++n % 25 === 0) console.error(`${n}/${syms.length}`);
}
fs.writeFileSync(outFile, JSON.stringify(out));
await req("shutdown", null); note("exit", null); p.kill();
