import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze } from "../dist/index.js";
import { findCallers } from "../dist/analysis/callers.js";
import { traceTarget } from "../dist/analysis/trace.js";

function project() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-links-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", '{"name":"links"}');
  write("web/ordine.aspx", '<html><body><h1>Order</h1></body></html>\n');
  write("web/a/index.html", "<html><body>a</body></html>\n");
  write("web/b/index.html", "<html><body>b</body></html>\n");
  write("web/Ordini/vuoto.html", '<html><body><script src="../js/nav.js"></script></body></html>\n');
  write("web/Ordini/dettaglio.html", "<html><body>detail</body></html>\n");
  write("web/js/nav.js", [
    'export function open(id) { window.location.href = "Ordini/dettaglio.html?id=" + id; }',
    'export const home = "/index.html";',
    '// "ordine.aspx?c=" in a comment is not a link',
    "",
  ].join("\n"));
  write("services/Notifier.cs", [
    "public class Notifier {",
    "  public void SendMail(string baseUrl, int c, int m) {",
    '    var url = baseUrl + "ordine.aspx?c=" + c;',
    '    url += "&m=" + m;',
    '    Send($"Open {url}");',
    '    var other = "readme.txt";',
    "  }",
    "}",
    "",
  ].join("\n"));
  return root;
}

test("a literal that names a page file is a link to that page, found in code of any language", () => {
  const analysis = analyze(project(), { skipGit: true });
  const links = analysis.callSites.filter((site) => site.via === "link");
  assert.deepEqual(links.map((site) => `${site.file}:${site.line} → ${site.targetFile} ${site.match}`).sort(), [
    "services/Notifier.cs:3 → web/ordine.aspx likely",
    "web/js/nav.js:1 → web/Ordini/dettaglio.html likely",
    "web/js/nav.js:2 → web/a/index.html by-name",
    "web/js/nav.js:2 → web/b/index.html by-name",
  ], "index.html exists twice: both are candidates, by name only; the comment and readme.txt are not links");
  assert.equal(links.find((site) => site.file === "services/Notifier.cs").symbol, "ordine.aspx");
  assert.equal(analysis.dependencies.some((dep) => dep.to === links[0].targetBlock && dep.from === links[0].block && dep.symbols.includes("ordine.aspx")), false, "a link is a call site, not a block dependency");
});

test("callers and trace answer who builds the link to a page", () => {
  const analysis = analyze(project(), { skipGit: true });
  const callers = findCallers(analysis, { symbol: "ordine.aspx" });
  assert.deepEqual(callers.sites.map((site) => `${site.file}:${site.line}`), ["services/Notifier.cs:3"]);
  const trace = traceTarget(analysis, "ordine.aspx");
  assert.match(trace, /### Page `web\/ordine\.aspx`/);
  assert.match(trace, /Links to it are built in:\n- `services\/Notifier\.cs:3`[^\n]*: `var url = baseUrl \+ "ordine\.aspx\?c=" \+ c;`/);
  assert.match(traceTarget(analysis, "vuoto.html"), /Links to it built in code: none found/);
});
