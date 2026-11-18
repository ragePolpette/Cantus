import fs from "node:fs";
import path from "node:path";
export default (request) => {
  async function* run() {
    if (request.mode === "verify") {
      const file = "src/calc/calc.js";
      const implemented = fs.readFileSync(path.join(request.cwd, file), "utf8").includes("return a * b");
      const review = implemented
        ? { verdict: "ok", summary: "Multiply is implemented", checked: [file], findings: [] }
        : { verdict: "issues", summary: "Multiply is missing", checked: [file], findings: [{ severity: "major", title: "Missing multiply", file }] };
      yield { type: "result", ok: true, text: JSON.stringify(review), costUsd: 0.01 };
      return;
    }
    const p = request.prompt;
    const w = (f, c) => { if (fs.existsSync(path.join(request.cwd, f)) && fs.readFileSync(path.join(request.cwd, f), "utf8").includes(c.trim())) return; fs.mkdirSync(path.dirname(path.join(request.cwd, f)), { recursive: true }); fs.appendFileSync(path.join(request.cwd, f), c); };
    for (const fn of ["negate", "double", "triple", "half", "third"]) if (p.includes(`function ${fn}`)) w("src/calc.js", `\nexport function ${fn}(a) { return a; }\n`);
    if (p.includes("Add an exported function format(n)")) { fs.mkdirSync(path.join(request.cwd, "src/fmt"), { recursive: true }); fs.writeFileSync(path.join(request.cwd, "src/fmt/fmt.js"), 'import { add } from "../calc/calc.js";\nexport function format(n) {\n  return `#${add(n, 0)}`;\n}\n'); }
    if (p.includes("Add an exported function multiply(a, b) to src/calc/calc.js") && !fs.readFileSync(path.join(request.cwd, "src/calc/calc.js"), "utf8").includes("multiply")) fs.appendFileSync(path.join(request.cwd, "src/calc/calc.js"), "\nexport function multiply(a, b) { return a * b; }\n");
    if (p.includes("NOTES.md must exist")) fs.writeFileSync(path.join(request.cwd, "NOTES.md"), "ready\n");
    if (p.includes("test suite fails")) fs.writeFileSync(path.join(request.cwd, "src/rule.js"), "export function isAdult(age) {\n  return age >= 18;\n}\n");
    yield { type: "result", ok: true, text: "done by the fake", costUsd: 0.01 };
  }
  const it = run();
  return { [Symbol.asyncIterator]: () => it, async setPermissionMode() {} };
};
