import type { NextFunction, Request, Response } from 'express';

/**
 * Handles requests that do not match any route.
 */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

/**
 * Centralized error handler so unexpected failures return clean JSON responses.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status =
    typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
      ? err.status
      : typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number'
        ? err.statusCode
        : undefined;

  if (status !== undefined && status >= 400 && status < 500) {
    const message =
      err instanceof SyntaxError
        ? 'Invalid JSON body'
        : err instanceof Error
          ? err.message
          : 'Bad request';
    res.status(status).json({ error: message });
    return;
  }

  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
