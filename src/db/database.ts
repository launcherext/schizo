import Database from 'better-sqlite3';
import { createLogger } from '../lib/logger.js';
import { initializeSchema } from './schema.js';

const log = createLogger('database');

/**
 * Create and configure a SQLite database instance.
 *
 * Features:
 * - WAL mode enabled for better concurrent performance
 * - Foreign keys enforced
 * - Schema automatically initialized
 *
 * @param filepath - Path to the database file
 * @returns Configured database instance
 *
 * @example
 * const db = createDatabase('agent.db');
 * // Database is ready to use with all tables created
 */
function createDatabase(filepath: string): Database.Database {
  const db = new Database(filepath);

  // Enable WAL mode for better concurrent read/write performance
  db.pragma('journal_mode = WAL');

  // Enable foreign key constraints
  db.pragma('foreign_keys = ON');

  // Initialize schema (creates tables if they don't exist)
  initializeSchema(db);

  log.info({ filepath }, 'Database opened (WAL mode)');

  return db;
}

export { createDatabase, Database };
