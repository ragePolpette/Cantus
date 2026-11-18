import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, buildContextPack, check, renderContextPrompt } from "../dist/index.js";
import { estimateTokens } from "../dist/analysis/analyze.js";
import { traceTarget } from "../dist/analysis/trace.js";

function project(extraOperations = 0) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-wcf-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", '{"name":"wcf"}');
  write("api/Tasks.svc", '<%@ ServiceHost Language="C#" Service="Demo.Tasks" CodeBehind="Tasks.svc.cs" %>\n');
  write("api/ITasks.cs", [
    "using System.ServiceModel;",
    "using System.ServiceModel.Web;",
    "namespace Demo {",
    "  [ServiceContract]",
    "  public interface ITasks {",
    "    [OperationContract]",
    '    [WebInvoke(Method = "POST", UriTemplate = "SetState", BodyStyle = WebMessageBodyStyle.Wrapped, RequestFormat = WebMessageFormat.Json)]',
    "    bool SetState(int taskId, string state);",
    "    [OperationContract]",
    '    [WebGet(UriTemplate = "Board/{studio}?sort={sort}")]',
    "    List<string> Board(string studio, string sort);",
    "    [OperationContract]",
    '    [WebInvoke(Method = "POST", UriTemplate = "Defaults/{id}", BodyStyle = WebMessageBodyStyle.Wrapped)]',
    "    void Defaults(int id, string name);",
    ...Array.from({ length: extraOperations }, (_, index) => `    string Unused${index}(int a, string b);`),
    "  }",
    "}",
  ].join("\n"));
  write("api/Tasks.svc.cs", [
    "namespace Demo {",
    "  public class Tasks : ITasks {",
    "    public bool SetState(int taskId, string state) { return true; }",
    "    public List<string> Board(string studio, string sort) { return null; }",
    "    public void Defaults(int id, string name) { }",
    "  }",
    "}",
  ].join("\n"));
  write("board/board.js", [
    "function moveCard(id, state) {",
    '  $.ajax({ url: "../api/Tasks.svc/SetState", type: "POST", data: JSON.stringify({ taskId: id, state: state }) });',
    '  $.ajax({ url: "../api/Tasks.svc/Board/studio1?sort=a", type: "GET" });',
    "}",
    "",
  ].join("\n"));
  return root;
}

test("a WCF endpoint carries its signature, UriTemplate and BodyStyle, and the body members Wrapped expects", () => {
  const analysis = analyze(project(), { skipGit: true });
  const endpoint = (handler) => analysis.endpoints.find((candidate) => candidate.handler === handler);
  assert.deepEqual(
    { signature: endpoint("Tasks.SetState").signature, template: endpoint("Tasks.SetState").template, bodyStyle: endpoint("Tasks.SetState").bodyStyle, bodyMembers: endpoint("Tasks.SetState").bodyMembers },
    { signature: "bool SetState(int taskId, string state)", template: "SetState", bodyStyle: "Wrapped", bodyMembers: ["taskId", "state"] },
  );
  assert.equal(endpoint("Tasks.Board").bodyStyle, undefined, "no BodyStyle written: the default, nothing to say");
  assert.deepEqual(endpoint("Tasks.Defaults").bodyMembers, ["name"], "the parameter the UriTemplate names is not in the body");
  assert.match(analysis.contracts["api/Tasks.svc.cs"], /\/\/ POST \/api\/Tasks\.svc\/SetState → Tasks\.SetState \(line 3\): `bool SetState\(int taskId, string state\)`; UriTemplate `SetState`; BodyStyle Wrapped/);
});

test("the briefing of the block that calls the service gives each endpoint it uses, also when the contract is too big to be given whole", () => {
  for (const extra of [0, 700]) {
    const root = project(extra);
    const analysis = analyze(root, { skipGit: true });
    const pack = buildContextPack(analysis, "board", undefined, check(analysis));
    const prompt = renderContextPrompt(pack, { root, inlineSources: false });
    assert.ok(extra === 0 || pack.contractTokens > 4000, "the big contract goes the short way");
    if (extra > 0) assert.ok(estimateTokens(prompt) < 2500, `the unused operations are not listed (${estimateTokens(prompt)} tokens)`);
    assert.match(prompt, /bool SetState\(int taskId, string state\)`; UriTemplate `SetState`; BodyStyle Wrapped \(body: an object with `taskId`, `state`; other members are not read\)/);
    assert.match(prompt, /UriTemplate `Board\/\{studio\}\?sort=\{sort\}`/);
    if (extra > 0) assert.doesNotMatch(prompt, /Defaults\/\{id\}/, "an endpoint the block does not call is not described");
  }
});

test("a short briefing still gives the endpoints the block calls", () => {
  const root = project();
  const analysis = analyze(root, { skipGit: true });
  const pack = buildContextPack(analysis, "board", undefined, check(analysis));
  const full = renderContextPrompt(pack, { root, inlineSources: false });
  const short = renderContextPrompt(pack, { root, inlineSources: false, maxTokens: estimateTokens(full) - 20 });
  assert.match(short, /is large: the briefing is shortened/);
  assert.match(short, /api\/Tasks\.svc\.cs:3`: POST `\/api\/Tasks\.svc\/SetState` → Tasks\.SetState — `bool SetState\(int taskId, string state\)`; UriTemplate `SetState`; BodyStyle Wrapped/);
});

test("trace gives the contract of the endpoint", () => {
  const analysis = analyze(project(), { skipGit: true });
  assert.match(traceTarget(analysis, "/api/Tasks.svc/SetState"), /Contract: `bool SetState\(int taskId, string state\)`; UriTemplate `SetState`; BodyStyle Wrapped \(body: an object with `taskId`, `state`/);
});
