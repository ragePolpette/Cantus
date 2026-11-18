/** One line of a line diff: kept, added in the new text, or removed from the old one. */
export interface DiffOp {
  type: "same" | "add" | "del";
  text: string;
  /** 1-based line in the old text (same, del). */
  oldLine?: number;
  /** 1-based line in the new text (same, add). */
  newLine?: number;
  /** For an added line: the agent that wrote it, when known. */
  agent?: string;
}

/** Above this many edits in the middle of two texts, the middle is shown as replaced instead of searched further. */
const MAX_EDITS = 4000;

/**
 * Line diff with Myers' algorithm (the one git uses by default): the shortest list of added and
 * removed lines that turns `a` into `b`. Common lines at both ends are matched first.
 */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "same", text: a[i], oldLine: i + 1, newLine: i + 1 });
  for (const op of middle(a.slice(start, endA), b.slice(start, endB))) {
    ops.push({
      ...op,
      ...(op.oldLine !== undefined ? { oldLine: op.oldLine + start } : {}),
      ...(op.newLine !== undefined ? { newLine: op.newLine + start } : {}),
    });
  }
  for (let i = 0; endA + i < a.length; i++) ops.push({ type: "same", text: a[endA + i], oldLine: endA + i + 1, newLine: endB + i + 1 });
  return ops;
}

function middle(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text, i) => ({ type: "add", text, newLine: i + 1 }));
  if (m === 0) return a.map((text, i) => ({ type: "del", text, oldLine: i + 1 }));
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    v = next;
  }
  if (!found) {
    // Too different to be worth searching: everything removed, then everything added.
    return [...a.map((text, i): DiffOp => ({ type: "del", text, oldLine: i + 1 })), ...b.map((text, i): DiffOp => ({ type: "add", text, newLine: i + 1 }))];
  }
  // Walk the trace back from the end to recover the edits.
  const reversed: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const previous = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = previous[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ type: "same", text: a[x - 1], oldLine: x, newLine: y });
      x--;
      y--;
    }
    if (x === prevX) reversed.push({ type: "add", text: b[y - 1], newLine: y });
    else reversed.push({ type: "del", text: a[x - 1], oldLine: x });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    reversed.push({ type: "same", text: a[x - 1], oldLine: x, newLine: y });
    x--;
    y--;
  }
  return reversed.reverse();
}

/** The lines of a text, without the empty item a final newline would add. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
