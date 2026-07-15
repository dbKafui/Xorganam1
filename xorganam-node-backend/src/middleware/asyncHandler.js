/**
 * Wraps an async Express handler so a thrown/rejected error is passed to
 * next(err) automatically, instead of needing try/catch in every route.
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}
