import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureCantusIgnore } from "../model/ignore.js";

/** A change to the map that `refine` would make but may not: kept until someone applies it or says no. */
export interface StoredSuggestion {
  id: string;
  block?: string;
  kind: "split" | "merge" | "exclude" | "layer" | "other";
  text: string;
}

/** Outside git, with the other caches: a suggestion of a model is no part of the map. */
export const SUGGESTIONS_FILE = path.join(".cantus", "cache", "refine-suggestions.json");

/** Short and stable, so a person or an agent can name one: the same suggestion always has the same id. */
export function suggestionId(suggestion: { block?: string; kind: string; text: string }): string {
  return createHash("sha1").update(`${suggestion.kind}|${suggestion.block ?? ""}|${suggestion.text.trim()}`).digest("hex").slice(0, 6);
}

export function readSuggestions(root: string): StoredSuggestion[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, SUGGESTIONS_FILE), "utf8")) as { suggestions?: StoredSuggestion[] };
    return Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((entry) => entry && typeof entry.id === "string" && typeof entry.text === "string") : [];
  } catch {
    return [];
  }
}

function writeSuggestions(root: string, suggestions: StoredSuggestion[]): void {
  const file = path.join(root, SUGGESTIONS_FILE);
  if (suggestions.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ensureCantusIgnore(root);
  fs.writeFileSync(file, `${JSON.stringify({ suggestions }, null, 2)}\n`);
}

/** Adds what a refine run suggested to what is still open; the same suggestion is kept once. Returns the ones that are new. */
export function addSuggestions(root: string, found: Array<Omit<StoredSuggestion, "id">>): StoredSuggestion[] {
  const open = readSuggestions(root);
  const known = new Set(open.map((entry) => entry.id));
  const added: StoredSuggestion[] = [];
  for (const suggestion of found) {
    const entry: StoredSuggestion = { id: suggestionId(suggestion), ...(suggestion.block ? { block: suggestion.block } : {}), kind: suggestion.kind, text: suggestion.text.trim() };
    if (known.has(entry.id)) continue;
    known.add(entry.id);
    added.push(entry);
  }
  if (added.length > 0) writeSuggestions(root, [...open, ...added]);
  return added;
}

/** Closes suggestions (applied or declined): the ids given, or all of them. Returns how many were closed. */
export function dismissSuggestions(root: string, ids: string[] | "all"): number {
  const open = readSuggestions(root);
  const keep = ids === "all" ? [] : open.filter((entry) => !ids.includes(entry.id));
  if (keep.length !== open.length) writeSuggestions(root, keep);
  return open.length - keep.length;
}
