import { add } from "@lib/math";
export * from "@lib/format";
const lazy = () => import("../lib/format.js");
const legacy = require("../lib/math");
export const result: number = add(1, 2) + (legacy ? 0 : 1);
export { lazy };
