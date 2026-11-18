import path from "node:path";
import type { Analysis } from "./analyze.js";
import { TEST_FILE } from "./support.js";
import { findTestFiles, testsByBlock } from "./tests.js";

/** What the selection needs of a change: how a file differs. (`FileChange` of the project state has more; it lives above this block.) */
export type ChangedFiles = Record<string, { status: "modified" | "added" | "deleted" }>;

/** Languages whose tests Cantus can tie to the files they exercise: JavaScript and TypeScript (with Vue) and Python. */
const LINKED_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".py", ".pyi"]);
/** Files a change in which cannot change what a test does. */
const INERT = /\.(md|mdx|markdown|rst|adoc|txt|png|jpe?g|gif|svg|ico|webp)$|^(LICENSE|NOTICE|CHANGELOG|COPYING)[^/]*$/i;
const TEST_FOLDERS: ReadonlySet<string> = new Set(["tests", "test", "__tests__", "e2e"]);
/** Test folders whose every file is a test (the others hold helpers and fixtures next to the tests). */
const ALL_TESTS_FOLDER = "__tests__";

export interface TestSelection {
  /** `selected`: the tests a change can reach. `all`: Cantus cannot tell, so every test (see `reasons`). */
  mode: "selected" | "all";
  /** Test files to run, sorted. */
  tests: string[];
  /** Tests the project has in all. */
  total: number;
  /** Why the whole suite, or what the selection did not rest on. */
  reasons: string[];
  /** Source files the change reaches through imports, the changed ones included. */
  reached: number;
  /** Tests that could not be tied to any file of the project and run every time. */
  unlinked: number;
}

/** A test file by its name or its folder; `conftest.py` and the helpers next to the tests are not (they change what other tests do). */
function isTest(relative: string): boolean {
  const parts = relative.split("/");
  const name = parts[parts.length - 1];
  if (name === "conftest.py") return false;
  if (!LINKED_EXTENSIONS.has(path.extname(name).toLowerCase()) && !/\.(java|cs|go|rs)$/.test(name)) return false;
  return TEST_FILE.test(name) || parts.slice(0, -1).includes(ALL_TESTS_FOLDER);
}

function inTestFolder(relative: string): boolean {
  return relative.split("/").slice(0, -1).some((part) => TEST_FOLDERS.has(part) || /(?:^|[._-])tests?$/i.test(part));
}

/**
 * The tests a change can affect, by what can be known without running anything: the files changed, the
 * files that import them directly or through others, and the tests that import any of those. The answer
 * errs toward running more. It is the whole suite when the change is something Cantus cannot follow: a
 * deleted file, a configuration or a file no block owns, code in a language whose tests it cannot tie
 * to files, or a helper that other tests share. A test that imports nothing the project owns (it runs
 * the program, or loads code by name) cannot be tied to a change either, so it is always selected.
 */
export function selectTests(analysis: Analysis, changes: ChangedFiles | undefined, options: { tests?: string[] } = {}): TestSelection {
  const all = options.tests ?? findTestFiles(analysis.root);
  const everything = (reasons: string[]): TestSelection => ({ mode: "all", tests: all, total: all.length, reasons, reached: 0, unlinked: 0 });
  if (!changes) return everything(["The project is not a git repository: what changed is not known."]);
  const analyzed = new Set(Object.keys(analysis.fileTokens));
  const testSet = new Set(all);

  const changed = Object.entries(changes).sort(([a], [b]) => a.localeCompare(b));
  const sources: string[] = [];
  const changedTests = new Set<string>();
  const inert: string[] = [];
  for (const [file, change] of changed) {
    if (INERT.test(file) || INERT.test(path.basename(file))) {
      inert.push(file);
    } else if (isTest(file)) {
      if (change.status === "deleted") continue;
      changedTests.add(file);
    } else if (inTestFolder(file) || testSet.has(file)) {
      return everything([`\`${file}\` is in a test folder but is not a test: other tests may share it (a helper, a fixture, \`conftest.py\`).`]);
    } else if (change.status === "deleted") {
      return everything([`\`${file}\` was deleted: the files that used it are not known.`]);
    } else if (!LINKED_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      return everything([`\`${file}\` is not code whose tests Cantus can follow (${path.extname(file) || "no extension"}): a configuration, a manifest, or a language without test links.`]);
    } else if (!analyzed.has(file)) {
      return everything([`\`${file}\` is in no block, so what uses it is not known.`]);
    } else {
      sources.push(file);
    }
  }
  if (all.length === 0) return { mode: "selected", tests: [], total: 0, reasons: ["The project has no test files Cantus recognizes."], reached: 0, unlinked: 0 };

  // Who imports whom, turned around: from a changed file to everything that depends on it.
  const importedBy = new Map<string, string[]>();
  for (const edge of analysis.fileImports) importedBy.set(edge.to, [...(importedBy.get(edge.to) ?? []), edge.from]);
  const reached = new Set(sources);
  const queue = [...sources];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const user of importedBy.get(current) ?? []) {
      if (!reached.has(user)) {
        reached.add(user);
        queue.push(user);
      }
    }
  }

  // The files each test exercises: the imports of a test outside every block, read by `testsByBlock`, and the imports of one inside a block.
  const exercises = new Map<string, Set<string>>();
  const note = (test: string, file: string) => exercises.set(test, (exercises.get(test) ?? new Set()).add(file));
  for (const list of testsByBlock(analysis).values()) for (const entry of list) for (const file of entry.covers) note(entry.file, file);
  for (const edge of analysis.fileImports) if (testSet.has(edge.from)) note(edge.from, edge.to);

  const selected = new Set(changedTests);
  const unlinked: string[] = [];
  for (const test of all) {
    // Python package markers and `conftest.py` are collected by the runner, never run on their own.
    if (/(?:^|\/)(?:conftest|__init__)\.pyi?$/.test(test) && !changedTests.has(test)) continue;
    const files = exercises.get(test);
    if (!files || files.size === 0) {
      unlinked.push(test);
      selected.add(test);
    } else if ([...files].some((file) => reached.has(file)) || reached.has(test)) selected.add(test);
  }
  const reasons: string[] = [];
  if (unlinked.length > 0) reasons.push(`${unlinked.length} test(s) import nothing of the project that Cantus can follow, so they always run: ${unlinked.slice(0, 5).map((test) => `\`${test}\``).join(", ")}${unlinked.length > 5 ? ", …" : ""}.`);
  if (inert.length > 0) reasons.push(`${inert.length} changed file(s) cannot change a test and were not counted: ${inert.slice(0, 5).map((file) => `\`${file}\``).join(", ")}${inert.length > 5 ? ", …" : ""}.`);
  if (sources.length === 0 && changedTests.size === 0 && Object.keys(changes).length === 0) reasons.push("Nothing changed.");
  return { mode: "selected", tests: [...selected].sort(), total: all.length, reasons, reached: reached.size, unlinked: unlinked.length };
}

/** The selection as the terminal shows it: one line per test on stdout is the caller's; this is the explanation. */
export function describeSelection(selection: TestSelection): string[] {
  const lines = [
    selection.mode === "all"
      ? `Cantus cannot narrow the tests down: all ${selection.total} run.`
      : `${selection.tests.length} of ${selection.total} test file(s) can be affected${selection.reached ? `, through ${selection.reached} source file(s) the change reaches` : ""}.`,
    ...selection.reasons.map((reason) => `  · ${reason}`),
  ];
  if (selection.mode === "selected") lines.push("  · This follows imports only: a test that reaches code through a plugin, a path built at run time or another program is not tied to it.");
  return lines;
}
