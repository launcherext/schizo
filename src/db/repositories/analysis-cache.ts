import Database from 'better-sqlite3';

/**
 * Repository for caching analysis results with TTL expiration.
 * 
 * Supports caching for:
 * - Token safety analysis
 * - Wallet performance analysis
 * - Smart money classification
 * 
 * Uses prepared statements for optimal performance and SQL injection safety.
 * 
 * @example
 * const repo = new AnalysisCacheRepository(db);
 * repo.set('mint-address', 'token_safety', result, 24 * 60 * 60 * 1000);
 * const cached = repo.get<TokenSafetyResult>('mint-address', 'token_safety');
 */
class AnalysisCacheRepository {
  private getStmt: Database.Statement;
  private setStmt: Database.Statement;
  private cleanupStmt: Database.Statement;

  constructor(private db: Database.Database) {
    // Prepared statement for retrieving non-expired cache entries
    this.getStmt = db.prepare(`
      SELECT result FROM analysis_cache
      WHERE address = ? AND analysis_type = ? AND expires_at > ?
    `);

    // Prepared statement for inserting or updating cache entries
    this.setStmt = db.prepare(`
      INSERT OR REPLACE INTO analysis_cache
        (address, analysis_type, result, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    // Prepared statement for cleaning up expired entries
    this.cleanupStmt = db.prepare(`
      DELETE FROM analysis_cache WHERE expires_at < ?
    `);
  }

  /**
   * Get a cached analysis result if it exists and hasn't expired.
   * 
   * @param address - The address (wallet or token mint)
   * @param analysisType - Type of analysis (e.g., 'token_safety', 'wallet_analysis')
   * @returns The cached result or null if not found or expired
   */
  get<T>(address: string, analysisType: string): T | null {
    const row = this.getStmt.get(address, analysisType, Date.now()) as 
      { result: string } | undefined;
    
    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.result) as T;
    } catch (error) {
      // If JSON parsing fails, return null (corrupted cache entry)
      return null;
    }
  }

  /**
   * Store an analysis result in the cache with a TTL.
   * 
   * @param address - The address (wallet or token mint)
   * @param analysisType - Type of analysis
   * @param result - The analysis result to cache
   * @param ttlMs - Time-to-live in milliseconds
   */
  set(address: string, analysisType: string, result: unknown, ttlMs: number): void {
    const expiresAt = Date.now() + ttlMs;
    const createdAt = Date.now();
    
    this.setStmt.run(
      address,
      analysisType,
      JSON.stringify(result),
      expiresAt,
      createdAt
    );
  }

  /**
   * Remove all expired cache entries.
   * 
   * @returns Number of entries removed
   */
  cleanup(): number {
    const result = this.cleanupStmt.run(Date.now());
    return result.changes;
  }
}

export { AnalysisCacheRepository };
