import { Pool } from 'pg';
import { createChildLogger } from '../utils/logger';

const logger = createChildLogger('db-schema');

export const createTables = async (pool: Pool): Promise<void> => {
  logger.info('Creating database tables...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      mint VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255),
      symbol VARCHAR(32),
      decimals INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      creator VARCHAR(64),
      mint_revoked BOOLEAN DEFAULT FALSE,
      freeze_revoked BOOLEAN DEFAULT FALSE,
      image_url VARCHAR(512),
      last_updated TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id SERIAL PRIMARY KEY,
      mint VARCHAR(64) NOT NULL,
      price_sol DECIMAL(20, 10),
      price_usd DECIMAL(20, 10),
      volume_24h DECIMAL(20, 2),
      market_cap_sol DECIMAL(20, 2),
      liquidity DECIMAL(20, 2),
      timestamp TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (mint) REFERENCES tokens(mint) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_price_history_mint_time
      ON price_history(mint, timestamp DESC);

    CREATE TABLE IF NOT EXISTS trades (
      id VARCHAR(64) PRIMARY KEY,
      mint VARCHAR(64) NOT NULL,
      symbol VARCHAR(32),
      action INTEGER NOT NULL,
      entry_price DECIMAL(20, 10) NOT NULL,
      exit_price DECIMAL(20, 10),
      amount DECIMAL(20, 10) NOT NULL,
      amount_sol DECIMAL(20, 10) NOT NULL,
      entry_time TIMESTAMP NOT NULL,
      exit_time TIMESTAMP,
      pnl_sol DECIMAL(20, 10),
      pnl_percent DECIMAL(10, 4),
      duration_ms BIGINT,
      features_json TEXT,
      regime INTEGER,
      pump_phase VARCHAR(20),
      exit_reason VARCHAR(32),
      slippage DECIMAL(10, 6),
      fees DECIMAL(20, 10)
    );

    CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
    CREATE INDEX IF NOT EXISTS idx_trades_entry_time ON trades(entry_time DESC);

    CREATE TABLE IF NOT EXISTS positions (
      id VARCHAR(64) PRIMARY KEY,
      mint VARCHAR(64) NOT NULL,
      symbol VARCHAR(32),
      entry_price DECIMAL(20, 10) NOT NULL,
      current_price DECIMAL(20, 10) NOT NULL,
      amount DECIMAL(20, 10) NOT NULL,
      amount_sol DECIMAL(20, 10) NOT NULL,
      entry_time TIMESTAMP NOT NULL,
      last_update TIMESTAMP DEFAULT NOW(),
      highest_price DECIMAL(20, 10) NOT NULL,
      lowest_price DECIMAL(20, 10) NOT NULL,
      stop_loss DECIMAL(20, 10) NOT NULL,
      take_profit_json TEXT,
      tp_sold_json TEXT,
      trailing_stop DECIMAL(20, 10),
      status VARCHAR(16) DEFAULT 'open',
      pool_type VARCHAR(16) DEFAULT 'active'
    );

    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

    CREATE TABLE IF NOT EXISTS model_weights (
      id SERIAL PRIMARY KEY,
      version INTEGER NOT NULL,
      weights_json TEXT NOT NULL,
      metrics_json TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS config (
      key VARCHAR(64) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS whale_wallets (
      address VARCHAR(64) PRIMARY KEY,
      label VARCHAR(255),
      total_volume DECIMAL(20, 2) DEFAULT 0,
      win_rate DECIMAL(5, 4) DEFAULT 0,
      last_active TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS whale_activity (
      id SERIAL PRIMARY KEY,
      wallet VARCHAR(64) NOT NULL,
      action VARCHAR(16) NOT NULL,
      mint VARCHAR(64) NOT NULL,
      amount DECIMAL(20, 10) NOT NULL,
      amount_sol DECIMAL(20, 10) NOT NULL,
      signature VARCHAR(128),
      timestamp TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (wallet) REFERENCES whale_wallets(address) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_whale_activity_time
      ON whale_activity(timestamp DESC);

    CREATE TABLE IF NOT EXISTS daily_stats (
      date DATE PRIMARY KEY,
      starting_equity DECIMAL(20, 10),
      ending_equity DECIMAL(20, 10),
      pnl DECIMAL(20, 10),
      pnl_percent DECIMAL(10, 4),
      trades_count INTEGER DEFAULT 0,
      winning_trades INTEGER DEFAULT 0,
      losing_trades INTEGER DEFAULT 0,
      max_drawdown DECIMAL(10, 4),
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Equity snapshots for historical chart
    CREATE TABLE IF NOT EXISTS equity_snapshots (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT NOW(),
      wallet_balance_sol DECIMAL(20, 10),
      positions_value_sol DECIMAL(20, 10),
      total_equity_sol DECIMAL(20, 10),
      unrealized_pnl_sol DECIMAL(20, 10),
      position_count INTEGER,
      source VARCHAR(16)
    );

    CREATE INDEX IF NOT EXISTS idx_equity_snapshots_time
      ON equity_snapshots(timestamp DESC);

    -- Partial close records for accurate PnL tracking
    CREATE TABLE IF NOT EXISTS partial_closes (
      id SERIAL PRIMARY KEY,
      position_id VARCHAR(64),
      mint VARCHAR(64),
      close_type VARCHAR(32),
      sell_amount_tokens DECIMAL(20, 10),
      sell_amount_sol DECIMAL(20, 10),
      price_at_close DECIMAL(20, 10),
      pnl_sol DECIMAL(20, 10),
      fees_sol DECIMAL(20, 10),
      timestamp TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_partial_closes_position
      ON partial_closes(position_id);

    -- Wallet sync audit log
    CREATE TABLE IF NOT EXISTS wallet_sync_log (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT NOW(),
      sol_balance DECIMAL(20, 10),
      token_positions_json TEXT,
      discrepancies_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_sync_time
      ON wallet_sync_log(timestamp DESC);

    -- C100 claim tracking
    CREATE TABLE IF NOT EXISTS c100_claims (
      id SERIAL PRIMARY KEY,
      source VARCHAR(32) NOT NULL,
      amount_sol DECIMAL(20, 10) NOT NULL,
      signature VARCHAR(128),
      status VARCHAR(16) DEFAULT 'success',
      timestamp TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_c100_claims_time
      ON c100_claims(timestamp DESC);

    -- C100 buyback tracking
    CREATE TABLE IF NOT EXISTS c100_buybacks (
      id SERIAL PRIMARY KEY,
      amount_sol DECIMAL(20, 10) NOT NULL,
      amount_tokens DECIMAL(20, 10),
      price_sol DECIMAL(20, 15),
      source VARCHAR(32) NOT NULL,
      signature VARCHAR(128),
      status VARCHAR(16) DEFAULT 'success',
      timestamp TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_c100_buybacks_time
      ON c100_buybacks(timestamp DESC);
  `);

  // Migration: Add image_url column if it doesn't exist
  await pool.query(`
    ALTER TABLE tokens ADD COLUMN IF NOT EXISTS image_url VARCHAR(512);
  `).catch(() => {
    // Column already exists or table doesn't exist yet
  });

  logger.info('Database tables created successfully');
};

export const dropTables = async (pool: Pool): Promise<void> => {
  logger.warn('Dropping all tables...');
  await pool.query(`
    DROP TABLE IF EXISTS wallet_sync_log CASCADE;
    DROP TABLE IF EXISTS partial_closes CASCADE;
    DROP TABLE IF EXISTS equity_snapshots CASCADE;
    DROP TABLE IF EXISTS whale_activity CASCADE;
    DROP TABLE IF EXISTS whale_wallets CASCADE;
    DROP TABLE IF EXISTS price_history CASCADE;
    DROP TABLE IF EXISTS trades CASCADE;
    DROP TABLE IF EXISTS positions CASCADE;
    DROP TABLE IF EXISTS model_weights CASCADE;
    DROP TABLE IF EXISTS config CASCADE;
    DROP TABLE IF EXISTS daily_stats CASCADE;
    DROP TABLE IF EXISTS tokens CASCADE;
  `);
  logger.info('All tables dropped');
};
