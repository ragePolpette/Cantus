/**
 * Member-level view of an export's shape. A class is one export, but what breaks its callers is a
 * member: a method whose parameters changed, a property that went away. Reading the members out of
 * the shape lets a change say which one moved and keep out the callers that never touch it.
 */

export interface MemberDiff {
  /** The part before the members (name, base types, modifiers) differs: everything that uses the type is affected. */
  headerChanged: boolean;
  /** Member names whose declaration changed (a parameter, a type, a modifier). */
  changed: string[];
  added: string[];
  removed: string[];
  /** A type others implement: a member added to it breaks them as well. */
  contract: boolean;
}

interface Parsed {
  header: string;
  members: Map<string, string[]>;
}

const CONTINUES = /^[\s|&,)\]=?:.>]/;

/** The members of a declaration written as `header{member;member;…}`; undefined when it has no body to read. */
function parseShape(shape: string): Parsed | undefined {
  const open = shape.indexOf("{");
  if (open < 0 || !shape.endsWith("}")) return undefined;
  const header = shape.slice(0, open).trim();
  const body = shape.slice(open + 1, -1);
  const pieces: string[] = [];
  let depth = 0;
  let angle = 0; // `Map<string,number>`: its comma separates nothing
  let start = 0;
  const flush = (end: number) => {
    const piece = body.slice(start, end).trim().replace(/[;,]$/, "").trim();
    if (piece) pieces.push(piece);
    start = end;
  };
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === "{" || char === "(" || char === "[") depth++;
    else if (char === "<") angle++;
    else if (char === ">" && angle > 0 && body[index - 1] !== "-" && body[index - 1] !== "=") angle--;
    else if (char === "}" || char === ")" || char === "]") {
      depth--;
      // A member ending in a block (`P{get;set;}`) is followed by the next one with no separator.
      if (char === "}" && depth === 0 && index + 1 < body.length && !CONTINUES.test(body[index + 1]) && body[index + 1] !== ";") flush(index + 1);
    } else if ((char === ";" || char === ",") && depth === 0 && angle === 0) flush(index + 1);
  }
  flush(body.length);
  const members = new Map<string, string[]>();
  for (const piece of pieces) {
    const name = memberName(piece);
    members.set(name, [...(members.get(name) ?? []), piece].sort());
  }
  return { header, members };
}

const MODIFIERS = new Set(["public", "protected", "internal", "private", "static", "readonly", "const", "event", "new", "virtual", "override", "abstract", "sealed", "extern", "unsafe", "volatile", "partial", "async", "final", "default"]);

/** The identifier a member declaration is about: the word before its parameters, its accessors, its type annotation or its initializer. */
export function memberName(declaration: string): string {
  // Go's `func (item *Item) Len() int`: the name follows the receiver.
  const receiver = /^func\s*\([^)]*\)\s*([A-Za-z_]\w*)/.exec(declaration);
  if (receiver) return receiver[1];
  let cut = declaration.length;
  let marked = false;
  for (const mark of ["(", "{", ":", "="]) {
    const at = declaration.indexOf(mark);
    if (at >= 0 && at < cut) {
      cut = at;
      marked = true;
    }
  }
  const head = declaration.slice(0, cut).replace(/<[^<>]*(<[^<>]*>[^<>]*)*>\s*$/, "").replace(/[?!]\s*$/, "").trim();
  // `public int Total` ends with the name; Go's `Text string` and `Items []Item` begin with it.
  if (!marked && !MODIFIERS.has(head.split(/\s+/)[0])) return /^([A-Za-z_$][\w$]*)/.exec(head)?.[1] ?? declaration;
  return /([A-Za-z_$][\w$]*)$/.exec(head)?.[1] ?? declaration;
}

/**
 * What changed between two shapes of the same type, by member; undefined when either has no members
 * to read (a function, a constant, an alias) and the whole export is the unit.
 */
export function diffMembers(before: string, after: string): MemberDiff | undefined {
  // Several declarations under one name (the parts of a `partial` class) come joined by a line break, in order.
  const parts = [before.split("\n"), after.split("\n")];
  if (parts[0].length !== parts[1].length) return undefined;
  if (parts[0].length > 1) {
    const each = parts[0].map((part, index) => diffMembers(part, parts[1][index]));
    if (each.some((diff) => !diff)) return undefined;
    const all = each as MemberDiff[];
    const union = (pick: (diff: MemberDiff) => string[]) => [...new Set(all.flatMap(pick))];
    return { headerChanged: all.some((diff) => diff.headerChanged), changed: union((diff) => diff.changed), added: union((diff) => diff.added), removed: union((diff) => diff.removed), contract: all.some((diff) => diff.contract) };
  }
  const left = parseShape(before);
  const right = parseShape(after);
  if (!left || !right || (left.members.size === 0 && right.members.size === 0)) return undefined;
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [name, lines] of left.members) {
    const now = right.members.get(name);
    if (!now) removed.push(name);
    // Every old declaration is still there: an overload was added, and the calls that exist still match one of them.
    else if (now.join("\n") !== lines.join("\n")) (lines.every((line) => now.includes(line)) ? added : changed).push(name);
  }
  for (const name of right.members.keys()) if (!left.members.has(name)) added.push(name);
  return { headerChanged: left.header !== right.header, changed, added, removed, contract: /\binterface\b/.test(right.header) || /\babstract\b/.test(right.header) };
}

/** The members whose change can break a user of the type: changed or removed, and added to a contract others implement. */
export function breakingMembers(diff: MemberDiff): string[] {
  return [...diff.changed, ...diff.removed, ...(diff.contract ? diff.added : [])];
}

/** Whether `text` uses one of the members by name (`.name`, `name(`, `::name`). */
export function mentionsMember(text: string, members: string[]): boolean {
  if (members.length === 0) return false;
  const escaped = members.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\w$])(?:${escaped.join("|")})(?![\\w$])`).test(text);
}

/** The diff in words: `changed: send; removed: stop; added to the contract: ping`. */
export function describeMembers(diff: MemberDiff): string {
  const names = (list: string[]) => list.slice(0, 5).join(", ") + (list.length > 5 ? `, … (${list.length})` : "");
  return [diff.changed.length ? `changed: ${names(diff.changed)}` : "", diff.removed.length ? `removed: ${names(diff.removed)}` : "", diff.added.length ? `${diff.contract ? "added to the contract" : "added"}: ${names(diff.added)}` : ""].filter(Boolean).join("; ");
}
