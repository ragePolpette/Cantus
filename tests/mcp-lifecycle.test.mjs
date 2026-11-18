import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("the saved map server starts without analysis and its serve.json goes away when the client leaves", async (t) => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  const serveFile = path.join(root, ".cantus/cache/serve.json");
  const indexFile = path.join(root, ".cantus/cache/index.json");
  const client = new Client({ name: "test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root], stderr: "pipe" }));

  const info = await until(() => (fs.existsSync(serveFile) ? JSON.parse(fs.readFileSync(serveFile, "utf8")) : undefined), "the live map to start");
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const answer = (await client.callTool({ name: "open_map", arguments: {} })).content[0].text;
  assert.ok(answer.includes(info.url), "open_map gives the address of the map that started later");

  const event = await fetch(new URL("api/agents", info.url), {
    method: "POST", headers: { "content-type": "application/json", "x-cantus-token": info.token },
    body: JSON.stringify({ phase: "start", id: "test", type: "block-src-orders" }),
  });
  assert.equal(event.status, 200);
  assert.equal(fs.existsSync(indexFile), false, "neither binding the server nor handling a hook starts analysis");
  assert.equal((await fetch(info.url)).status, 200);
  assert.equal(fs.existsSync(indexFile), true, "opening the browser view explicitly analyzes the project");

  await client.close();
  await until(() => !fs.existsSync(serveFile), "serve.json to be removed when the client closed the connection");
});

test("an unmapped MCP root stays idle until an explicit request", async (t) => {
  const root = copyFixture("shop");
  const metadata = path.join(root, ".cantus");
  const client = new Client({ name: "test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root], stderr: "pipe" }));
  assert.ok((await client.listTools()).tools.some(({ name }) => name === "update_map"));
  assert.equal(fs.existsSync(metadata), false);

  const map = await client.callTool({ name: "update_map", arguments: {} });
  assert.equal(map.isError, undefined);
  assert.ok(fs.existsSync(path.join(metadata, "model.json")));
  assert.ok(fs.existsSync(path.join(metadata, "cache/index.json")));
  const live = await client.callTool({ name: "open_map", arguments: {} });
  assert.match(live.content[0].text, /^The live map is at http:\/\/127\.0\.0\.1:/);
});
