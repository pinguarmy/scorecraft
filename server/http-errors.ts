import type { ErrorRequestHandler } from 'express';
import multer from 'multer';

/**
 * An error whose HTTP status is decided where it is thrown. The error handler sends `status` and the
 * (sanitised) message, so the status never has to be inferred from the wording of the message.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Error text that is safe to show to the client: no control characters, bounded length. */
export function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '识别失败。';
  return message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 3000);
}

export function createErrorHandler(options: { maxUploadBytes: number }): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ message: `文件超过上限 ${Math.round(options.maxUploadBytes / 1024 / 1024)} MB。` });
      return;
    }
    let status = 500;
    if (error instanceof multer.MulterError) status = 400;
    else if (error instanceof HttpError) status = error.status;
    res.status(status).json({ message: safeMessage(error) });
  };
}
