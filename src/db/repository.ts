import { Pool } from 'pg';
import { createChildLogger } from '../utils/logger';
import { TokenRecord, TradeRecordDB, PositionRecord, PriceRecord, EquitySnapshotRecord, PartialCloseRecord, WalletSyncLogRecord, C100ClaimRecord, C100BuybackRecord } from './types';
import { config } from '../config/settings';

const logger = createChildLogger('repository');

export class Repository {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected database pool error');
    });
  }

  async connect(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT NOW()');
      logger.info({ time: result.rows[0].now }, 'Database connected');
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    logger.info('Database pool closed');
  }

  // Token operations
  async upsertToken(token: Partial<TokenRecord>): Promise<void> {
    await this.pool.query(`
      INSERT INTO tokens (mint, name, symbol, decimals, creator, mint_revoked, freeze_revoked, image_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (mint) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, tokens.name),
        symbol = COALESCE(EXCLUDED.symbol, tokens.symbol),
        mint_revoked = COALESCE(EXCLUDED.mint_revoked, tokens.mint_revoked),
        freeze_revoked = COALESCE(EXCLUDED.freeze_revoked, tokens.freeze_revoked),
        image_url = COALESCE(EXCLUDED.image_url, tokens.image_url),
        last_updated = NOW()
    `, [token.mint, token.name, token.symbol, token.decimals, token.creator, token.mint_revoked, token.freeze_revoked, token.image_url]);
  }

  async updateTokenMetadata(mint: string, metadata: { name?: string; symbol?: string; image_url?: string }): Promise<void> {
    const updates: string[] = [];
    const values: any[] = [mint];
    let paramIndex = 2;

    if (metadata.name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(metadata.name);
    }
    if (metadata.symbol) {
      updates.push(`symbol = $${paramIndex++}`);
      values.push(metadata.symbol);
    }
    if (metadata.image_url) {
      updates.push(`image_url = $${paramIndex++}`);
      values.push(metadata.image_url);
    }

    if (updates.length > 0) {
      updates.push('last_updated = NOW()');
      await this.pool.query(
        `UPDATE tokens SET ${updates.join(', ')} WHERE mint = $1`,
        values
      );
    }
  }

  async getToken(mint: string): Promise<TokenRecord | null> {
    const result = await this.pool.query('SELECT * FROM tokens WHERE mint = $1', [mint]);
    return result.rows[0] || null;
  }

  // Price operations
  async insertPrice(price: Partial<PriceRecord>): Promise<void> {
    await this.pool.query(`
      INSERT INTO price_history (mint, price_sol, price_usd, volume_24h, market_cap_sol, liquidity)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [price.mint, price.price_sol, price.price_usd, price.volume_24h, price.market_cap_sol, price.liquidity]);
  }

  async getRecentPrices(mint: string, limit: number = 100): Promise<PriceRecord[]> {
    const result = await this.pool.query(`
      SELECT * FROM price_history
      WHERE mint = $1
      ORDER BY timestamp DESC
      LIMIT $2
    `, [mint, limit]);
    return result.rows;
  }

  // Trade operations
  async insertTrade(trade: Partial<TradeRecordDB>): Promise<void> {
    await this.pool.query(`
      INSERT INTO trades (id, mint, symbol, action, entry_price, amount, amount_sol,
                          entry_time, features_json, regime, pump_phase)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      trade.id, trade.mint, trade.symbol, trade.action, trade.entry_price,
      trade.amount, trade.amount_sol, trade.entry_time, trade.features_json,
      trade.regime, trade.pump_phase
    ]);
  }

  async updateTradeExit(id: string, exitData: {
    exit_price: number;
    exit_time: Date;
    pnl_sol: number;
    pnl_percent: number;
    duration_ms: number;
    exit_reason: string;
    slippage?: number;
    fees?: number;
  }): Promise<void> {
    await this.pool.query(`
      UPDATE trades SET
        exit_price = $2,
        exit_time = $3,
        pnl_sol = $4,
        pnl_percent = $5,
        duration_ms = $6,
        exit_reason = $7,
        slippage = $8,
        fees = $9
      WHERE id = $1
    `, [
      id, exitData.exit_price, exitData.exit_time, exitData.pnl_sol,
      exitData.pnl_percent, exitData.duration_ms, exitData.exit_reason,
      exitData.slippage, exitData.fees
    ]);
  }

  async getRecentTrades(limit: number = 100): Promise<TradeRecordDB[]> {
    const result = await this.pool.query(`
      SELECT * FROM trades ORDER BY entry_time DESC LIMIT $1
    `, [limit]);
    return result.rows;
  }

  async getTradesForTraining(weeks: number = 4): Promise<TradeRecordDB[]> {
    const result = await this.pool.query(`
      SELECT * FROM trades
      WHERE exit_time IS NOT NULL
        AND entry_time > NOW() - INTERVAL '${weeks} weeks'
      ORDER BY entry_time ASC
    `);
    return result.rows;
  }

  // Position operations
  async upsertPosition(position: Partial<PositionRecord>): Promise<void> {
    await this.pool.query(`
      INSERT INTO positions (id, mint, symbol, entry_price, current_price, amount,
                            amount_sol, entry_time, highest_price, lowest_price,
                            stop_loss, take_profit_json, tp_sold_json, status, pool_type,
                            initial_recovered, scaled_exits_taken, initial_investment, realized_pnl,
                            trailing_stop)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      ON CONFLICT (id) DO UPDATE SET
        current_price = EXCLUDED.current_price,
        highest_price = GREATEST(positions.highest_price, EXCLUDED.current_price),
        lowest_price = LEAST(positions.lowest_price, EXCLUDED.current_price),
        tp_sold_json = EXCLUDED.tp_sold_json,
        status = EXCLUDED.status,
        initial_recovered = EXCLUDED.initial_recovered,
        scaled_exits_taken = EXCLUDED.scaled_exits_taken,
        realized_pnl = EXCLUDED.realized_pnl,
        trailing_stop = COALESCE(EXCLUDED.trailing_stop, positions.trailing_stop),
        last_update = NOW()
    `, [
      position.id, position.mint, position.symbol, position.entry_price,
      position.current_price, position.amount, position.amount_sol,
      position.entry_time, position.highest_price, position.lowest_price,
      position.stop_loss, position.take_profit_json, position.tp_sold_json,
      position.status, position.pool_type,
      position.initial_recovered, position.scaled_exits_taken,
      position.initial_investment, position.realized_pnl,
      position.trailing_stop
    ]);
  }

  async getOpenPositions(): Promise<PositionRecord[]> {
    const result = await this.pool.query(`
      SELECT * FROM positions WHERE status = 'open' ORDER BY entry_time ASC
    `);
    return result.rows;
  }

  async closePosition(id: string): Promise<void> {
    await this.pool.query(`
      UPDATE positions SET status = 'closed', last_update = NOW() WHERE id = $1
    `, [id]);
  }

  // Config operations
  async getConfig(key: string): Promise<string | null> {
    const result = await this.pool.query('SELECT value FROM config WHERE key = $1', [key]);
    return result.rows[0]?.value || null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO config (key, value) VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, value]);
  }

  // Model operations
  async saveModelWeights(version: number, weights: string, metrics: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO model_weights (version, weights_json, metrics_json)
      VALUES ($1, $2, $3)
    `, [version, weights, metrics]);
  }

  async getLatestModelWeights(): Promise<{ weights: string; metrics: string; version: number } | null> {
    const result = await this.pool.query(`
      SELECT weights_json, metrics_json, version
      FROM model_weights
      ORDER BY version DESC
      LIMIT 1
    `);
    if (!result.rows[0]) return null;
    return {
      weights: result.rows[0].weights_json,
      metrics: result.rows[0].metrics_json,
      version: result.rows[0].version,
    };
  }

  // Daily stats operations
  async updateDailyStats(date: Date, stats: {
    starting_equity?: number;
    ending_equity?: number;
    pnl?: number;
    trades_count?: number;
    winning_trades?: number;
    losing_trades?: number;
    max_drawdown?: number;
  }): Promise<void> {
    const dateStr = date.toISOString().split('T')[0];
    await this.pool.query(`
      INSERT INTO daily_stats (date, starting_equity, ending_equity, pnl, trades_count,
                               winning_trades, losing_trades, max_drawdown)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (date) DO UPDATE SET
        ending_equity = COALESCE(EXCLUDED.ending_equity, daily_stats.ending_equity),
        pnl = COALESCE(EXCLUDED.pnl, daily_stats.pnl),
        trades_count = COALESCE(EXCLUDED.trades_count, daily_stats.trades_count),
        winning_trades = COALESCE(EXCLUDED.winning_trades, daily_stats.winning_trades),
        losing_trades = COALESCE(EXCLUDED.losing_trades, daily_stats.losing_trades),
        max_drawdown = GREATEST(daily_stats.max_drawdown, COALESCE(EXCLUDED.max_drawdown, 0))
    `, [dateStr, stats.starting_equity, stats.ending_equity, stats.pnl,
        stats.trades_count, stats.winning_trades, stats.losing_trades, stats.max_drawdown]);
  }

  // Whale tracking
  async upsertWhaleWallet(address: string, label?: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO whale_wallets (address, label)
      VALUES ($1, $2)
      ON CONFLICT (address) DO UPDATE SET
        label = COALESCE(EXCLUDED.label, whale_wallets.label)
    `, [address, label]);
  }

  async logWhaleActivity(activity: {
    wallet: string;
    action: string;
    mint: string;
    amount: number;
    amount_sol: number;
    signature?: string;
  }): Promise<void> {
    await this.pool.query(`
      INSERT INTO whale_activity (wallet, action, mint, amount, amount_sol, signature)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [activity.wallet, activity.action, activity.mint, activity.amount,
        activity.amount_sol, activity.signature]);

    await this.pool.query(`
      UPDATE whale_wallets SET
        total_volume = total_volume + $2,
        last_active = NOW()
      WHERE address = $1
    `, [activity.wallet, activity.amount_sol]);
  }

  // Equity snapshot operations
  async insertEquitySnapshot(snapshot: {
    wallet_balance_sol: number;
    positions_value_sol: number;
    total_equity_sol: number;
    unrealized_pnl_sol: number;
    position_count: number;
    source: 'periodic' | 'trade_close' | 'startup';
  }): Promise<void> {
    await this.pool.query(`
      INSERT INTO equity_snapshots (wallet_balance_sol, positions_value_sol, total_equity_sol,
                                   unrealized_pnl_sol, position_count, source)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      snapshot.wallet_balance_sol, snapshot.positions_value_sol, snapshot.total_equity_sol,
      snapshot.unrealized_pnl_sol, snapshot.position_count, snapshot.source
    ]);
  }

  async getEquityHistory(hours: number = 24): Promise<EquitySnapshotRecord[]> {
    const result = await this.pool.query(`
      SELECT * FROM equity_snapshots
      WHERE timestamp > NOW() - INTERVAL '${hours} hours'
      ORDER BY timestamp ASC
    `);
    return result.rows;
  }

  async getLatestEquitySnapshot(): Promise<EquitySnapshotRecord | null> {
    const result = await this.pool.query(`
      SELECT * FROM equity_snapshots
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    return result.rows[0] || null;
  }

  // Partial close operations
  async insertPartialClose(partialClose: {
    position_id: string;
    mint: string;
    close_type: 'initial_recovery' | 'scaled_exit' | 'tp_level';
    sell_amount_tokens: number;
    sell_amount_sol: number;
    price_at_close: number;
    pnl_sol: number;
    fees_sol: number;
  }): Promise<void> {
    await this.pool.query(`
      INSERT INTO partial_closes (position_id, mint, close_type, sell_amount_tokens,
                                 sell_amount_sol, price_at_close, pnl_sol, fees_sol)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      partialClose.position_id, partialClose.mint, partialClose.close_type,
      partialClose.sell_amount_tokens, partialClose.sell_amount_sol,
      partialClose.price_at_close, partialClose.pnl_sol, partialClose.fees_sol
    ]);
  }

  async getPartialCloses(positionId: string): Promise<PartialCloseRecord[]> {
    const result = await this.pool.query(`
      SELECT * FROM partial_closes
      WHERE position_id = $1
      ORDER BY timestamp ASC
    `, [positionId]);
    return result.rows;
  }

  async getTotalPartialClosePnl(positionId: string): Promise<number> {
    const result = await this.pool.query(`
      SELECT COALESCE(SUM(pnl_sol), 0) as total_pnl
      FROM partial_closes
      WHERE position_id = $1
    `, [positionId]);
    return parseFloat(result.rows[0]?.total_pnl || '0');
  }

  // Wallet sync log operations
  async insertWalletSyncLog(log: {
    sol_balance: number;
    token_positions_json: string;
    discrepancies_json: string;
  }): Promise<void> {
    await this.pool.query(`
      INSERT INTO wallet_sync_log (sol_balance, token_positions_json, discrepancies_json)
      VALUES ($1, $2, $3)
    `, [log.sol_balance, log.token_positions_json, log.discrepancies_json]);
  }

  async getLatestWalletSync(): Promise<WalletSyncLogRecord | null> {
    const result = await this.pool.query(`
      SELECT * FROM wallet_sync_log
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    return result.rows[0] || null;
  }

  // Delete phantom position
  async deletePosition(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM positions WHERE id = $1`, [id]);
  }

  // Update position amount after partial close
  async updatePositionAmount(id: string, newAmount: number): Promise<void> {
    await this.pool.query(`
      UPDATE positions SET amount = $2, last_update = NOW() WHERE id = $1
    `, [id, newAmount]);
  }

  // C100 Claim operations
  async insertC100Claim(claim: {
    source: string;
    amount_sol: number;
    signature?: string;
    status?: string;
  }): Promise<void> {
    await this.pool.query(`
      INSERT INTO c100_claims (source, amount_sol, signature, status)
      VALUES ($1, $2, $3, $4)
    `, [claim.source, claim.amount_sol, claim.signature || null, claim.status || 'success']);
  }

  async getRecentC100Claims(limit: number = 50): Promise<C100ClaimRecord[]> {
    const result = await this.pool.query(`
      SELECT * FROM c100_claims
      ORDER BY timestamp DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  }

  async getC100ClaimTotals(): Promise<{ total_sol: number; count: number }> {
    const result = await this.pool.query(`
      SELECT COALESCE(SUM(amount_sol), 0) as total_sol, COUNT(*) as count
      FROM c100_claims
      WHERE status = 'success'
    `);
    return {
      total_sol: parseFloat(result.rows[0]?.total_sol || '0'),
      count: parseInt(result.rows[0]?.count || '0'),
    };
  }

  // C100 Buyback operations
  async insertC100Buyback(buyback: {
    amount_sol: number;
    amount_tokens?: number;
    price_sol?: number;
    source: string;
    signature?: string;
    status?: string;
  }): Promise<void> {
    await this.pool.query(`
      INSERT INTO c100_buybacks (amount_sol, amount_tokens, price_sol, source, signature, status)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      buyback.amount_sol,
      buyback.amount_tokens || null,
      buyback.price_sol || null,
      buyback.source,
      buyback.signature || null,
      buyback.status || 'success'
    ]);
  }

  async getRecentC100Buybacks(limit: number = 50): Promise<C100BuybackRecord[]> {
    const result = await this.pool.query(`
      SELECT * FROM c100_buybacks
      ORDER BY timestamp DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  }

  async getC100BuybackTotals(): Promise<{ total_sol: number; total_tokens: number; count: number }> {
    const result = await this.pool.query(`
      SELECT
        COALESCE(SUM(amount_sol), 0) as total_sol,
        COALESCE(SUM(amount_tokens), 0) as total_tokens,
        COUNT(*) as count
      FROM c100_buybacks
      WHERE status = 'success'
    `);
    return {
      total_sol: parseFloat(result.rows[0]?.total_sol || '0'),
      total_tokens: parseFloat(result.rows[0]?.total_tokens || '0'),
      count: parseInt(result.rows[0]?.count || '0'),
    };
  }
}

export const repository = new Repository();
