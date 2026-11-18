/** A plain constant oxc declares on several lines; its key shares a name with a function below. */
export const settings = { id: 1, label: "x" };

/**
 * Looks a record up.
 * @param {!Array.<string>} keys
 * @param {Object.<string, number>=} weights
 * @param {function(string, number=): boolean} accept
 * @param {?{ id: number, tags: Array<string> }} [options={}] Lookup options.
 * @param {string} options.mode documented property, not a parameter
 * @param {...*} extra
 * @return {(string|null)}
 */
export function id(keys, weights, accept, options, ...extra) {
  return null;
}
