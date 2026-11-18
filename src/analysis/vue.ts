/** Vue single-file components and component tags in templates. */

export const isVueFile = (file: string): boolean => /\.vue$/i.test(file);

/** The name to give the parser: a `.vue` file's script is parsed as TypeScript (a superset of what Vue scripts use). */
export const parseName = (file: string): string => (isVueFile(file) ? `${file}.ts` : file);

const BLOCK = /<(script|template)\b([^>]*)>/gi;

export interface SfcParts {
  /** The `<script>` / `<script setup>` code, with everything else blanked so offsets and lines match the file. */
  script: string;
  lang: "ts" | "js";
  /** The component's template, with its offset in the file. */
  template?: { text: string; offset: number };
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");

/** Splits a `.vue` file into its script code (in place) and its template. */
export function sfcParts(source: string): SfcParts {
  let script = "";
  let cursor = 0;
  let lang: "ts" | "js" = "js";
  let template: SfcParts["template"];
  for (const match of source.matchAll(BLOCK)) {
    const start = match.index ?? 0;
    if (start < cursor) continue; // inside a block already read (e.g. a nested <template>)
    const tag = match[1].toLowerCase();
    const bodyStart = start + match[0].length;
    if (tag === "script") {
      const end = source.indexOf("</script>", bodyStart);
      if (end < 0) break;
      if (/\blang\s*=\s*["']tsx?["']/i.test(match[2])) lang = "ts";
      script += blank(source.slice(cursor, bodyStart)) + source.slice(bodyStart, end);
      cursor = end;
    } else if (!template) {
      // The outer template ends at the last </template> before the next top-level block.
      const nextScript = source.slice(bodyStart).search(/<script\b|<style\b/i);
      const limit = nextScript < 0 ? source.length : bodyStart + nextScript;
      const end = source.lastIndexOf("</template>", limit);
      if (end < bodyStart) continue;
      template = { text: source.slice(bodyStart, end), offset: bodyStart };
      script += blank(source.slice(cursor, end));
      cursor = end;
    }
  }
  return { script: script + blank(source.slice(cursor)), lang, ...(template ? { template } : {}) };
}

/** `OrderList`, `orderList` and `order-list` all name the component `order-list`. */
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/** Opening tags in markup or a template, as kebab-case names with their offsets. */
export function componentTags(text: string, offset = 0): Array<{ name: string; raw: string; offset: number }> {
  const tags: Array<{ name: string; raw: string; offset: number }> = [];
  for (const match of text.matchAll(/<([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)[\s/>]/g)) {
    tags.push({ name: kebabCase(match[1]), raw: match[1], offset: offset + (match.index ?? 0) + 1 });
  }
  return tags;
}

/** Name of the component a `.vue` file defines, from its file name. */
export function sfcComponentName(file: string): string {
  const base = file.split("/").pop()!.replace(/\.vue$/i, "");
  return kebabCase(base === "index" ? file.split("/").slice(-2, -1)[0] ?? base : base);
}
