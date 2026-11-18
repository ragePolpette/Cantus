import { it } from "./it.js";

/**
 * The words of the map page. The English text in the code is the key and the fallback:
 * `tr("Save group")` shows "Save group" until a language has its own line for it.
 *
 * A message can hold `{name}` slots, filled from the parameters of the call. Counts use
 * `trn(n, "{n} block", "{n} blocks")`: its entry is looked up as "{n} block|{n} blocks" and may be a
 * string or one form per plural category of the language (`one`, `other`, and `few`, `many`, `zero`,
 * `two` where a language needs them; `other` is required).
 */
export type PluralForms = { other: string } & Partial<Record<"zero" | "one" | "two" | "few" | "many", string>>;
export type Messages = Record<string, string | PluralForms>;

export interface Language {
  /** BCP 47 base code, as `navigator.language` starts: `it`, `de`. */
  code: string;
  /** The name of the language in itself, for the selector. */
  name: string;
  messages: Messages;
}

export const SOURCE_LANGUAGE = { code: "en", name: "English" };

/** Add a language here, and its file next to this one: nothing else changes. */
export const LANGUAGES: Language[] = [{ code: "it", name: "Italiano", messages: it }];

/** What the page carries: the languages and their messages, as JSON that is safe inside a script tag. */
export function i18nPayload(): string {
  const messages: Record<string, Messages> = {};
  for (const language of LANGUAGES) messages[language.code] = language.messages;
  return JSON.stringify({ source: SOURCE_LANGUAGE, languages: LANGUAGES.map(({ code, name }) => ({ code, name })), messages }).replace(/</g, "\\u003c");
}
