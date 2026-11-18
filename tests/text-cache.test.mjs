import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { forgetSourceTexts, readSourceText } from "../dist/analysis/text-cache.js";

function temp() {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-text-"));
}

test("a file is read again when its time or size is not the one kept, and not otherwise", () => {
  forgetSourceTexts();
  const file = path.join(temp(), "a.ts");
  fs.writeFileSync(file, "export const a = 1;\n");
  const first = fs.statSync(file);
  assert.equal(readSourceText(file, first), "export const a = 1;\n");

  // Same time and size as the copy kept: the copy answers, whatever is on disk (the caller's stat is what says it is the same file).
  fs.writeFileSync(file, "export const a = 2;\n");
  assert.equal(readSourceText(file, first), "export const a = 1;\n");

  // A different modification time: read again.
  const later = new Date(first.mtimeMs + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(readSourceText(file), "export const a = 2;\n");

  // A different size: read again.
  fs.writeFileSync(file, "export const a = 22;\n");
  fs.utimesSync(file, later, later);
  assert.equal(readSourceText(file), "export const a = 22;\n");

  forgetSourceTexts();
  assert.equal(readSourceText(file), "export const a = 22;\n");
});

test("a missing file throws like a plain read", () => {
  assert.throws(() => readSourceText(path.join(temp(), "none.ts")), { code: "ENOENT" });
});
