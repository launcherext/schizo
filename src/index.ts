/**
 * SCHIZO Agent - Entry Point
 *
 * Self-funding AI trading agent with wallet forensics capabilities.
 *
 * Phase 1: Foundation & Security
 * - Encrypted keystore for secure wallet management
 * - SQLite database for trade and state persistence
 * - Rate-limited Helius API client with caching
 *
 * Usage:
 *   npm run dev          - Start the agent
 *   npm run dev -- --test - Run devnet integration test
 */

import { logger, createLogger } from './lib/logger.js';
import { runDevnetTest } from './test-devnet.js';
import { createDatabase } from './db/database.js';

// Module logger
const log = createLogger('main');

// Track database for cleanup
let db: ReturnType<typeof createDatabase> | null = null;

/**
 * Graceful shutdown handler
 */
function handleShutdown(signal: string): void {
  log.info({ signal }, 'Shutting down...');

  // Close database if open
  if (db) {
    try {
      db.close();
      log.info('Database closed');
    } catch (error) {
      log.error({ error: (error as Error).message }, 'Error closing database');
    }
  }

  log.info('Shutdown complete');
  process.exit(0);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  log.info('===========================================');
  log.info('SCHIZO Agent v0.1.0');
  log.info('Phase 1: Foundation & Security');
  log.info('===========================================');

  // Register shutdown handlers
  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  // Check for --test flag
  const isTestMode = process.argv.includes('--test');

  if (isTestMode) {
    log.info('Running devnet integration test...');
    log.info('');
    await runDevnetTest();
  } else {
    log.info('');
    log.info('Ready. Use --test for devnet integration test.');
    log.info('');
    log.info('Phase 1 modules available:');
    log.info('  - Encrypted keystore: src/keystore/');
    log.info('  - SQLite persistence: src/db/');
    log.info('  - Helius API client:  src/api/');
    log.info('');
    log.info('Press Ctrl+C to exit.');

    // Keep process running
    await new Promise(() => {});
  }
}

// Run main with error handling
main().catch((error) => {
  logger.error({ error: (error as Error).message }, 'Fatal error');
  process.exit(1);
});
