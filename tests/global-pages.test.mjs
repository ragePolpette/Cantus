import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze } from "../dist/index.js";

function project(files) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-global-pages-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"globals"}');
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const define = (name) => `function ${name}(payload) { return payload; }\n`;
const globalSites = (analysis, symbol = "sendPayload") =>
  analysis.callSites.filter((site) => site.via === "global" && site.symbol === symbol).map((site) => `${site.file} → ${site.targetFile} ${site.match}`).sort();

// The same global name defined by three scripts of three different pages.
const base = {
  "cart/cart.aspx": '<%@ Page MasterPageFile="~/layouts/shop.master" %>\n<%@ Register Src="~/cart/widget.ascx" TagPrefix="uc" TagName="Widget" %>\n<script src="../assets/cart/main.js"></script>\n',
  "cart/widget.ascx": '<script src="widget.js"></script>\n',
  "cart/widget.js": "function paint() { sendPayload({ a: 1 }); }\n",
  "assets/cart/main.js": define("sendPayload"),
  "legacy/old.html": '<script src="js/main.js"></script>\n<script src="old.js"></script>\n',
  "legacy/js/main.js": define("sendPayload"),
  "legacy/old.js": "function legacyPaint() { sendPayload({ b: 1 }); }\n",
  "shared/other.html": '<script src="http.js"></script>\n',
  "shared/http.js": define("sendPayload"),
  "layouts/shop.master": '<script src="layout.js"></script>\n',
  "layouts/layout.js": "function layoutInit() {}\n",
};

test("a script included through a user control runs with the scripts of the page that includes it", () => {
  const analysis = analyze(project(base), { skipGit: true });
  assert.deepEqual(globalSites(analysis), [
    "cart/widget.js → assets/cart/main.js likely",
    "legacy/old.js → legacy/js/main.js likely",
  ], "each caller goes to the definition its pages load, never to the other two");
  const arrows = analysis.dependencies.filter((dep) => dep.imports.some((entry) => entry.specifier === "global sendPayload")).map((dep) => `${dep.from}->${dep.to}`).sort();
  assert.deepEqual(arrows, ["cart->assets"], "legacy/old.js calls the definition of its own block");
  assert.deepEqual(analysis.pages.find((candidate) => candidate.file === "cart/cart.aspx").includes, ["layouts/shop.master", "cart/widget.ascx"]);
});

test("a caller that runs in known pages is not linked to a definition only other pages load", () => {
  const analysis = analyze(project({
    ...base,
    "legacy/js/main.js": "function legacyBoot() {}\n",
    "legacy/old.js": "function legacyPaint() { sendPayload({ b: 1 }); }\n",
  }), { skipGit: true });
  assert.deepEqual(globalSites(analysis), ["cart/widget.js → assets/cart/main.js likely"], "legacy/old.js sits in a page that loads none of the two remaining definitions");
  const note = analysis.diagnostics.find((diagnostic) => diagnostic.stage === "globals" && diagnostic.file === "legacy/old.js");
  assert.match(note.message, /`sendPayload` is defined only in .*assets\/cart\/main\.js.*shared\/http\.js.*not linked/);
});

test("a definition no page loads stays a candidate: code may load it", () => {
  const analysis = analyze(project({
    "a/page.html": '<script src="use.js"></script>\n',
    "a/use.js": "function go() { sendPayload(1); }\n",
    "b/page.html": '<script src="main.js"></script>\n',
    "b/main.js": define("sendPayload"),
    "c/late.js": define("sendPayload"),
  }), { skipGit: true });
  assert.deepEqual(globalSites(analysis), ["a/use.js → c/late.js by-name"]);
});

test("a single definition is linked whatever page loads it", () => {
  const analysis = analyze(project({
    "a/page.html": '<script src="use.js"></script>\n',
    "a/use.js": "function go() { sendPayload(1); }\n",
    "b/page.html": '<script src="main.js"></script>\n',
    "b/main.js": define("sendPayload"),
  }), { skipGit: true });
  assert.deepEqual(globalSites(analysis), ["a/use.js → b/main.js likely"]);
});

test("scripts and fragments loaded by code run with the page whose code loads them", () => {
  const analysis = analyze(project({
    "shop/shop.html": '<script src="main.js"></script>\n',
    "shop/main.js": [
      define("sendPayload"),
      'function open() { $("#slot").load("fragments/panel.html"); $.getScript("late.js"); }',
      "",
    ].join("\n"),
    "shop/fragments/panel.html": '<script src="panel.js"></script>\n',
    "shop/fragments/panel.js": "function paintPanel() { sendPayload(1); }\n",
    "shop/late.js": "function late() { sendPayload(2); }\n",
    "other/other.html": '<script src="main.js"></script>\n',
    "other/main.js": define("sendPayload"),
  }), { skipGit: true });
  assert.deepEqual(globalSites(analysis), [
    "shop/fragments/panel.js → shop/main.js likely",
    "shop/late.js → shop/main.js likely",
  ]);
});

test("a caller no page loads goes to the definition that shares a folder name with it", () => {
  const analysis = analyze(project({
    "orders/detail/detail.js": "function show() { sendPayload(1); }\n",
    "assets/orders/main.js": define("sendPayload"),
    "assets/legacy/main.js": define("sendPayload"),
    "shared/http.js": define("sendPayload"),
  }), { skipGit: true });
  assert.deepEqual(globalSites(analysis), ["orders/detail/detail.js → assets/orders/main.js by-name"]);
});
