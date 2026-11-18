import fs from "node:fs";
import path from "node:path";
import { type Block, blockForFile } from "../model/index.js";
import type { Analysis } from "./analyze.js";
import { collectImports } from "./imports.js";
import { GENERATED_DIRS, TEST_FILE } from "./support.js";
import { createResolver } from "./resolve.js";

/** A test file and why it is listed for a block. */
export interface BlockTest {
  file: string;
  /** `inside`: in the block's own folder. `imports`: it imports the block's files. `name`: FooTest for Foo. */
  how: "inside" | "imports" | "name";
  /** The block's files the test imports or is named after (nothing for `inside`). */
  covers: string[];
}

const TEST_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".py", ".go", ".rs", ".java", ".cs"]);
const JS_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue"]);
/** Folders whose files are tests, as opposed to the mocks and fixtures TEST_DIRS also names. */
const TEST_ONLY_DIRS: ReadonlySet<string> = new Set(["tests", "test", "__tests__", "e2e"]);
const FILE_LIMIT = 4_000;
const READ_LIMIT = 300_000;

export function isTestFile(relative: string): boolean {
  const parts = relative.split("/");
  const name = parts[parts.length - 1];
  if (!TEST_EXTENSIONS.has(path.extname(name).toLowerCase())) return false;
  return TEST_FILE.test(name) || parts.slice(0, -1).some((part) => TEST_ONLY_DIRS.has(part));
}

/** Like isTestFile, and a file of any kind in a test project's folder (`Shop.Tests/Helpers/Fake.cs`). */
export function isTestPath(relative: string): boolean {
  return isTestFile(relative) || relative.split("/").slice(0, -1).some((part) => /(?:^|[._-])(?:tests?|specs?|integrationtests?|unittests?)$/i.test(part));
}

/** The project's test files: in a test folder or named like a test, outside generated and hidden folders. */
export function findTestFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= FILE_LIMIT) return;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !GENERATED_DIRS.has(entry.name)) walk(child);
      } else if (entry.isFile() && isTestFile(child)) found.push(child);
    }
  };
  walk("");
  return found.sort();
}

/** Dotted names a Python file can be imported by: its path, with or without a leading `src/`; packages by their folder. */
function pythonNames(file: string): string[] {
  const parts = file.replace(/\.pyi?$/, "").split("/");
  if (parts[parts.length - 1] === "__init__") parts.pop();
  const names = [parts.join(".")];
  if (parts[0] === "src" || parts[0] === "lib") names.push(parts.slice(1).join("."));
  return names.filter(Boolean);
}

/** Python modules a test imports, as written: `[dots, dotted name]`. */
function pythonImports(source: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const add = (dots: string, name: string) => out.push([dots.length, name]);
  for (const match of source.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+([^\n#]+)/gm)) {
    add(match[1], match[2]);
    // `from pkg import mod`: the name may be a submodule.
    const names = match[3].replace(/[()\\]/g, " ").split(",").map((part) => part.trim().split(/\s+as\s+/)[0].trim()).filter((part) => /^\w+$/.test(part));
    for (const name of names) add(match[1], match[2] ? `${match[2]}.${name}` : name);
  }
  for (const match of source.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm)) {
    for (const name of match[1].split(",")) add("", name.trim());
  }
  return out;
}

const cache = new WeakMap<Analysis, Map<string, BlockTest[]>>();

/**
 * The test files that go with each block, by what can be known without running anything: tests in the
 * block's own folder, tests that import the block's files (JavaScript, TypeScript, Python), and Java
 * or C# tests named after a class of the block (FooTest, FooTests, FooIT for Foo). A test that reaches
 * the block only through another module is not found, so the list can be incomplete; it does not
 * list a test it cannot tie to the block.
 */
export function testsByBlock(analysis: Analysis): Map<string, BlockTest[]> {
  const known = cache.get(analysis);
  if (known) return known;
  const result = new Map<string, BlockTest[]>();
  cache.set(analysis, result);
  let testFiles: string[];
  try {
    testFiles = findTestFiles(analysis.root);
  } catch {
    return result;
  }
  if (testFiles.length === 0) return result;

  const blocks: Block[] = analysis.blocks.map((info) => info.block);
  const owner = new Map<string, string>();
  for (const info of analysis.blocks) for (const file of info.files) owner.set(file, info.block.id);
  const analyzed = new Set(owner.keys());
  const links = new Map<string, Map<string, BlockTest>>();
  const link = (blockId: string, test: BlockTest) => {
    const perBlock = links.get(blockId) ?? new Map<string, BlockTest>();
    links.set(blockId, perBlock);
    const existing = perBlock.get(test.file);
    if (!existing) perBlock.set(test.file, test);
    else {
      if (test.how === "inside") existing.how = "inside";
      existing.covers = [...new Set([...existing.covers, ...test.covers])].sort();
    }
  };

  // Source files by class name, for the naming rule: only a name that is unique tells which one it is.
  const byClass = new Map<string, string[]>();
  for (const file of analyzed) {
    if (!/\.(java|cs)$/.test(file)) continue;
    const name = path.basename(file).replace(/\.(java|cs)$/, "");
    byClass.set(name, [...(byClass.get(name) ?? []), file]);
  }
  const pythonIndex = new Map<string, string[]>();
  for (const file of analyzed) {
    if (!/\.pyi?$/.test(file)) continue;
    for (const name of pythonNames(file)) pythonIndex.set(name, [...(pythonIndex.get(name) ?? []), file]);
  }
  const fileSet = new Set(analyzed);
  const resolver = createResolver(analysis.root, fileSet, []);

  for (const testFile of testFiles) {
    if (analyzed.has(testFile)) continue;
    const here = blockForFile(blocks, testFile);
    // A block that is the whole project (`.`) says nothing about a test: only its imports can.
    const folder = here?.include.some((prefix) => {
      const base = prefix.replace(/\/+$/, "");
      return base !== "" && base !== "." && (testFile === base || testFile.startsWith(base + "/"));
    });
    if (here && folder) link(here.id, { file: testFile, how: "inside", covers: [] });

    const extension = path.extname(testFile).toLowerCase();
    const covers = new Map<string, Set<string>>();
    const cover = (file: string | undefined) => {
      const block = file ? owner.get(file) : undefined;
      if (!file || !block) return;
      covers.set(block, (covers.get(block) ?? new Set()).add(file));
    };
    let source = "";
    try {
      const stat = fs.statSync(path.join(analysis.root, testFile));
      if (stat.size <= READ_LIMIT) source = fs.readFileSync(path.join(analysis.root, testFile), "utf8");
    } catch {
      continue;
    }
    if (JS_EXTENSIONS.has(extension) && source) {
      let refs: ReturnType<typeof collectImports> = [];
      try {
        refs = collectImports(testFile, source);
      } catch {
        // unreadable test: it keeps only what its folder says
      }
      for (const ref of refs) {
        try {
          const resolution = resolver(ref.specifier, testFile);
          if (resolution.kind === "internal") cover(resolution.file);
        } catch {
          // an import the resolver cannot follow
        }
      }
    } else if (extension === ".py" && source) {
      const folder = path.posix.dirname(testFile);
      for (const [dots, name] of pythonImports(source)) {
        if (dots > 0) {
          const base = path.posix.normalize(`${folder}${"/..".repeat(dots - 1)}`);
          const stem = path.posix.join(base, name.replace(/\./g, "/"));
          cover([`${stem}.py`, `${stem}/__init__.py`].find((candidate) => analyzed.has(candidate)));
        } else {
          const files = pythonIndex.get(name);
          if (files?.length === 1) cover(files[0]);
        }
      }
    } else if (extension === ".java" || extension === ".cs") {
      const stem = path.basename(testFile).replace(/\.(java|cs)$/, "");
      const target = /^(.+?)(?:Tests?|IT)$/.exec(stem)?.[1];
      const candidates = (target ? byClass.get(target) : undefined)?.filter((file) => file.endsWith(extension));
      if (candidates?.length === 1) {
        const block = owner.get(candidates[0]);
        if (block) link(block, { file: testFile, how: "name", covers: [candidates[0]] });
      }
    }
    for (const [block, files] of covers) {
      // `from pkg import mod` also names the package: the module is the more precise answer.
      const precise = [...files].filter((file) => !(path.posix.basename(file) === "__init__.py" && [...files].some((other) => other !== file && other.startsWith(path.posix.dirname(file) + "/"))));
      link(block, { file: testFile, how: "imports", covers: precise.sort() });
    }
  }

  for (const [blockId, perBlock] of links) result.set(blockId, [...perBlock.values()].sort((a, b) => a.file.localeCompare(b.file)));
  return result;
}

/** The tests of a scope (one block or several): each test once, with the files of the scope it covers. */
export function testsFor(analysis: Analysis, blockIds: Iterable<string>): BlockTest[] {
  const all = testsByBlock(analysis);
  const merged = new Map<string, BlockTest>();
  for (const id of blockIds) {
    for (const test of all.get(id) ?? []) {
      const existing = merged.get(test.file);
      if (!existing) merged.set(test.file, { ...test, covers: [...test.covers] });
      else {
        if (test.how === "inside") existing.how = "inside";
        existing.covers = [...new Set([...existing.covers, ...test.covers])].sort();
      }
    }
  }
  return [...merged.values()].sort((a, b) => a.file.localeCompare(b.file));
}
