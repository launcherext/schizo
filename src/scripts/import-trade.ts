/**
 * One-time script to import historical trade into database
 * Run with: npx tsx src/scripts/import-trade.ts
 */

import { createDatabase } from '../db/index.js';
import { createDatabaseWithRepositories } from '../db/database-with-repos.js';
import type { Trade } from '../db/repositories/trades.js';

const dbPath = process.env.RAILWAY_ENVIRONMENT
  ? '/app/data/schizo-agent.db'
  : 'schizo-agent.db';

console.log('Opening database:', dbPath);
const db = createDatabase(dbPath);
const dbWithRepos = createDatabaseWithRepositories(db);

// Trade from Helius transaction history
const trade = {
  signature: 'iwgr8DTfM7STpQ1N21mHNRvC4DNrN5ms7aSAKYw27PukjTq9dmA95j4NY6x1gh5MwZWaeQJEH5tHWRg6Wryc6uq',
  tokenMint: 'Kvqx8QeAXyjQJULbAX7LnWxfym5U51we9Eft51oBAGS',
  tokenSymbol: 'IMPOSTOR',
  type: 'BUY' as const,
  amountSol: 0.026412,
  amountTokens: 107358.911004,
  pricePerToken: 0.000000246014,
  timestamp: 1769028771000, // Convert to milliseconds
  metadata: {
    tokenName: 'Impostor',
    source: 'PUMP_FUN',
    importedFromHistory: true,
  },
};

// Check if trade already exists
const existing = dbWithRepos.trades.getRecent(100);
const exists = existing.some((t: Trade) => t.signature === trade.signature);

if (exists) {
  console.log('Trade already exists in database, skipping');
} else {
  console.log('Importing trade:', {
    symbol: trade.tokenSymbol,
    type: trade.type,
    amountSol: trade.amountSol,
    amountTokens: trade.amountTokens,
  });

  dbWithRepos.trades.insert(trade);
  console.log('✅ Trade imported successfully!');
}

// Verify
const positions = dbWithRepos.trades.getRecent(10);
console.log('\nRecent trades in database:');
for (const p of positions) {
  console.log(`  ${p.tokenSymbol || p.tokenMint.slice(0, 8)} - ${p.type} - ${p.amountSol} SOL`);
}

db.close();
