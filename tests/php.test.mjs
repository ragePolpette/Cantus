import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze } from "../dist/index.js";
import { ProjectState } from "../dist/state/state.js";

test("PHP maps aliases, namespaced types and functions, and rechecks Composer mappings", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-php-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, source) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  };
  const order = String.raw`<?php namespace Shop\Domain; class Order {}`;
  write("domain/Order.php", order);
  write("otherx/Order.php", order);
  write("domain/functions.php", String.raw`<?php namespace Shop\Domain { function formatOrder() {} }`);
  write("app/controller.php", String.raw`<?php namespace Shop\App;
use Shop\Domain\{Order as Purchase, function formatOrder as present};
function handler(Purchase $order) { new \Shop\Domain\Order(); present(); }
`);
  const mapping = dir => JSON.stringify({ autoload: { "psr-4": { "Shop\\Domain\\": dir } } });
  write("composer.json", mapping("domain/"));
  const state = new ProjectState(root);
  const snapshot = state.get();
  const targets = result => result.callSites.filter(site => site.file === "app/controller.php").map(site => site.targetFile);
  assert.deepEqual(targets(snapshot.analysis).sort(), ["domain/Order.php", "domain/Order.php", "domain/functions.php"]);
  write("composer.json", mapping("otherx/"));
  assert.ok(targets(state.get().analysis).includes("otherx/Order.php"));
  write("composer.json", "{}");
  const ambiguous = analyze(root, { skipGit: true });
  assert.ok(ambiguous.unresolvedImports.some(item => item.reason === "ambiguous PHP symbol"));
  assert.deepEqual(targets(ambiguous), ["domain/functions.php"]);
});
