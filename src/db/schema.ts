import Database from 'better-sqlite3';

/**
 * Initialize database schema with all required tables.
 * Creates tables if they don't exist, adds indexes for query performance.
 *
 * Tables:
 * - config: Key-value configuration storage
 * - trades: Trade history with full details
 * - pnl_snapshots: P&L tracking over time
 * - analysis_cache: Cached wallet/token analysis results
 * - agent_state: Agent runtime state for recovery
 *
 * @param db - The database instance to initialize
 */
function initializeSchema(db: Database.Database): void {
  db.exec(`
    -- Configuration table for key-value settings
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    -- Trades table for complete trade history
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT UNIQUE NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      token_symbol TEXT,
      amount_tokens REAL NOT NULL,
      amount_sol REAL NOT NULL,
      price_per_token REAL NOT NULL,
      fee_sol REAL DEFAULT 0,
      status TEXT DEFAULT 'CONFIRMED',
      metadata TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    -- Indexes for common trade queries
    CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
    CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_mint);

    -- P&L snapshots for tracking portfolio value over time
    CREATE TABLE IF NOT EXISTS pnl_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      total_value_sol REAL NOT NULL,
      realized_pnl_sol REAL NOT NULL,
      unrealized_pnl_sol REAL NOT NULL,
      token_holdings TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );

    -- Index for time-based P&L queries
    CREATE INDEX IF NOT EXISTS idx_pnl_timestamp ON pnl_snapshots(timestamp);

    -- Analysis cache for wallet/token analysis results
    CREATE TABLE IF NOT EXISTS analysis_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      analysis_type TEXT NOT NULL,
      result TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(address, analysis_type)
    );

    -- Index for cache expiry cleanup
    CREATE INDEX IF NOT EXISTS idx_analysis_expires ON analysis_cache(expires_at);

    -- Agent state for recovery after restarts
    CREATE TABLE IF NOT EXISTS agent_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `);
}

export { initializeSchema };
