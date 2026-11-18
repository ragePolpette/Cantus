import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, buildContextPack, buildViewData, check, handleHook, renderContextPrompt, writeProjectIndex } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

/** The shop in git, with a history: web and payments change together, pricing mostly alone, one sweep. */
function shopWithHistory() {
  const root = copyFixture("shop");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const commit = (message, ...files) => {
    for (const file of files) fs.appendFileSync(path.join(root, file), `// ${message}\n`);
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
  };
  git("init", "-q", "-b", "main");
  commit("init");
  for (let i = 1; i <= 4; i++) commit(`pay flow ${i}`, "src/web/checkout-page.ts", "src/payments/stripe.ts");
  commit("web alone", "src/web/checkout-page.ts");
  for (let i = 1; i <= 2; i++) commit(`pricing and orders ${i}`, "src/pricing/index.ts", "src/orders/index.ts");
  for (let i = 1; i <= 3; i++) commit(`pricing alone ${i}`, "src/pricing/index.ts");
  // A sweep touching every file says nothing about coupling.
  for (let i = 1; i <= 3; i++) {
    for (let n = 0; n < 21; n++) fs.writeFileSync(path.join(root, `src/db/generated-${n}.ts`), `export const v${n} = ${i};\n`);
    commit(`sweep ${i}`, "src/web/checkout-page.ts", "src/payments/stripe.ts", "src/pricing/index.ts", "src/orders/index.ts");
  }
  return root;
}

test("files that keep changing in the same commits are found, sweeps aside", () => {
  const root = shopWithHistory();
  const analysis = analyze(root, { model: shopModel() });
  assert.deepEqual(analysis.coChanges, [{ files: ["src/payments/stripe.ts", "src/web/checkout-page.ts"], commits: 4, share: 1 }], "pricing+orders: only 2 commits; sweeps skipped");
  assert.equal(analysis.blocks.find((info) => info.block.id === "src-web").churn > 0, true, "hotspots still counted");

  const text = renderContextPrompt(buildContextPack(analysis, "src-payments", shopModel(), check(analysis, shopModel())), { root, inlineSources: false });
  assert.match(text, /## Usually changed together[\s\S]*- `src\/payments\/stripe\.ts` with `src\/web\/checkout-page\.ts` \(src-web\): 4 commits, 100% of the time/);
  const inside = renderContextPrompt(buildContextPack(analysis, "src-pricing", shopModel(), []), { root, inlineSources: false });
  assert.doesNotMatch(inside, /Usually changed together/);

  const view = buildViewData(analysis, shopModel(), []);
  assert.deepEqual(view.blocks.find((block) => block.id === "src-web").changesWith, [{ file: "src/web/checkout-page.ts", other: "src/payments/stripe.ts", otherBlock: "src-payments", commits: 4, share: 1 }]);

  writeProjectIndex(root, analysis, shopModel());
  const hint = handleHook("pre-edit", { tool_input: { file_path: path.join(root, "src/web/checkout-page.ts") }, cwd: root }, root);
  assert.match(hint.hookSpecificOutput.additionalContext, /src\/web\/checkout-page\.ts usually changes together with src\/payments\/stripe\.ts \(4 commits\)/);

  // In a session the same note is shown once for the file, then again only if it changes.
  const edit = (file, session, extra = {}) => handleHook("pre-edit", { tool_input: { file_path: path.join(root, file) }, cwd: root, session_id: session, ...extra }, root);
  assert.match(edit("src/web/checkout-page.ts", "s1").hookSpecificOutput.additionalContext, /usually changes together/);
  assert.equal(edit("src/web/checkout-page.ts", "s1"), undefined, "second edit, same note");
  assert.equal(edit("src/web/checkout-page.ts", "s1"), undefined, "third edit, same note");
  assert.ok(edit("src/web/checkout-page.ts", "s1", { agent_id: "sub-1" }), "another agent has not seen it");
  assert.ok(edit("src/payments/stripe.ts", "s1"), "another file");
  assert.ok(edit("src/web/checkout-page.ts", "s2"), "a new session starts again");
});

test("without git there is no co-change", () => {
  const analysis = analyze(copyFixture("shop"), { model: shopModel(), skipGit: true });
  assert.deepEqual(analysis.coChanges, []);
});
