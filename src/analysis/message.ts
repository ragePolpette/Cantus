/**
 * Sentences that say something about the project (findings) and that the map page shows in the person's
 * language. A message is a template written in English with `{slots}`, and the values for the slots.
 * The English text is built from it right here, so what an agent reads (`cantus check`, the MCP tools,
 * the briefings) stays what it always was; the page gets the template and the values and looks the
 * template up in its language.
 *
 * A value is text or a number as it is (names, files, what a compiler said), another message (a piece
 * of a sentence that has words of its own), or a list of values (`list` joins them with ", " or the
 * separator given). Pieces that start with a space or a punctuation mark are written with it in the
 * template, so a language can place it where it belongs.
 */
export type MsgValue = string | number | Msg | MsgList | MsgValue[] | undefined;

export interface Msg {
  /** The English template. */
  t: string;
  p?: Record<string, MsgValue>;
}

export interface MsgList {
  items: MsgValue[];
  sep: string;
}

/** A message. Count slots are called `n`, which is what a language picks the singular or plural form by. */
export function msg(t: string, p?: Record<string, MsgValue>): Msg {
  return p ? { t, p } : { t };
}

/** Values joined by `sep` (", " when it is left out). */
export function list(items: MsgValue[], sep = ", "): MsgList {
  return { items, sep };
}

/** The English text of a message or a value. */
export function renderMsg(value: MsgValue): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(renderMsg).join(", ");
  if ("items" in value) return value.items.map(renderMsg).join(value.sep);
  const params = value.p ?? {};
  return value.t.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? renderMsg(params[name]) : all));
}
