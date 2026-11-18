import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, applyProposal, compareBoundaries, partitionOf, readCommits, scoreBoundaries, splitCommits } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const tokens = { "a/1.ts": 100, "a/2.ts": 100, "b/1.ts": 300, "b/2.ts": 300, "c/1.ts": 50 };
const partition = () => new Map([["a/1.ts", "a"], ["a/2.ts", "a"], ["b/1.ts", "b"], ["b/2.ts", "b"], ["c/1.ts", "c"]]);
const input = { fileTokens: tokens, fileImports: [] };
const commit = (hash, ...files) => ({ hash, files });

test("coverage is the share of a commit's files in its main block; lone files and sweeps do not count", () => {
  const commits = [
    commit("1", "a/1.ts", "a/2.ts"), // one block: 100%
    commit("2", "a/1.ts", "a/2.ts", "b/1.ts"), // 2 of 3
    commit("3", "a/1.ts"), // a lone file: skipped
    commit("4", "docs/readme.md", "a/1.ts"), // one analyzed file: skipped
    commit("5", ...Array.from({ length: 21 }, (_, n) => `x/${n}.ts`), "a/1.ts"), // not analyzed: skipped
  ];
  const score = scoreBoundaries(partition(), commits, input);
  assert.equal(score.commits, 2);
  assert.equal(score.inOneBlock, 0.5);
  assert.ok(Math.abs(score.coverage - (1 + 2 / 3) / 2) < 1e-9);
  assert.equal(score.contextMedianTokens, 200, "both commits have block a as the main one: 200 tokens");
  assert.equal(score.contextMeanFiles, 2);
  assert.equal(score.blocks, 3);
  assert.equal(score.singleFileBlocks, 1);
});

test("a tie takes the block with the smaller id, so the score does not depend on file order", () => {
  const forward = scoreBoundaries(partition(), [commit("1", "b/1.ts", "a/1.ts")], input);
  const backward = scoreBoundaries(partition(), [commit("1", "a/1.ts", "b/1.ts")], input);
  assert.equal(forward.contextMedianTokens, 200);
  assert.deepEqual(forward, backward);
});

test("merging everything gives 100% coverage and a much bigger context: the two are read together", () => {
  const commits = [commit("1", "a/1.ts", "b/1.ts"), commit("2", "a/2.ts", "c/1.ts"), commit("3", "b/1.ts", "b/2.ts")];
  const before = scoreBoundaries(partition(), commits, input);
  const all = applyProposal(partition(), { ops: [{ op: "merge", blocks: ["a", "b", "c"], into: "all" }] });
  const after = scoreBoundaries(all, commits, input);
  assert.equal(after.coverage, 1);
  assert.ok(after.contextMedianTokens > before.contextMedianTokens * 2);
});

test("a proposal is applied to a copy: move creates a block, merge joins blocks, unknown files are ignored", () => {
  const base = partition();
  const next = applyProposal(base, { ops: [{ op: "move", files: ["b/1.ts", "nope.ts"], to: "new" }, { op: "merge", blocks: ["c", "a"], into: "a" }] });
  assert.equal(next.get("b/1.ts"), "new");
  assert.equal(next.get("c/1.ts"), "a");
  assert.equal(next.has("nope.ts"), false);
  assert.equal(base.get("b/1.ts"), "b", "the original is untouched");
});

test("cycles between blocks are counted from the file imports, in the partition given", () => {
  const imports = [{ from: "a/1.ts", to: "b/1.ts" }, { from: "b/2.ts", to: "a/2.ts" }];
  assert.equal(scoreBoundaries(partition(), [], { fileTokens: tokens, fileImports: imports }).cycles, 1);
  const split = applyProposal(partition(), { ops: [{ op: "move", files: ["b/2.ts"], to: "b2" }] });
  assert.equal(scoreBoundaries(split, [], { fileTokens: tokens, fileImports: imports }).cycles, 0, "a→b and b2→a is no ring: the split breaks it");
});

function score(commits, coverage, tokensMedian) {
  return { commits, coverage, inOneBlock: 0, contextMedianTokens: tokensMedian, contextMeanFiles: 0, blocks: 1, singleFileBlocks: 0, bigBlocks: 0, cycles: 0 };
}

test("a proposal passes with +5 points of coverage and at most +25% context; fewer than 30 commits decide nothing", () => {
  assert.equal(compareBoundaries(score(40, 0.5, 1000), score(40, 0.56, 1200)).verdict, "passes");
  assert.equal(compareBoundaries(score(40, 0.5, 1000), score(40, 0.54, 1000)).verdict, "fails", "only 4 points");
  assert.equal(compareBoundaries(score(40, 0.5, 1000), score(40, 0.9, 1300)).verdict, "fails", "context +30%");
  assert.equal(compareBoundaries(score(29, 0.5, 1000), score(29, 0.9, 1000)).verdict, "undecided");
  assert.equal(compareBoundaries(score(40, 0.5, 1000), score(40, 0.55, 1250)).verdict, "passes", "exactly +5 points and +25%");
});

test("the commits are cut in the oldest 70% to build a proposal and the newest 30% to judge it", () => {
  const commits = Array.from({ length: 10 }, (_, n) => commit(String(n)));
  const { train, test: judged } = splitCommits(commits);
  assert.deepEqual(judged.map((entry) => entry.hash), ["0", "1", "2"]);
  assert.equal(train.length, 7);
});

test("the history of a project is read from git: newest first, merges out, paths relative to the folder asked", () => {
  const root = copyFixture("shop");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  const save = (message, ...files) => {
    for (const file of files) fs.appendFileSync(path.join(root, file), `// ${message}\n`);
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
  };
  git("init", "-q", "-b", "main");
  save("init");
  save("one", "src/web/checkout-page.ts", "src/payments/stripe.ts");
  save("two", "src/pricing/index.ts");
  const commits = readCommits(root);
  assert.equal(commits.length, 2, "the first commit adds everything at once: out");
  assert.deepEqual(commits[0].files, ["src/pricing/index.ts"]);
  assert.deepEqual(commits[1].files.sort(), ["src/payments/stripe.ts", "src/web/checkout-page.ts"]);
  const inside = readCommits(path.join(root, "src"));
  assert.deepEqual(inside[0].files, ["pricing/index.ts"], "relative to the folder");
  assert.deepEqual(readCommits(fs.mkdtempSync(path.join(fs.realpathSync.native(root), "..", "nogit-"))), [], "not a repository: nothing");
  const analysis = analyze(root, { model: shopModel(), cache: false });
  const scored = scoreBoundaries(partitionOf(analysis), commits, analysis);
  assert.equal(scored.commits, 1, "only the commit with two analyzed files counts");
});
