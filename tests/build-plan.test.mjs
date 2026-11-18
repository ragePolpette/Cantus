import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { ProjectState, TaskManager, analyze, autonomousPolicy, buildPlan, exportClaudeAgents, renderPlan, startMapServer } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

/** The shop plus a sketch: wishlist (uses orders) and alerts (uses wishlist), both without code; web should use wishlist. */
function sketchedShop() {
  const model = shopModel();
  model.blocks.push(
    { id: "src-alerts", name: "Alerts", layer: "application", include: ["src/alerts"], description: "Emails when a price drops." },
    { id: "src-wishlist", name: "Wishlist", layer: "domain", include: ["src/wishlist"], description: "Saved products." },
  );
  model.dependencies.push({ from: "src-alerts", to: "src-wishlist" }, { from: "src-wishlist", to: "src-orders" }, { from: "src-web", to: "src-wishlist" });
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(model, null, 2));
  return { root, model };
}

test("the plan lists blocks without code in waves, providers first, and arrows the code lacks", () => {
  const { root, model } = sketchedShop();
  const analysis = analyze(root, { model, skipGit: true });
  const plan = buildPlan(analysis, model);
  assert.deepEqual(plan.waves.map((wave) => wave.map((block) => block.id)), [["src-wishlist"], ["src-alerts"]]);
  assert.deepEqual(plan.arrows, [{ from: "src-alerts", to: "src-wishlist" }, { from: "src-wishlist", to: "src-orders" }, { from: "src-web", to: "src-wishlist" }]);
  const text = renderPlan(plan, analysis);
  assert.match(text, /### Wave 1\n\n- `src-wishlist` Wishlist \(domain\), folder `src\/wishlist` — Saved products\. Uses: `src-orders`\. Will be used by: `src-alerts`, `src-web`\./);
  assert.match(text, /### Wave 2\n\n- `src-alerts` Alerts/);
  assert.match(text, /- Web \(`src-web`\) → Wishlist \(`src-wishlist`\)/);

  // Planned blocks that use each other in a loop are built together.
  const loop = { ...model, dependencies: [...model.dependencies, { from: "src-wishlist", to: "src-alerts" }] };
  assert.deepEqual(buildPlan(analyze(root, { model: loop, skipGit: true }), loop).waves.map((wave) => wave.map((block) => block.id).sort()), [["src-alerts", "src-wishlist"]]);
});

function scriptedRunner(seen) {
  return (request) => ({
    async *[Symbol.asyncIterator]() {
      seen.push(request.prompt);
      yield { type: "result", ok: true, text: "Built." };
    },
  });
}

test("building the plan is a coordinated task briefed with the plan; with nothing planned it does not start", async () => {
  const { root } = sketchedShop();
  const prompts = [];
  const tasks = new TaskManager(new ProjectState(root), scriptedRunner(prompts));
  const task = tasks.start({ build: true, prompt: "", mode: "edit" });
  await tasks.wait(task.id);
  assert.equal(task.build, true);
  assert.equal(task.orchestrated, true);
  assert.equal(task.prompt, "Build the planned parts of the map.");
  assert.match(prompts[0], /Task: build the plan\./);
  assert.match(prompts[0], /- `src-alerts` Alerts \(application\).*Uses: src-wishlist \(planned\)\..*Planned: no code yet\./, "the project briefing shows planned arrows and blocks");
  assert.match(prompts[0], /### Wave 1/);
  assert.match(prompts[0], /0\. First the project's skeleton, if it has none yet.*Do it yourself, before any wave/, "a new project gets its manifest once, not one per parallel block");
  assert.doesNotMatch(prompts[0], /Notes from the developer/);

  const withNotes = tasks.start({ build: true, prompt: "Use plain fetch, no libraries.", mode: "edit" });
  await tasks.wait(withNotes.id);
  assert.match(prompts[1], /Notes from the developer: Use plain fetch, no libraries\./);

  const plain = copyFixture("shop");
  fs.mkdirSync(path.join(plain, ".cantus"), { recursive: true });
  const model = shopModel();
  const analysis = analyze(plain, { model, skipGit: true });
  model.dependencies = analysis.dependencies.map((dep) => ({ from: dep.from, to: dep.to }));
  fs.writeFileSync(path.join(plain, ".cantus/model.json"), JSON.stringify(model));
  assert.throws(() => new TaskManager(new ProjectState(plain), scriptedRunner([])).start({ build: true, prompt: "" }), /Nothing planned/);
});

function post(server, pathname, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, method: "POST", path: pathname, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "x-cantus-token": server.token } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("from the map, building the plan first gives sketched blocks their specialist, where specialists are used", async (t) => {
  const { root, model } = sketchedShop();
  // Specialists generated before the sketch: none for the planned blocks yet.
  exportClaudeAgents(analyze(root, { model: shopModel(), skipGit: true }), shopModel());
  assert.ok(!fs.existsSync(path.join(root, ".claude/agents/block-src-wishlist.md")));
  const server = await startMapServer(new ProjectState(root), { port: 0, runner: scriptedRunner([]) });
  t.after(() => server.close());
  const started = await post(server, "/api/tasks", { build: true, prompt: "", mode: "edit" });
  assert.equal(started.status, 201);
  assert.equal(started.json.build, true);
  assert.ok(fs.existsSync(path.join(root, ".claude/agents/block-src-wishlist.md")));
  assert.ok(model.blocks.length > 0);

  // A project that does not use specialists gets none.
  const { root: bare } = sketchedShop();
  const other = await startMapServer(new ProjectState(bare), { port: 0, runner: scriptedRunner([]) });
  t.after(() => other.close());
  assert.equal((await post(other, "/api/tasks", { build: true, prompt: "" })).status, 201);
  assert.ok(!fs.existsSync(path.join(bare, ".claude/agents")));
});

test("building the plan lets the coordinator lay down the skeleton files that belong to no block, unattended too", async () => {
  const { root } = sketchedShop();
  const answers = [];
  const runner = (request) => ({
    async *[Symbol.asyncIterator]() {
      for (const file of ["pyproject.toml", ".gitignore", ".cantus/model.json", ".claude/settings.json", "src/db/client.ts"]) {
        const answer = await request.canUseTool("Write", { file_path: path.join(request.cwd, file), content: "x" }, request.abort.signal);
        answers.push(`${file} ${answer.allow}`);
      }
      yield { type: "result", ok: true, text: "Built." };
    },
  });
  const tasks = new TaskManager(new ProjectState(root), runner, { policy: autonomousPolicy() });
  const build = tasks.start({ build: true, prompt: "", mode: "edit" });
  await tasks.wait(build.id);
  assert.deepEqual(answers, [
    "pyproject.toml true",
    ".gitignore true",
    ".cantus/model.json false",
    ".claude/settings.json false",
    "src/db/client.ts true",
  ], "a build covers every block, so a block's file is in scope; Cantus's and Claude Code's folders are not");

  answers.length = 0;
  const edit = tasks.start({ block: "src-web", prompt: "Tidy.", mode: "edit" });
  await tasks.wait(edit.id);
  assert.equal(answers[0], "pyproject.toml false", "any other task still refuses files outside its blocks");
});
