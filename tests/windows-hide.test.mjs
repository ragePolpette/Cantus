import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : file.endsWith(".ts") ? [file] : [];
  });
}

// On Windows a child process of a process with no console opens a console window of its own, for every git call and background run.
test("every process the code starts is told to stay hidden on Windows", () => {
  const missing = [];
  for (const file of sources(src)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?<![.\w])(?:spawn|spawnSync|execFile|execFileSync|execSync)\(/g)) {
      if (/^\s*import/m.test(text.slice(Math.max(0, match.index - 40), match.index))) continue;
      // The one program that opens a window for the person to work in, the terminal of their own choice, says so where it starts it.
      if (/shows its window on purpose/.test(text.slice(Math.max(0, match.index - 200), match.index))) continue;
      // the call's argument list: up to the matching close of its options, which always sit within a few hundred characters
      const call = text.slice(match.index, match.index + 600);
      if (!/windowsHide:\s*true/.test(call)) missing.push(`${path.relative(src, file)}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
  assert.deepEqual(missing, []);
});
