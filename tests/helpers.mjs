import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Use Playwright's browser by default, or an explicitly supplied headless binary in restricted test environments. */
export function launchTestBrowser(chromium) {
  const executablePath = process.env.CANTUS_TEST_BROWSER_PATH;
  const args = process.env.CANTUS_TEST_BROWSER_ARGS ? JSON.parse(process.env.CANTUS_TEST_BROWSER_ARGS) : undefined;
  if (args !== undefined && (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))) throw new Error("CANTUS_TEST_BROWSER_ARGS must be a JSON array of strings");
  return chromium.launch({ ...(executablePath ? { executablePath } : {}), ...(args ? { args } : {}) });
}

/** Copies a fixture to a temp dir so tests can write to it. */
export function copyFixture(name) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), `cantus-${name}-`));
  // Tests that analyze a fixture in place leave caches and logs there: a copy starts without them.
  const generated = /[\\/]\.cantus[\\/](cache|runs)([\\/]|$)|[\\/]\.cantus[\\/]([^\\/]*\.(log|html)|\.gitignore)$/;
  const keep = (source) => {
    if (generated.test(source)) return false;
    // An .cantus folder holding only generated files is not part of the fixture.
    if (/[\\/]\.cantus$/.test(source)) return fs.readdirSync(source).some((entry) => keep(path.join(source, entry)));
    return true;
  };
  fs.cpSync(path.join(fixtures, name), dir, { recursive: true, filter: keep });
  return dir;
}

/** The shop fixture's intended architecture: the web page must not reach the database. */
export function shopModel() {
  return {
    version: 1,
    name: "shop",
    blocks: [
      { id: "src-web", name: "Web", layer: "interface", include: ["src/web"] },
      { id: "src-checkout", name: "Checkout", layer: "application", include: ["src/checkout"] },
      { id: "src-orders", name: "Orders", layer: "domain", include: ["src/orders"] },
      { id: "src-pricing", name: "Pricing", layer: "domain", include: ["src/pricing"] },
      { id: "src-payments", name: "Payments", layer: "infrastructure", include: ["src/payments"] },
      { id: "src-db", name: "Database", layer: "infrastructure", include: ["src/db"] },
    ],
    dependencies: [
      { from: "src-web", to: "src-checkout" },
      { from: "src-checkout", to: "src-orders" },
      { from: "src-checkout", to: "src-pricing" },
      { from: "src-checkout", to: "src-payments" },
      { from: "src-orders", to: "src-db" },
    ],
    rules: {
      allow: {
        interface: ["interface", "application", "domain"],
        application: ["application", "domain", "infrastructure"],
        domain: ["domain"],
        infrastructure: ["infrastructure", "domain"],
      },
    },
  };
}

/** Opens the Worktrees menu of the live map and, by default, the closed "Details" under the column, where the older lists are. */
export async function openSessions(page, { details = true } = {}) {
  await page.locator("#sessions-btn").click();
  if (!details) return;
  const more = page.locator("#sessions-more");
  await more.waitFor();
  if (!(await more.evaluate((node) => node.open))) await more.locator("> summary").click();
}
