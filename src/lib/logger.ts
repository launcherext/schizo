import pino from 'pino';

/**
 * Pino logger configured with secret redaction and pretty-printing in development.
 *
 * Redacts: privateKey, secretKey, password, masterPassword, apiKey
 * and their nested variants (*.privateKey, *.secretKey, etc.)
 */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',

  // Redact sensitive fields - NEVER log private keys or passwords
  redact: {
    paths: [
      'privateKey',
      'secretKey',
      'password',
      'masterPassword',
      'apiKey',
      '*.privateKey',
      '*.secretKey',
      '*.password',
      '*.masterPassword',
      '*.apiKey',
      '[*].privateKey',
      '[*].secretKey',
      '[*].password',
      '[*].masterPassword',
      '[*].apiKey'
    ],
    censor: '[REDACTED]'
  },

  // Pretty print in development, JSON in production
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty' }
    : undefined
});

/**
 * Create a child logger with module context.
 *
 * @param module - The module name for log context
 * @returns A pino logger instance with the module context
 *
 * @example
 * const log = createLogger('trades');
 * log.info({ amount: 100 }, 'Trade executed');
 * // Output includes: { module: 'trades', ... }
 */
function createLogger(module: string): pino.Logger {
  return logger.child({ module });
}

export { logger, createLogger };
