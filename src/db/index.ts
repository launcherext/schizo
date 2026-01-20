/**
 * Database module barrel export.
 *
 * Provides:
 * - createDatabase: Create and configure SQLite database
 * - Database: The better-sqlite3 Database type
 * - TradeRepository, Trade: Trade CRUD operations
 * - StateRepository, PnLSnapshot: Agent state and P&L tracking
 */

export { createDatabase, Database } from './database.js';
export { TradeRepository, Trade } from './repositories/trades.js';
export { StateRepository, PnLSnapshot } from './repositories/state.js';
