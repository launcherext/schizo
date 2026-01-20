import Database from 'better-sqlite3';

/**
 * P&L snapshot representing portfolio state at a point in time.
 */
interface PnLSnapshot {
  timestamp: number;
  totalValueSol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  tokenHoldings: Record<string, number>;
}

/**
 * Repository for agent state and P&L tracking.
 * Uses prepared statements for optimal performance.
 *
 * @example
 * const repo = new StateRepository(db);
 * repo.setState('last_run', new Date().toISOString());
 * const lastRun = repo.getState('last_run');
 */
class StateRepository {
  private getStateStmt: Database.Statement;
  private setStateStmt: Database.Statement;
  private savePnLStmt: Database.Statement;
  private getLatestPnLStmt: Database.Statement;
  private getPnLHistoryStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.getStateStmt = db.prepare(
      'SELECT value FROM agent_state WHERE key = ?'
    );

    this.setStateStmt = db.prepare(`
      INSERT INTO agent_state (key, value, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = unixepoch()
    `);

    this.savePnLStmt = db.prepare(`
      INSERT INTO pnl_snapshots
        (timestamp, total_value_sol, realized_pnl_sol, unrealized_pnl_sol, token_holdings)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.getLatestPnLStmt = db.prepare(
      'SELECT * FROM pnl_snapshots ORDER BY timestamp DESC LIMIT 1'
    );

    this.getPnLHistoryStmt = db.prepare(
      'SELECT * FROM pnl_snapshots ORDER BY timestamp DESC LIMIT ?'
    );
  }

  /**
   * Get a state value by key.
   *
   * @param key - The state key
   * @returns The value if found, undefined otherwise
   */
  getState(key: string): string | undefined {
    const row = this.getStateStmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  /**
   * Set a state value (insert or update).
   *
   * @param key - The state key
   * @param value - The value to store
   */
  setState(key: string, value: string): void {
    this.setStateStmt.run(key, value);
  }

  /**
   * Save a P&L snapshot.
   *
   * @param snapshot - The snapshot to save
   */
  savePnLSnapshot(snapshot: PnLSnapshot): void {
    this.savePnLStmt.run(
      snapshot.timestamp,
      snapshot.totalValueSol,
      snapshot.realizedPnlSol,
      snapshot.unrealizedPnlSol,
      JSON.stringify(snapshot.tokenHoldings)
    );
  }

  /**
   * Get the most recent P&L snapshot.
   *
   * @returns The latest snapshot if any exist, undefined otherwise
   */
  getLatestPnLSnapshot(): PnLSnapshot | undefined {
    const row = this.getLatestPnLStmt.get() as Record<string, unknown> | undefined;
    return row ? this.mapPnLRow(row) : undefined;
  }

  /**
   * Get P&L history (most recent first).
   *
   * @param limit - Maximum number of snapshots to return
   * @returns Array of P&L snapshots
   */
  getPnLHistory(limit: number = 100): PnLSnapshot[] {
    const rows = this.getPnLHistoryStmt.all(limit) as Record<string, unknown>[];
    return rows.map(row => this.mapPnLRow(row));
  }

  /**
   * Map a database row to a PnLSnapshot object.
   */
  private mapPnLRow(row: Record<string, unknown>): PnLSnapshot {
    return {
      timestamp: row.timestamp as number,
      totalValueSol: row.total_value_sol as number,
      realizedPnlSol: row.realized_pnl_sol as number,
      unrealizedPnlSol: row.unrealized_pnl_sol as number,
      tokenHoldings: JSON.parse(row.token_holdings as string)
    };
  }
}

export { StateRepository, PnLSnapshot };
