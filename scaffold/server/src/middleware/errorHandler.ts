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
  if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
