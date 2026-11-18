import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { ProjectState, readServeInfo, startMapServer } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

function mappedShop() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  return root;
}

function request(server, { method = "GET", pathname = "/", host = "127.0.0.1", token, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, method, path: pathname, headers: { host: `${host}:${server.port}`, ...(token ? { "x-cantus-token": token } : {}), "content-type": "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: raw, json: () => JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function started(t) {
  const root = mappedShop();
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  t.after(() => server.close());
  const page = await request(server);
  const token = /<script type="application\/json" id="live">\{"token":"([0-9a-f]+)"(?:,"session":true)?,"root":".*"\}<\/script>/.exec(page.text)?.[1];
  return { root, server, page, token };
}

test("the live map is served on localhost with a per-process token", async (t) => {
  const { root, server, page, token } = await started(t);
  assert.equal(page.status, 200);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.ok(token, "the page carries the token");
  assert.match(page.text, /<title>Cantus · shop<\/title>/);

  assert.equal((await request(server, { host: "evil.example" })).status, 403, "DNS rebinding: non-local host names are refused");
  assert.equal((await request(server, { pathname: "/api/view" })).status, 403, "API calls need the token");
  assert.equal((await request(server, { pathname: "/api/view", token })).json().blocks.length, 6);
  assert.equal(readServeInfo(root).url, server.url);
  await server.close();
  assert.equal(readServeInfo(root), undefined);
});

test("the browser's request for favicon.ico is not an error: the page names an icon, and the default answers empty", async (t) => {
  const { server, page } = await started(t);
  assert.match(page.text, /<link rel="icon" href="data:image\/svg\+xml,/);
  const asked = await request(server, { pathname: "/favicon.ico" });
  assert.equal(asked.status, 204, "no token needed, no 403 in the console");
  assert.equal((await request(server, { pathname: "/favicon.ico", host: "evil.example" })).status, 403, "still only for local host names");
});

test("groups are saved and deleted from the map, and selections get their scope", async (t) => {
  const { root, server, token } = await started(t);
  const scope = (await request(server, { pathname: "/api/scope?blocks=src-checkout,src-pricing", token })).json();
  assert.deepEqual(scope.neighbors, ["src-orders", "src-payments"]);
  assert.equal(scope.callers, 1);
  assert.ok(scope.contextTokens > 0);

  const saved = await request(server, { method: "POST", pathname: "/api/groups", token, body: { id: "pay", name: "Pay", blocks: ["src-checkout", "src-payments"] } });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".cantus/model.json"), "utf8")).groups, [{ id: "pay", name: "Pay", blocks: ["src-checkout", "src-payments"] }]);
  assert.equal((await request(server, { pathname: "/api/view", token })).json().groups[0].id, "pay");

  const bad = await request(server, { method: "POST", pathname: "/api/groups", token, body: { id: "x", blocks: ["src-nope"] } });
  assert.equal(bad.status, 400);
  assert.match(bad.json().error, /Unknown block/);
  assert.equal((await request(server, { method: "POST", pathname: "/api/groups", body: { id: "x", blocks: ["src-web"] } })).status, 403);

  assert.equal((await request(server, { method: "DELETE", pathname: "/api/groups/pay", token })).status, 200);
  assert.equal((await request(server, { method: "DELETE", pathname: "/api/groups/pay", token })).status, 404);
});

test("the page's data is reused while nothing it shows changed, and rebuilt as soon as something does", async (t) => {
  const { root, server, token } = await started(t);
  const view = async () => (await request(server, { pathname: "/api/view", token })).json();
  const first = await view();
  const again = await view();
  assert.deepEqual({ ...again, generatedAt: "" }, { ...first, generatedAt: "" }, "nothing changed: the same page data");

  const pricing = path.join(root, "src/pricing/index.ts");
  const tokensOf = (data) => data.blocks.find((block) => block.id === "src-pricing").tokens;
  fs.appendFileSync(pricing, "\nexport const vat: number = 0.22;\nexport const rounding: number = 2;\n");
  assert.ok(tokensOf(await view()) > tokensOf(first), "a source file changed: the block's size follows");

  fs.writeFileSync(path.join(root, "docs.md"), "x".repeat(400));
  assert.equal((await request(server, { method: "POST", pathname: "/api/docs", body: { path: "docs.md", common: true }, token })).status, 200);
  const small = (await view()).docs.find((doc) => doc.path === "docs.md").tokens;
  fs.writeFileSync(path.join(root, "docs.md"), "x".repeat(4000));
  assert.ok((await view()).docs.find((doc) => doc.path === "docs.md").tokens > small, "an assigned document grew without the code changing: its size follows");

  assert.equal((await request(server, { method: "POST", pathname: "/api/map/blocks", token, body: { name: "Extra", layer: first.layers[0] } })).status, 200);
  assert.ok((await view()).blocks.some((block) => block.id === "src-extra"), "a change to the map is shown at once");
});

test("the project is analyzed once the server is up, not when the first page asks for it; unless told not to", async (t) => {
  const analyses = async (options) => {
    const state = new ProjectState(mappedShop());
    let calls = 0;
    const get = state.get.bind(state);
    state.get = () => (calls++, get());
    const server = await startMapServer(state, { port: 0, pollInterval: 100, ...options });
    t.after(() => server.close());
    await new Promise((resolve) => setTimeout(resolve, 150));
    return calls;
  };
  assert.ok((await analyses({})) >= 1, "ready before anyone asks");
  assert.equal(await analyses({ warm: false }), 0, "nothing is analyzed until a request needs it");
});

test("watching for changes backs off when looking at the files is slow, so it cannot take over the process", async (t) => {
  const state = new ProjectState(mappedShop());
  let looks = 0;
  const fingerprint = state.fingerprint.bind(state);
  state.fingerprint = () => {
    looks++;
    const until = Date.now() + 100; // a big project: every look takes a while
    while (Date.now() < until);
    return fingerprint();
  };
  const server = await startMapServer(state, { port: 0, pollInterval: 20, warm: false });
  t.after(() => server.close());
  const events = http.get({ host: "127.0.0.1", port: server.port, path: "/api/events", headers: { host: `127.0.0.1:${server.port}` } }, () => {});
  events.on("error", () => {});
  t.after(() => events.destroy());
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // Without backing off: one look every ~120 ms, about twelve. Backing off: every ~400 ms.
  assert.ok(looks >= 2 && looks <= 6, `${looks} looks in 1.5 s`);
});

test("open pages are told when the code changes", async (t) => {
  const { root, server } = await started(t);
  const changed = new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: server.port, path: "/api/events", headers: { host: `127.0.0.1:${server.port}` } }, (res) => {
      res.on("data", (chunk) => {
        if (String(chunk).includes("event: changed")) {
          req.destroy();
          resolve(true);
        }
      });
    });
    req.on("error", () => {});
    setTimeout(() => reject(new Error("no change event")), 5000);
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.writeFileSync(path.join(root, "src/pricing/index.ts"), fs.readFileSync(path.join(root, "src/pricing/index.ts"), "utf8") + "\nexport const vat: number = 0.22;\n");
  assert.equal(await changed, true);
});

test("the new analysis is ready before the page asks for it", async (t) => {
  const root = mappedShop();
  const state = new ProjectState(root);
  const server = await startMapServer(state, { port: 0, pollInterval: 100 });
  t.after(() => server.close());
  const first = state.get();
  let connected;
  const ready = new Promise((resolve) => (connected = resolve));
  const changed = new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: server.port, path: "/api/events", headers: { host: `127.0.0.1:${server.port}` } }, (res) => {
      res.on("data", (chunk) => {
        connected();
        if (String(chunk).includes("event: changed")) {
          req.destroy();
          resolve(true);
        }
      });
    });
    req.on("error", () => {});
    setTimeout(() => reject(new Error("no change event")), 15000);
  });
  await ready;
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.appendFileSync(path.join(root, "src/pricing/index.ts"), "\nexport const warm = 1;\n");
  await changed;
  // Without asking for it: the server's own look, which may take a while on a loaded machine.
  let warm = false;
  for (let i = 0; i < 100 && !warm; i++) {
    warm = state.cached?.fingerprint === state.fingerprint() && state.cached.snapshot !== first;
    if (!warm) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(warm, "the server analyzed the new code on its own, before any request");
});

test("a map file is shown against the last commit, and only map files are", async (t) => {
  const { root, server, token } = await started(t);
  const { execFileSync } = await import("node:child_process");
  const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "empty");
  run("add", "package.json");
  run("-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "package");
  fs.writeFileSync(path.join(root, "notes.txt"), "outside the blocks but changed\n");
  const diff = (file) => request(server, { pathname: `/api/file-diff?path=${encodeURIComponent(file)}`, token });

  assert.equal((await request(server, { pathname: "/api/file-diff?path=src/pricing/index.ts" })).status, 403, "the token is required");
  const pricing = (await diff("src/pricing/index.ts")).json();
  assert.equal(pricing.status, "added", "nothing committed yet: the whole file is new");
  assert.ok(pricing.ops.length > 0 && pricing.ops.every((op) => op.type === "add"));
  assert.equal((await diff("notes.txt")).json().status, "added", "changed files outside the blocks can be read");
  assert.equal((await diff("../outside.txt")).status, 404);
  assert.equal((await diff("package.json")).status, 404, "committed files outside the blocks are not served");
});

test("the page offers the Changes tab, diff modes and file-to-file navigation", async (t) => {
  const { page, root } = await started(t);
  const live = JSON.parse(/<script type="application\/json" id="live">([\s\S]*?)<\/script>/.exec(page.text)[1]);
  assert.equal(live.root, root, "the page knows the project folder, for the VS Code links");
  const scripts = [...page.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0);
  for (const code of scripts) new vm.Script(code); // a stray newline in a string would stop the whole page
  assert.match(page.text, /<nav id="tabs">/);
  assert.match(page.text, /<div id="changesview" hidden>/);
  for (const label of ["Diff", "Side by side", "File"]) assert.ok(page.text.includes(`["${label === "Side by side" ? "side" : label.toLowerCase()}", tr("${label}")]`), label);
  assert.match(page.text, /fileNav/);
  assert.match(page.text, /Open in VS Code/);
  assert.match(page.text, /Ask Claude/);
  // From the block's files: an Open on each file card and in the file's panel, to the same view with Open in VS Code.
  assert.match(page.text, /el\("button", "file-open", tr\("Open"\)\)/);
  // The task form offers a model for a separate session.
  assert.match(page.text, /if \(model\.value\) body\.model = model\.value;/);
  assert.match(page.text, /var openIt = el\("button", null, tr\("Open"\)\)/);
});

test("the project state notices changes to C# files and pages, not only JavaScript", async () => {
  const { ProjectState: State } = await import("../dist/index.js");
  const root = copyFixture("csharp");
  const state = new State(root);
  const before = state.fingerprint();
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.appendFileSync(path.join(root, "Default.aspx.cs"), "// touched\n");
  const afterCs = state.fingerprint();
  assert.notEqual(afterCs, before);
  fs.writeFileSync(path.join(root, "web/page.aspx"), "<script src=\"js/orders.js\"></script>\n");
  assert.notEqual(state.fingerprint(), afterCs);
});
