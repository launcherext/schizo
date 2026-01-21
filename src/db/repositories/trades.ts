import Database from 'better-sqlite3';

/**
 * Trade record representing a completed trade.
 */
interface Trade {
  signature: string;
  timestamp: number;
  type: 'BUY' | 'SELL';
  tokenMint: string;
  tokenSymbol?: string;
  amountTokens: number;
  amountSol: number;
  pricePerToken: number;
  feeSol?: number;
  status?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Repository for trade CRUD operations.
 * Uses prepared statements for optimal performance.
 *
 * @example
 * const repo = new TradeRepository(db);
 * repo.insert({ signature: 'abc', ... });
 * const trade = repo.getBySignature('abc');
 */
class TradeRepository {
  private insertStmt: Database.Statement;
  private getBySignatureStmt: Database.Statement;
  private getRecentStmt: Database.Statement;
  private getByTokenStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO trades
        (signature, timestamp, type, token_mint, token_symbol,
         amount_tokens, amount_sol, price_per_token, fee_sol, status, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getBySignatureStmt = db.prepare(
      'SELECT * FROM trades WHERE signature = ?'
    );

    this.getRecentStmt = db.prepare(
      'SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?'
    );

    this.getByTokenStmt = db.prepare(
      'SELECT * FROM trades WHERE token_mint = ? ORDER BY timestamp DESC'
    );
  }

  /**
   * Insert a new trade record.
   *
   * @param trade - The trade to insert
   * @throws If a trade with the same signature already exists
   */
  insert(trade: Trade): void {
    this.insertStmt.run(
      trade.signature,
      trade.timestamp,
      trade.type,
      trade.tokenMint,
      trade.tokenSymbol ?? null,
      trade.amountTokens,
      trade.amountSol,
      trade.pricePerToken,
      trade.feeSol ?? 0,
      trade.status ?? 'CONFIRMED',
      trade.metadata ? JSON.stringify(trade.metadata) : null
    );
  }

  /**
   * Get a trade by its transaction signature.
   *
   * @param signature - The Solana transaction signature
   * @returns The trade if found, undefined otherwise
   */
  getBySignature(signature: string): Trade | undefined {
    const row = this.getBySignatureStmt.get(signature) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /**
   * Get recent trades ordered by timestamp (newest first).
   *
   * @param limit - Maximum number of trades to return (default 100)
   * @returns Array of trades
   */
  getRecent(limit: number = 100): Trade[] {
    const rows = this.getRecentStmt.all(limit) as Record<string, unknown>[];
    return rows.map(row => this.mapRow(row));
  }

  /**
   * Get all trades for a specific token.
   *
   * @param tokenMint - The token mint address
   * @returns Array of trades for that token
   */
  getByToken(tokenMint: string): Trade[] {
    const rows = this.getByTokenStmt.all(tokenMint) as Record<string, unknown>[];
    return rows.map(row => this.mapRow(row));
  }

  /**
   * Clear all sync trades (auto-generated position recovery records).
   * Call this on startup to clear stale position data.
   * @returns Number of trades deleted
   */
  clearSyncTrades(): number {
    const result = this.db.prepare("DELETE FROM trades WHERE signature LIKE 'sync-%'").run();
    return result.changes;
  }

  /**
   * Map a database row to a Trade object.
   */
  private mapRow(row: Record<string, unknown>): Trade {
    return {
      signature: row.signature as string,
      timestamp: row.timestamp as number,
      type: row.type as 'BUY' | 'SELL',
      tokenMint: row.token_mint as string,
      tokenSymbol: row.token_symbol as string | undefined,
      amountTokens: row.amount_tokens as number,
      amountSol: row.amount_sol as number,
      pricePerToken: row.price_per_token as number,
      feeSol: row.fee_sol as number | undefined,
      status: row.status as string | undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined
    };
  }
}

export { TradeRepository, Trade };
