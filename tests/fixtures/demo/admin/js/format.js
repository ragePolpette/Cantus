/**
 * Formats cents as a price label.
 * @param {number} cents
 * @returns {string}
 */
function formatCents(cents) {
  return (cents / 100).toFixed(2) + " EUR";
}
