/**
 * Formats an amount of cents.
 * @param {number} cents
 * @returns {string}
 */
function formatMoney(cents) {
  return (cents / 100).toFixed(2);
}

var APP_VERSION = "1.0";

window.notify = function (message) {
  alert(message);
};
