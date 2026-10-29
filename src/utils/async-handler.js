/**
 * Envolve handlers async para que rejeições caiam no middleware de erro
 * em vez de virarem unhandled rejection silenciosa.
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
