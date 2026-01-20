import { logger, createLogger } from './lib/logger.js';

// Create module-specific logger
const log = createLogger('main');

// Log startup
logger.info('Agent starting...');

// Test redaction - privateKey should show as [REDACTED]
logger.info({
  wallet: {
    publicKey: 'ABC123xyz...',
    privateKey: 'THIS_SHOULD_BE_REDACTED'
  }
}, 'Testing secret redaction');

// Also test direct privateKey field
logger.info({
  privateKey: 'ALSO_SHOULD_BE_REDACTED',
  secretKey: 'SECRET_REDACTED_TOO',
  password: 'PASSWORD_HIDDEN',
  normalField: 'this is visible'
}, 'Direct field redaction test');

// Log completion
log.info('Agent initialized');

logger.info('Startup complete - all systems ready');
