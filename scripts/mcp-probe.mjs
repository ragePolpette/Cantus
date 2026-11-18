#!/usr/bin/env node
// Measures Cantus's MCP tools on a project: time and size of each answer.
// Usage: node scripts/mcp-probe.mjs <project-dir> [out.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(process.argv[2] ?? ".");
const out = process.argv[3];
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const LIMIT = 25_000; // Claude Code's default limit for one MCP answer, in tokens

const client = new Client({ name: "cantus-probe", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--no-ui", "-C", root], stderr: "inherit" }));

const results = [];
async function probe(name, args = {}) {
  const started = Date.now();
  let text = "";
  let isError = false;
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
    text = result.content.map((part) => part.text ?? "").join("\n");
    isError = !!result.isError;
  } catch (error) {
    text = String(error?.message ?? error);
    isError = true;
  }
  const entry = { tool: name, args, ms: Date.now() - started, chars: text.length, tokens: Math.round(text.length / 4), isError, ...(isError ? { error: text.slice(0, 500) } : {}) };
  if (entry.tokens > LIMIT) entry.overLimit = true;
  results.push(entry);
  console.error(`${name.padEnd(14)} ${JSON.stringify(args).slice(0, 50).padEnd(50)} ${String(entry.ms).padStart(6)} ms ${String(entry.tokens).padStart(7)} tok${entry.overLimit ? "  OVER LIMIT" : ""}${isError ? "  ERROR" : ""}`);
  return text;
}

const tools = (await client.listTools()).tools.map((tool) => tool.name);
console.error(`Tools: ${tools.join(", ")}\n`);
const map = await probe("map");
await probe("check");
const blocks = [...map.matchAll(/^## .*\(`([^`]+)`, [a-z]+\)$/gm)].map((match) => match[1]);
for (const block of blocks) await probe("block_context", { block });
for (const query of ["format", "parse", "user", "config", "error"]) await probe("find_api", { query });
const firstExport = /^\[[^\]]+\] [^:]+: (?:async )?(?:function|class|const|interface|type) ([A-Za-z_$][\w$]*)/m.exec(await probe("find_api", { query: "create" }))?.[1];
if (firstExport) await probe("callers", { symbol: firstExport });

await client.close();
const summary = {
  root,
  at: new Date().toISOString(),
  blocks: blocks.length,
  slowest: [...results].sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => `${r.tool} ${JSON.stringify(r.args)} ${r.ms} ms`),
  largest: [...results].sort((a, b) => b.tokens - a.tokens).slice(0, 5).map((r) => `${r.tool} ${JSON.stringify(r.args)} ~${r.tokens} tok`),
  overLimit: results.filter((r) => r.overLimit).length,
  errors: results.filter((r) => r.isError).length,
  results,
};
if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.error(`\n${blocks.length} blocks · ${summary.overLimit} answers over ${LIMIT} tokens · ${summary.errors} errors${out ? ` · written to ${out}` : ""}`);
