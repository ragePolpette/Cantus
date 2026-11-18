#!/usr/bin/env node
// Scores where a project's blocks put their borders against its own git history, at no token cost: how many of the files
// that change in the same commit sit in one block, and how much an agent reads to work on it.
// Usage: node scripts/boundaries/score.mjs <project-dir> [--proposal proposal.json] [--json] [--commits <n>]
//   no proposal   scores the blocks as they are (`.cantus/cantus.json` if there is one, else the folders), on the last 1000 commits.
//   --proposal    {"ops":[{"op":"move","files":[…],"to":"block"},{"op":"merge","blocks":[…],"into":"block"}]}: the proposal is applied
//                 to a copy and judged on the newest 30% of the commits (it should be built on the oldest 70%, see --split).
//   --candidates  the changes the commits and imports point at (feature, ring, single, small, siblings, flat), each judged on the newest 30%;
//                 only the ones that pass, or all with --all. Nothing is changed.
//   --walk-forward  for young projects: the same test repeated down the history (proposals built on the slices before a cut, judged on the next), one kind of proposal at a time.
//   --split       prints which commits are the oldest 70% (to build a proposal on) and which the newest 30% (to judge it).
// Writes nothing to the project except what Cantus keeps in `.cantus/cache` (not with --no-cache).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const root = path.resolve(args.find((arg, at) => !arg.startsWith("--") && !["--proposal", "--commits"].includes(args[at - 1])) ?? ".");
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
const { analyze, readCommits, partitionOf, applyProposal, scoreBoundaries, compareBoundaries, splitCommits, evaluateCandidates, renderCandidates, walkForward } = await import(pathToFileURL(path.join(dist, "index.js")).href);

const analysis = analyze(root, { cache: !flag("--no-cache") });
const commits = readCommits(root, Number(option("--commits") ?? 1000));
const partition = partitionOf(analysis);
const input = { fileTokens: analysis.fileTokens, fileImports: analysis.fileImports };
const { train, test } = splitCommits(commits);
const result = { project: analysis.name, files: partition.size, commitsRead: commits.length, current: scoreBoundaries(partition, commits, input) };

if (flag("--split")) result.split = { train: train.map((commit) => commit.hash), test: test.map((commit) => commit.hash) };
const proposalFile = option("--proposal");
if (proposalFile) {
  const after = applyProposal(partition, JSON.parse(fs.readFileSync(proposalFile, "utf8")));
  const before = scoreBoundaries(partition, test, input);
  const proposed = scoreBoundaries(after, test, input);
  result.judged = { before, after: proposed, comparison: compareBoundaries(before, proposed) };
}

if (flag("--walk-forward")) {
  result.walkForward = walkForward(analysis, commits);
  if (!flag("--json")) {
    console.log(`${result.project}: ${result.files} files in blocks, ${result.commitsRead} commits read, ${result.current.commits} count`);
    for (const entry of result.walkForward) {
      const c = entry.comparison;
      console.log(`${entry.kind.padEnd(9)} proposals ${String(entry.proposals).padStart(3)} | judged ${String(entry.commits).padStart(3)} | coverage ${(entry.before.coverage * 100).toFixed(0)}% → ${(entry.after.coverage * 100).toFixed(0)}% | context ${Math.round(entry.before.contextMedianTokens)} → ${Math.round(entry.after.contextMedianTokens)} | ${c.verdict}: ${c.reason}`);
    }
    process.exit(0);
  }
}

if (flag("--candidates")) {
  result.candidates = evaluateCandidates(analysis, commits);
  if (!flag("--json")) {
    console.log(`${result.project}: ${result.files} files in blocks, ${result.commitsRead} commits read`);
    console.log(renderCandidates(result.candidates, { all: flag("--all") }));
    process.exit(0);
  }
}

if (flag("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const line = (label, score) =>
    `${label.padEnd(10)} commits ${String(score.commits).padStart(3)} | coverage ${(score.coverage * 100).toFixed(0).padStart(3)}% | in one block ${(score.inOneBlock * 100).toFixed(0).padStart(3)}% | context ${Math.round(score.contextMedianTokens)} tokens (mean ${score.contextMeanFiles.toFixed(1)} files) | blocks ${score.blocks}, of 1 file ${score.singleFileBlocks}, of >40 files ${score.bigBlocks}, cycles ${score.cycles}`;
  console.log(`${result.project}: ${result.files} files in blocks, ${result.commitsRead} commits read`);
  console.log(line("current", result.current));
  if (result.judged) {
    console.log("judged on the newest 30% of the commits:");
    console.log(line("before", result.judged.before));
    console.log(line("after", result.judged.after));
    console.log(`verdict: ${result.judged.comparison.verdict} (${result.judged.comparison.reason})`);
  }
}
