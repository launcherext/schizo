/**
 * Database interface with repositories
 */

import type { Database } from './database.js';
import { TradeRepository } from './repositories/trades.js';
import { StateRepository } from './repositories/state.js';
import { AnalysisCacheRepository } from './repositories/analysis-cache.js';

/**
 * Database instance with attached repositories
 */
export interface DatabaseWithRepositories extends Database.Database {
  trades: TradeRepository;
  state: StateRepository;
  analysisCache: AnalysisCacheRepository;
}

/**
 * Create database instance with repositories attached
 */
export function createDatabaseWithRepositories(db: Database.Database): DatabaseWithRepositories {
  const dbWithRepos = db as DatabaseWithRepositories;
  dbWithRepos.trades = new TradeRepository(db);
  dbWithRepos.state = new StateRepository(db);
  dbWithRepos.analysisCache = new AnalysisCacheRepository(db);

  return dbWithRepos;
}
