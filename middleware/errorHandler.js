// Express error middleware — catches unhandled errors thrown by route
// handlers (when they call next(err) or throw from an async wrapper).
// Logs the full stack server-side; returns a sanitized message to the client.
//
// In development, the original error message is returned so devs can debug.
// In production, only generic phrasing is returned to avoid leaking
// internals (DB schema, query fragments, etc.).

function errorHandler(err, req, res, next) {
  // If the response was already started, defer to Express default handler.
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  // Always log server-side with context.
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${status}`);
  console.error(err.stack || err);

  res.status(status).json({
    error: isProduction && status >= 500
      ? 'Something went wrong. Please try again.'
      : err.message || 'Internal server error',
  });
}

// 404 fallback for unmatched API routes.
function notFoundHandler(req, res) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
}

module.exports = { errorHandler, notFoundHandler };
