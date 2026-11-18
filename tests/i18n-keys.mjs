import { readdirSync, readFileSync } from "node:fs";

/**
 * The messages the map page asks for: every `tr("…")` and `trn(n, "one", "other")` in its script.
 * Returns the keys as the page looks them up (`one|other` for counts) and the calls whose texts are not plain literals.
 */
export function pageMessages(script) {
  const keys = new Map();
  const dynamic = [];
  const call = /(?<!function )(?<![\w$.])(trn|tr)\(/g;
  let match;
  while ((match = call.exec(script))) {
    const name = match[1];
    const args = splitArguments(script, call.lastIndex);
    const line = script.slice(0, match.index).split("\n").length;
    const literal = (arg) => {
      const m = /^"((?:[^"\\]|\\.)*)"$/.exec(arg.trim());
      return m ? JSON.parse(`"${m[1]}"`) : undefined;
    };
    const texts = (name === "tr" ? [args[0]] : [args[1], args[2]]).map((arg) => (arg === undefined ? undefined : literal(arg)));
    if (texts.some((text) => text === undefined)) { dynamic.push(`${name}(${args.join(", ").slice(0, 80)}) near script line ${line}`); continue; }
    const key = texts.join("|");
    const slots = [...(texts.join(" ").matchAll(/\{(\w+)\}/g))].map((m) => m[1]);
    keys.set(key, { kind: name, line, slots: [...new Set(slots)] });
  }
  return { keys, dynamic };
}

/** The top-level arguments of a call whose "(" was just read, up to the matching ")". */
function splitArguments(text, from) {
  const args = [];
  let depth = 0, start = from, i = from;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) { args.push(text.slice(start, i)); return args; }
      depth--;
    } else if (c === "," && depth === 0) { args.push(text.slice(start, i)); start = i + 1; }
  }
  return args;
}

/** `{name}` slots in a message line (a string or the forms of a count). */
export function slotsOf(line) {
  const forms = typeof line === "string" ? [line] : Object.values(line);
  return [...new Set(forms.flatMap((form) => [...form.matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort();
}

/**
 * The templates the analysis writes its messages from (`msg("…", {…})` in src/analysis): the page looks each up in
 * its language, so each needs a line there. Read from the sources, since a template is only built when its case happens.
 */
export function analysisTemplates() {
  const dir = new URL("../src/analysis/", import.meta.url);
  const templates = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(new URL(name, dir), "utf8");
    for (const match of text.matchAll(/(?<![\w$.])msg\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      templates.set(JSON.parse(`"${match[1]}"`), { kind: "msg", file: name, slots: [...new Set([...match[1].matchAll(/\{(\w+)\}/g)].map((m) => m[1]))] });
    }
  }
  return templates;
}
