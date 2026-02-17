export class AppError extends Error {
  constructor(message, name = 'AppError', code, statusCode, info = {}) {
    super(message);
    this.name = name;
    this.code = code;
    this.statusCode = statusCode;
    
    // additional context if given
    this.info = info;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
