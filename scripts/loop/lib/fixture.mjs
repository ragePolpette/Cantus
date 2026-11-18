// The loop's own test project ("toy"): four small blocks in plain ES modules, tests next to the
// code (so a task on one block can add its test without leaving the scope), no dependencies.
import fs from "node:fs";
import path from "node:path";
import { parseJsonBlock } from "./claude.mjs";
import { git, gitOk, readJson, sh, writeFiles } from "./util.mjs";

export const TOY_FILES = {
  "package.json": JSON.stringify({ name: "shop-lite", version: "1.0.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  ".gitignore": "node_modules/\n",
  "src/pricing/index.js": [
    "/** Total of the items, in cents. */",
    "export function computeTotal(items) {",
    "  return items.reduce((sum, item) => sum + item.price * item.qty, 0);",
    "}",
    "",
    "/** The total after a percentage discount, rounded to the cent. */",
    "export function applyDiscount(total, percent) {",
    "  return Math.round(total * (1 - percent / 100));",
    "}",
    "",
  ].join("\n"),
  "src/pricing/pricing.test.js": [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { applyDiscount, computeTotal } from "./index.js";',
    "",
    'test("total and discount", () => {',
    "  assert.equal(computeTotal([{ price: 250, qty: 2 }, { price: 100, qty: 1 }]), 600);",
    "  assert.equal(applyDiscount(600, 10), 540);",
    "});",
    "",
  ].join("\n"),
  "src/billing/index.js": [
    'import { computeTotal } from "../pricing/index.js";',
    "",
    "let next = 1;",
    "",
    "/** An invoice for a customer's items. */",
    "export function createInvoice(customer, items) {",
    "  return { number: next++, customer, total: computeTotal(items) };",
    "}",
    "",
  ].join("\n"),
  "src/billing/billing.test.js": [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { createInvoice } from "./index.js";',
    "",
    'test("an invoice carries the total", () => {',
    '  assert.equal(createInvoice("ada", [{ price: 300, qty: 1 }]).total, 300);',
    "});",
    "",
  ].join("\n"),
  "src/users/index.js": [
    'const users = new Map([["u1", { id: "u1", first: "Ada", last: "Lovelace" }]]);',
    "",
    "export function findUser(id) {",
    "  return users.get(id);",
    "}",
    "",
    "export function displayName(user) {",
    "  return `${user.first} ${user.last}`;",
    "}",
    "",
  ].join("\n"),
  "src/users/users.test.js": [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { displayName, findUser } from "./index.js";',
    "",
    'test("names", () => {',
    '  assert.equal(displayName(findUser("u1")), "Ada Lovelace");',
    "});",
    "",
  ].join("\n"),
  "src/api/index.js": [
    'import { createInvoice } from "../billing/index.js";',
    'import { displayName, findUser } from "../users/index.js";',
    "",
    "/** Checks out a user's cart: the invoice, addressed by name. */",
    "export function checkout(userId, items) {",
    "  const user = findUser(userId);",
    '  if (!user) throw new Error("No such user");',
    "  return createInvoice(displayName(user), items);",
    "}",
    "",
  ].join("\n"),
  "src/api/api.test.js": [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { checkout } from "./index.js";',
    "",
    'test("checkout", () => {',
    '  const invoice = checkout("u1", [{ price: 100, qty: 3 }]);',
    '  assert.equal(invoice.customer, "Ada Lovelace");',
    "  assert.equal(invoice.total, 300);",
    "});",
    "",
  ].join("\n"),
};

/** Tasks the loop gives on the toy project. Each names an out-of-scope step on purpose (README of users). */
export const TOY_TASKS = {
  block: "src-pricing",
  blockPrompt: "Add an exported function formatTotal(cents, currency) to src/pricing/index.js that returns a string such as \"EUR 12.50\", with a test in src/pricing/pricing.test.js. Also add one line to src/users/README.md saying that pricing now has formatTotal.",
  allPrompt: "Customers get a 10% loyalty discount on invoices: add a `loyal` flag to the users (Ada is loyal), apply the discount in billing through pricing's applyDiscount when the customer is loyal, and make checkout in the api pass the user so billing can tell. Update the tests of each block.",
  verify: "npm test",
  plugin: {
    file: "src/pricing/index.js",
    block: "src-pricing",
    change: "change the exported function computeTotal in src/pricing/index.js so that it takes (items, currency) and returns an object { amount, currency } instead of a number.",
  },
};

/** Planned blocks for "Build the plan": catalog (no code) and cart (no code, uses catalog and pricing); api should use cart. */
export function sketchToyModel(model) {
  const next = structuredClone(model);
  const layerOf = (id) => next.blocks.find((block) => block.id === id)?.layer;
  next.blocks.push(
    { id: "src-catalog", name: "Catalog", layer: layerOf("src-pricing") ?? "domain", include: ["src/catalog"], description: "The products on sale: id, name and price in cents; lookup by id." },
    { id: "src-cart", name: "Cart", layer: layerOf("src-billing") ?? "application", include: ["src/cart"], description: "A shopping cart: add and remove products by id and quantity, and its total through pricing." },
  );
  next.dependencies = [...(next.dependencies ?? []), { from: "src-cart", to: "src-catalog" }, { from: "src-cart", to: "src-pricing" }, { from: "src-api", to: "src-cart" }];
  return next;
}

/** Writes the toy project in dir as a git repository with one commit. */
export function createToy(dir, { rootClaudeMd = false, extraFiles = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  writeFiles(dir, { ...TOY_FILES, ...(rootClaudeMd ? { "CLAUDE.md": "# shop-lite\n\nA tiny shop used to test Cantus.\n" } : {}), ...extraFiles });
  initRepo(dir);
  return dir;
}

export function initRepo(dir) {
  if (!fs.existsSync(path.join(dir, ".git"))) gitOk(dir, "init", "-q", "-b", "main");
  gitOk(dir, "config", "user.email", "loop@cantus.local");
  gitOk(dir, "config", "user.name", "Cantus loop");
  gitOk(dir, "config", "core.fileMode", "false");
  gitOk(dir, "add", "-A");
  if (git(dir, "diff", "--cached", "--quiet").code !== 0) gitOk(dir, "commit", "-q", "-m", "shop-lite");
}

/**
 * Maps a project with Cantus (map, specialists, notes) unless it has a map already, sets the verify
 * command, and commits the result so worktrees of the tasks start from it. What git ignores (the map,
 * in the user's repository) is not committed: Cantus copies it into the worktrees of its tasks.
 */
export function mapProject(ctx, dir, { verify, force = false, modelPatch, refine } = {}) {
  const steps = [];
  const cantus = (...args) => {
    const result = sh(process.execPath, [ctx.cantusCli, ...args, "-C", dir], { env: ctx.env, timeoutMs: 15 * 60_000 });
    steps.push({ command: `cantus ${args.join(" ")}`, code: result.code, output: (result.stdout + result.stderr).slice(-4000) });
    return result;
  };
  // Caches, logs and task records stay out of git through the loop's core.excludesFile (see
  // CANTUS_EXCLUDES in loop.mjs), without touching the project's .gitignore or .git.
  const modelFile = path.join(dir, ".cantus", "model.json");
  if (force || !fs.existsSync(modelFile)) cantus("analyze", "--write");
  let model = readJson(modelFile);
  if (model) {
    if (verify) model.agent = { ...(model.agent ?? {}), verifyCommand: verify };
    if (modelPatch) model = modelPatch(model);
    fs.writeFileSync(modelFile, JSON.stringify(model, null, 2) + "\n");
  }
  // The map after `cantus refine`: made once per target and run (it costs a session), then every
  // scenario starts from the same refined map.
  let refined;
  if (refine && model) {
    if (refine.cached) fs.writeFileSync(modelFile, JSON.stringify(refine.cached, null, 2) + "\n");
    else {
      const run = cantus("refine", "--json", ...(refine.model ?? ctx.model ? ["--model", refine.model ?? ctx.model] : []), ...(refine.budget ? ["--budget", String(refine.budget)] : []), ...(ctx.runner ? ["--runner", ctx.runner] : []));
      if (run.code !== 0) throw new Error(`cantus refine failed (exit ${run.code}): ${(run.stderr || run.stdout).slice(-800)}`);
      // The cost is only known when `cantus refine --json` reports it as costUsd.
      const report = parseJsonBlock(run.stdout) ?? {};
      const costUsd = Number(report.costUsd ?? 0);
      ctx.spend?.(costUsd);
      refined = { model: readJson(modelFile), costUsd, report };
    }
  }
  cantus("agents");
  cantus("notes");
  git(dir, "add", "-A");
  if (git(dir, "diff", "--cached", "--quiet").code !== 0) git(dir, "-c", "user.email=loop@cantus.local", "-c", "user.name=Cantus loop", "commit", "-q", "-m", "Cantus map, specialists and notes");
  return { model: readJson(modelFile), steps, refined };
}
