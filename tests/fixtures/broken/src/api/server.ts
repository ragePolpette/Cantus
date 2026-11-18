import { rule } from "../core/rules.js";
import { missing } from "../core/does-not-exist.js";
import config from "./config.json";

export function handler(input: string): string {
  return rule(input) + missing + String(config);
}
