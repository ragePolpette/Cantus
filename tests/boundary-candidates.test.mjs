import assert from "node:assert/strict";
import test from "node:test";
import { boundaryCandidates, evaluateCandidates, fileStem, renderCandidates } from "../dist/index.js";

const block = (id, include, files) => ({ block: { id, include }, files });
const commit = (n, ...files) => ({ hash: `c${n}`, files });

/** A small API: one function (user) spread over controllers, services and models, and one (auth) the same way. */
function input() {
  const files = {
    "src/controllers": ["src/controllers/user.controller.js", "src/controllers/auth.controller.js"],
    "src/services": ["src/services/user.service.js", "src/services/auth.service.js"],
    "src/models": ["src/models/user.model.js", "src/models/token.model.js"],
    "src/docs": ["src/docs/swagger.js"],
    "src/routes": ["src/routes/index.js", "src/routes/user.route.js"],
  };
  const blocks = Object.entries(files).map(([include, list]) => block(include.replace("/", "-"), [include], list));
  const all = Object.values(files).flat();
  return {
    blocks,
    fileTokens: Object.fromEntries(all.map((file) => [file, 100])),
    fileImports: [{ from: "src/routes/user.route.js", to: "src/controllers/user.controller.js" }],
  };
}

/** Newest first, like git log: the same habits all along. */
function history(count) {
  const commits = [];
  for (let n = 0; n < count; n++) {
    if (n % 3 === 0) commits.push(commit(n, "src/controllers/user.controller.js", "src/services/user.service.js", "src/models/user.model.js"));
    else if (n % 3 === 1) commits.push(commit(n, "src/controllers/auth.controller.js", "src/services/auth.service.js", "src/models/token.model.js"));
    else commits.push(commit(n, "src/docs/swagger.js", "src/routes/user.route.js"));
  }
  return commits;
}

test("a file name without its role is the subject of the file", () => {
  assert.equal(fileStem("src/controllers/user.controller.js"), "user");
  assert.equal(fileStem("src/Services/BasketService.cs"), "basket");
  assert.equal(fileStem("a/OrderDetailsEndpoint.cs"), "order-details");
  assert.equal(fileStem("a/index.js"), "");
});

test("files of one function spread over blocks are gathered, with the commits as proof", () => {
  const candidates = boundaryCandidates(input(), history(90));
  const features = candidates.filter((candidate) => candidate.kind === "feature" && !candidate.combined);
  assert.ok(features.length >= 2, "user and auth");
  const user = features.find((candidate) => candidate.proposal.ops[0].to === "feature-user");
  assert.deepEqual(user.proposal.ops[0].files, ["src/controllers/user.controller.js", "src/models/user.model.js", "src/services/user.service.js"]);
  assert.match(user.evidence[0], /Changed together: .* 30 commits/);
  assert.match(user.evidence[1], /src-controllers.*src-models.*src-services|Now in/);
  assert.ok(candidates.some((candidate) => candidate.kind === "feature" && candidate.combined), "all the features together too");
});

test("candidates are judged on the newest commits, and the ones that pass are listed", () => {
  const results = evaluateCandidates(input(), history(120));
  const user = results.find((entry) => entry.proposal.ops[0].to === "feature-user");
  assert.equal(user.comparison.verdict, "passes");
  assert.ok(user.after.coverage > user.before.coverage);
  const text = renderCandidates(results);
  assert.match(text, /\[passes\] Gather 3 files of `user`/);
  assert.match(text, /nothing is changed by this list/i);
  assert.ok(results.findIndex((entry) => entry.comparison.verdict === "passes") === 0, "passing ones first");
});

test("with too few commits nothing is decided, and the list says what is missing", () => {
  const results = evaluateCandidates(input(), history(30));
  assert.ok(results.length > 0);
  assert.ok(results.every((entry) => entry.comparison.verdict === "undecided"));
  assert.match(renderCandidates(results), /none passes the measure/);
  assert.match(renderCandidates(results, { all: true }), /\[undecided\]/);
  assert.match(renderCandidates([]), /No candidate/);
});

test("a block of one file goes to the block it changes with", () => {
  const candidates = boundaryCandidates(input(), history(90));
  const single = candidates.find((candidate) => candidate.kind === "single");
  assert.deepEqual(single.proposal, { ops: [{ op: "merge", blocks: ["src-docs"], into: "src-routes" }] });
});

test("a block and a folder of its own that import each other are one proposal to merge", () => {
  const ring = {
    blocks: [block("src", ["src"], ["src/a.js", "src/b.js"]), block("src-utils", ["src/utils"], ["src/utils/u.js"])],
    fileTokens: { "src/a.js": 10, "src/b.js": 10, "src/utils/u.js": 10 },
    fileImports: [{ from: "src/a.js", to: "src/utils/u.js" }, { from: "src/utils/u.js", to: "src/b.js" }],
  };
  const found = boundaryCandidates(ring, []).filter((candidate) => candidate.kind === "ring");
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].proposal, { ops: [{ op: "merge", blocks: ["src-utils"], into: "src" }] });
});

test("a block of more than 40 files is cut by the start of the file names; lumped files go home", () => {
  const names = [...Array.from({ length: 12 }, (_, n) => `lib/validators_${n}.py`), ...Array.from({ length: 12 }, (_, n) => `lib/serializers_${n}.py`), ...Array.from({ length: 20 }, (_, n) => `lib/misc${n}.py`)];
  const big = { blocks: [block("lib", ["lib"], names)], fileTokens: Object.fromEntries(names.map((file) => [file, 5])), fileImports: [] };
  const flat = boundaryCandidates(big, []).find((candidate) => candidate.kind === "flat");
  assert.deepEqual(flat.proposal.ops.map((op) => op.to), ["lib-serializers", "lib-validators"]);

  const lumped = {
    blocks: [block("web", ["web"], ["web/page.js", "web/page2.js"]), block("web-small-1", ["web/a", "web/b"], ["web/a/x.js", "web/b/y.js"])],
    fileTokens: { "web/page.js": 1, "web/page2.js": 1, "web/a/x.js": 1, "web/b/y.js": 1 },
    fileImports: [{ from: "web/a/x.js", to: "web/page.js" }, { from: "web/page2.js", to: "web/a/x.js" }, { from: "web/b/y.js", to: "web/page.js" }, { from: "web/page.js", to: "web/b/y.js" }],
  };
  const small = boundaryCandidates(lumped, []).find((candidate) => candidate.kind === "small");
  assert.equal(small.files, 2);
  assert.deepEqual(small.proposal.ops.map((op) => op.to), ["web", "web"]);
});

test("sibling blocks with the same file names are one proposal to merge, which the measure may refuse", () => {
  const dialects = ["pg", "mysql", "sqlite", "oracle"].map((name) => block(`d-${name}`, [`d/${name}`], [`d/${name}/index.js`, `d/${name}/query.js`]));
  const all = dialects.flatMap((entry) => entry.files);
  const siblings = boundaryCandidates({ blocks: dialects, fileTokens: Object.fromEntries(all.map((file) => [file, 400])), fileImports: [] }, []).find((candidate) => candidate.kind === "siblings");
  assert.equal(siblings.proposal.ops[0].blocks.length, 3);
  assert.match(siblings.evidence[1], /measure says/);
});

test("boundary_candidates answers from the history, read-only; a project without one has nothing to say", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { copyFixture } = await import("./helpers.mjs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", copyFixture("shop"), "--no-ui", "--read-only"], stderr: "pipe" }));
  try {
    const tools = (await client.listTools()).tools;
    const tool = tools.find((entry) => entry.name === "boundary_candidates");
    assert.ok(tool, "listed even in read-only mode");
    assert.equal(tool.annotations.readOnlyHint, true);
    const answer = await client.callTool({ name: "boundary_candidates", arguments: {} });
    assert.match(answer.content[0].text, /No candidate/);
    assert.ok(!tools.some((entry) => entry.name === "split_block"), "the editing tools are not in read-only mode");
  } finally {
    await client.close();
  }
});
