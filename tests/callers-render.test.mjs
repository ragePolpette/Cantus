import assert from "node:assert/strict";
import test from "node:test";
import { distinctCalls, renderCallers } from "../dist/context/index.js";

const site = (file, line, extra = {}) => ({
  symbol: "Pricing",
  targetFile: "src/pricing.cs",
  targetBlock: "pricing",
  file,
  block: "web",
  line,
  column: 5,
  snippet: `use(${line});`,
  via: "type",
  match: "likely",
  ...extra,
});

test("callers are grouped by calling file, one line per call, and the common mark is said once", () => {
  const sites = [site("src/a.cs", 664), site("src/a.cs", 664, { column: 30 }), site("src/a.cs", 666), site("src/a.cs", 668), site("src/b.cs", 7)];
  assert.equal(distinctCalls(sites).length, 4, "two mentions on one line are one call");
  const text = renderCallers(sites).join("\n");
  assert.match(text, /`Pricing` — 4 call site\(s\), all likely\n- `src\/a\.cs:664, 666, 668` \(web\): `use\(664\);`\n- `src\/b\.cs:7` \(web\): `use\(7\);`/);
  assert.doesNotMatch(text, /\(likely\)/);

  const mixed = renderCallers([site("src/a.cs", 1), site("src/b.cs", 2, { match: "by-name" })]).join("\n");
  assert.match(mixed, /1 found by name only/);
  assert.match(mixed, /`src\/a\.cs:1` \(web\): `use\(1\);` \(likely\)\n- `src\/b\.cs:2` \(web\): `use\(2\);` \(by name only\)/, "marks stay where the sites differ");
});

test("call sites in tests are counted on one line, and listed on request", () => {
  const sites = [
    site("src/a.cs", 1),
    site("Shop.Tests/OrderTests.cs", 10),
    site("Shop.Tests/OrderTests.cs", 20),
    site("Shop.Tests/Helpers/Fake.cs", 3),
    site("web/cart.test.ts", 4),
  ];
  const text = renderCallers(sites).join("\n");
  assert.match(text, /`Pricing` — 5 call site\(s\), all likely\n- `src\/a\.cs:1` \(web\): `use\(1\);`\n- \+ 4 call site\(s\) in tests: `Shop\.Tests\/OrderTests\.cs` \(2\), `Shop\.Tests\/Helpers\/Fake\.cs`, `web\/cart\.test\.ts`$/);
  assert.doesNotMatch(text, /use\(10\)/);
  const full = renderCallers(sites, { tests: "full" }).join("\n");
  assert.match(full, /`Shop\.Tests\/OrderTests\.cs:10, 20`/);
  assert.doesNotMatch(full, /in tests:/);
});

test("more calling files than the cap end with a count", () => {
  const sites = Array.from({ length: 12 }, (_, index) => site(`src/f${index}.cs`, 1));
  assert.match(renderCallers(sites).join("\n"), /- … 4 more file\(s\)$/);
  assert.doesNotMatch(renderCallers(sites, { perSymbol: 20 }).join("\n"), /more file/);
});
