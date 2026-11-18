import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, compareAnalyses, renderDelta, writeProjectIndex } from "../dist/index.js";
import { handleHook } from "../dist/hooks/handlers.js";
import { readChanges } from "../dist/state/changes.js";
import { apiChanges } from "../dist/state/impact.js";
import { breakingMembers, diffMembers, memberName } from "../dist/analysis/members.js";

const ORDERS = `namespace App.Model
{
    public partial class Orders
    {
        public int Total { get; set; }
        public int Count(int a)
        {
            return a + 1;
        }
        public string Name => "x";
        public void Save() { }
    }
    public partial class Orders
    {
        public int Other() { return 2; }
    }
}
`;
const CONTROLLER = `using App.Model;
namespace App.Api
{
    public class Controller
    {
        public int Go() { var o = new Orders(); return o.Count(1) + o.Other() + o.Total; }
    }
}
`;

function project() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-members-"));
  fs.mkdirSync(path.join(root, "Model"));
  fs.mkdirSync(path.join(root, "Api"));
  fs.writeFileSync(path.join(root, "Model/Orders.cs"), ORDERS);
  fs.writeFileSync(path.join(root, "Api/Controller.cs"), CONTROLLER);
  return root;
}

const edit = (root, source) => {
  const file = path.join(root, "Model/Orders.cs");
  fs.writeFileSync(file, source);
  return handleHook("post-edit", { tool_input: { file_path: file }, cwd: root }, root)?.hookSpecificOutput.additionalContext ?? "";
};

test("the hook after an edit stays quiet for a body, even in a class declared in two parts", () => {
  const root = project();
  writeProjectIndex(root, analyze(root, { skipGit: true }));
  assert.equal(edit(root, ORDERS.replace("return a + 1;", "return a + 2;")), "");
  assert.equal(edit(root, ORDERS.replace('=> "x"', '=> "y"')), "");
  assert.equal(edit(root, ORDERS.replace("return 2;", "return 3;")), "", "the second part");
  assert.equal(edit(root, ORDERS.replace("public void Save() { }", "public void Save() { }\n public void Fresh() { }")), "", "a member added to a class breaks nobody");
});

test("the hook names the member that changed and lists only the files that use it", () => {
  const root = project();
  writeProjectIndex(root, analyze(root, { skipGit: true }));
  const said = edit(root, ORDERS.replace("Count(int a)", "Count(int a, int b)"));
  assert.match(said, /Orders: changed: Count; other blocks use it here: Api\/Controller\.cs:6/);
  assert.doesNotMatch(said, /changed its declaration/);
  assert.equal(edit(root, ORDERS.replace("Save()", "Save(int q)")), "", "nobody calls Save");
  assert.match(edit(root, ORDERS.replace("public int Total", "public long Total")), /changed: Total/);
  assert.match(edit(root, ORDERS.replace("public partial class Orders\n    {\n        public int Total", "public partial class Orders : Base\n    {\n        public int Total")), /Orders changed its declaration/, "a changed header affects every user");
});

test("diffMembers reads members from a shape, with or without separators after a block", () => {
  assert.equal(memberName("public List<int> Get<T>(int a)"), "Get");
  assert.equal(memberName("Total{get;set;}"), "Total");
  assert.equal(memberName("readonly a?:Map<string,number>"), "a");
  const diff = diffMembers("class A{public int X{get;set;}public void Y(int a);public int Z;}", "class A{public int X{get;set;}public void Y(int a,int b);}");
  assert.deepEqual({ changed: diff.changed, removed: diff.removed, added: diff.added, header: diff.headerChanged }, { changed: ["Y"], removed: ["Z"], added: [], header: false });
  assert.deepEqual(breakingMembers(diffMembers("interface I{a():void;}", "interface I{a():void;b():void;}")), ["b"], "a member added to an interface breaks its implementers");
  assert.equal(diffMembers("function f(a):void", "function f(a,b):void"), undefined);
});

function committed(root) {
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
}

test("review_changes: a body edit is no API change, a member edit lists only the callers of that member", () => {
  const root = project();
  committed(root);
  fs.writeFileSync(path.join(root, "Model/Orders.cs"), ORDERS.replace("return a + 1;", "return a + 9;"));
  assert.deepEqual(apiChanges(root, analyze(root, { skipGit: true }), readChanges(root)), []);

  fs.writeFileSync(path.join(root, "Model/Orders.cs"), ORDERS.replace("Count(int a)", "Count(int a, int b)").replace("Save()", "Save(int q)"));
  const [change, ...rest] = apiChanges(root, analyze(root, { skipGit: true }), readChanges(root));
  assert.equal(rest.length, 0);
  assert.equal(change.name, "Orders");
  assert.match(change.members, /changed: Count, Save/);
  assert.deepEqual(change.callers.map((site) => site.file), ["Api/Controller.cs"]);
});

test("diff: a type with changed members says which, and leaves out the files that use none of them", () => {
  const root = project();
  fs.writeFileSync(path.join(root, "Api/Quiet.cs"), "using App.Model;\nnamespace App.Api\n{\n    public class Quiet\n    {\n        public Orders Make() { return new Orders(); }\n    }\n}\n");
  const snapshot = (label) => ({ label, analysis: analyze(root, { skipGit: true }), findings: [], read: (file) => fs.readFileSync(path.join(root, file), "utf8") });
  const base = snapshot("base");
  fs.writeFileSync(path.join(root, "Model/Orders.cs"), ORDERS.replace("Count(int a)", "Count(int a, int b)"));
  const delta = compareAnalyses(base, snapshot("head"));
  const change = delta.exports.changed.find((entry) => entry.name === "Orders");
  assert.equal(change.members, "changed: Count");
  assert.deepEqual(change.callers.map((caller) => caller.file), ["Api/Controller.cs"], "Quiet.cs uses the type but not the member");
  assert.match(renderDelta(delta), /changed: Count\./);
});

test("memberName reads Go receivers and fields", () => {
  assert.equal(memberName("func (item *Item) Len() int"), "Len");
  assert.equal(memberName("Text string"), "Text");
  assert.equal(memberName("Items []Item"), "Items");
  assert.equal(memberName("public static readonly int Min"), "Min");
});

test("a shape keeps the end of each member where the language writes them one per line", async () => {
  const { normalizeShape } = await import("../dist/analysis/catalog.js");
  assert.equal(normalizeShape("type Item struct {\n    Text string\n    func (item *Item) Len() int\n}"), "type Item struct{Text string;func(item *Item)Len()int;}");
  assert.equal(normalizeShape("class A {\n    m(\n        a: number,\n        b: string\n    ): void;\n}"), "class A{m(a:number,b:string):void;}");
  assert.deepEqual(diffMembers("a:Map<string,number>;b:string", "x"), undefined);
  const diff = diffMembers("class A{a:Map<string,number>;b:string;}", "class A{a:Map<string,number>;b:number;}");
  assert.deepEqual(diff.changed, ["b"]);
});

test("an overload added next to the old one breaks nobody: the hook stays quiet, a contract still counts", () => {
  const root = project();
  writeProjectIndex(root, analyze(root, { skipGit: true }));
  assert.equal(edit(root, ORDERS.replace("public int Count(int a)", "public int Count(int a, int b) { return a + b; }\n        public int Count(int a)")), "", "the old Count is still there");
  const diff = diffMembers("class A{public void Y(int a);}", "class A{public void Y(int a);public void Y(int a,int b);}");
  assert.deepEqual({ changed: diff.changed, added: diff.added }, { changed: [], added: ["Y"] });
  assert.deepEqual(breakingMembers(diffMembers("interface I{a():void;}", "interface I{a():void;a(x:number):void;}")), ["a"], "an overload added to an interface breaks its implementers");
  assert.deepEqual(diffMembers("class A{public void Y(int a);}", "class A{public void Y(long a);public void Y(int a,int b);}").changed, ["Y"], "the old form gone: a change");
});

test("the same warning after an edit is said once per session, and again when it changes", () => {
  const root = project();
  writeProjectIndex(root, analyze(root, { skipGit: true }));
  const file = path.join(root, "Model/Orders.cs");
  const say = (source) => {
    fs.writeFileSync(file, source);
    return handleHook("post-edit", { tool_input: { file_path: file }, cwd: root, session_id: "s1" }, root)?.hookSpecificOutput.additionalContext ?? "";
  };
  const changed = ORDERS.replace("Count(int a)", "Count(int a, int b)");
  assert.match(say(changed), /changed: Count/);
  assert.equal(say(changed.replace("return a + 1;", "return a + 2;")), "", "a second edit of the same file does not repeat it");
  assert.match(say(changed.replace("public int Total", "public long Total")), /changed: Count, Total|changed: Total, Count/, "a new change is said");
});
