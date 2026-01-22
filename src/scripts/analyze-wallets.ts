
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { config } from '../config/settings';

// === CONFIGURATION ===
const LOOKBACK_TX_LIMIT = 100; 
const RATE_LIMIT_DELAY = 1500; // Slower to be safe
const MIN_SOL_VOLUME = 0.1;

// === USER SCORING WEIGHTS ===
const SCORING = {
  WIN_RATE_WEIGHT: 0.25,
  ROI_WEIGHT: 0.30,
  CONSISTENCY_WEIGHT: 0.20,
  EARLY_ENTRY_WEIGHT: 0.15,
  TRADE_COUNT_WEIGHT: 0.10
};

interface Trade {
  mint: string;
  type: 'buy' | 'sell';
  amountSol: number;
  amountTokens: number;
  timestamp: number;
  signature: string;
}

interface WalletAnalysis {
  address: string;
  totalPnL: number;
  totalSolSpent: number;
  winRate: number;
  roi: number;
  totalTrades: number;
  profitableTokens: number;
  tokensTraded: number;
  avgHoldTime: number; // Seconds
  walletAgeDays: number;
  compositeScore: number;
  verdict: 'KEEP' | 'DISCARD';
  tier: 'High' | 'Medium' | 'Low';
  flags: string[];
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function analyzeWallets() {
  console.log('🕵️  Starting Advanced Wallet Analysis (Composite Scorer)...');

  // 1. Read wallets from wallet.md
  const walletFile = path.join(process.cwd(), 'wallet.md');
  if (!fs.existsSync(walletFile)) {
    console.error('❌ wallet.md not found!');
    process.exit(1);
  }

  const content = fs.readFileSync(walletFile, 'utf-8');
  const wallets = content
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(l));

  if (wallets.length === 0) {
    console.error('❌ No valid wallets found in wallet.md');
    process.exit(1);
  }

  console.log(`📋 Analyzing ${wallets.length} wallets against Composite Score...`);

  const connection = new Connection(config.solanaRpcUrl || `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`);
  const results: WalletAnalysis[] = [];

  // 2. Process each wallet
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    process.stdout.write(`\r[${i + 1}/${wallets.length}] Analyzing ${wallet.substring(0, 6)}... `);

    try {
      const stats = await processWallet(connection, wallet);
      results.push(stats);
      await sleep(RATE_LIMIT_DELAY); 
    } catch (error) {
      console.error(`\n❌ Error analyzing ${wallet}:`, error);
    }
  }

  console.log('\n\n=== 📊 ANALYSIS RESULTS (Ranked by Score) ===');
  
  // Sort by Score
  results.sort((a, b) => b.compositeScore - a.compositeScore);

  console.table(results.map(r => ({
    Address: r.address.substring(0, 8) + '...',
    'Score': r.compositeScore.toFixed(0),
    'Verdict': r.verdict,
    'Win Rate': (r.winRate * 100).toFixed(0) + '%',
    'ROI': (r.roi * 100).toFixed(0) + '%',
    'PnL (SOL)': r.totalPnL.toFixed(1),
    'Tokens': `${r.profitableTokens}/${r.tokensTraded}`,
    'Flags': r.flags.join(', ')
  })));

  // Recommendation
  const keepers = results.filter(r => r.verdict === 'KEEP').map(r => r.address);
  console.log(`\n✅ Recommended Keepers (${keepers.length}):`);
  if (keepers.length > 0) {
    console.log(keepers.join(','));
  } else {
    console.log('None passed the strict criteria.');
  }

  // Generate Report File
  const reportPath = path.join(process.cwd(), 'analysis_report.md');
  let reportContent = '# 📊 Wallet Analysis Report\n\n';
  reportContent += `**Generated:** ${new Date().toISOString()}\n`;
  reportContent += `**Total Wallets Analyzed:** ${results.length}\n`;
  reportContent += `**Keepers Found:** ${keepers.length}\n\n`;
  
  reportContent += '| Address | Score | Verdict | Win Rate | ROI | PnL | Tokens | Est. Hold Time | Flags |\n';
  reportContent += '|---------|-------|---------|----------|-----|-----|--------|----------------|-------|\n';
  
  results.forEach(r => {
    reportContent += `| \`${r.address}\` | **${r.compositeScore.toFixed(0)}** | ${r.verdict === 'KEEP' ? '✅ KEEP' : 'Xu274 DISCARD'} | ${(r.winRate * 100).toFixed(0)}% | ${(r.roi * 100).toFixed(0)}% | ${r.totalPnL.toFixed(2)} SOL | ${r.profitableTokens}/${r.tokensTraded} | ${r.avgHoldTime.toFixed(0)}s | ${r.flags.join(', ')} |\n`;
  });

  reportContent += '\n## Metric Explanations\n';
  reportContent += '- **Score:** Composite rating (0-100) based on Win Rate, ROI, Consistency, and Profit.\n';
  reportContent += '- **Verdict:** KEEP if Score > 40 per user criteria.\n';
  reportContent += '- **Win Rate:** Percentage of tokens traded that resulted in profit.\n';
  reportContent += '- **ROI:** Total Profit / Total Cost (capped at 300% for scoring).\n';

  fs.writeFileSync(reportPath, reportContent);
  console.log(`\n📄 Detailed report saved to: ${reportPath}`);
}

async function processWallet(connection: Connection, address: string): Promise<WalletAnalysis> {
  const pubkey = new PublicKey(address);
  
  const signatures = await connection.getSignaturesForAddress(pubkey, { limit: LOOKBACK_TX_LIMIT });
  const trades: Trade[] = [];

  let oldestTxTime = Date.now() / 1000;
  let newestTxTime = 0;

  for (const sig of signatures) {
    if (sig.err) continue;
    if (sig.blockTime && sig.blockTime < oldestTxTime) oldestTxTime = sig.blockTime;
    if (sig.blockTime && sig.blockTime > newestTxTime) newestTxTime = sig.blockTime;

    try {
      const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.meta) continue;

      const trade = extractTrade(tx, address);
      if (trade) trades.push(trade);
    } catch { /* ignore */ }
  }

  return calculateMetrics(address, trades, oldestTxTime);
}

function extractTrade(tx: ParsedTransactionWithMeta, walletAddress: string): Trade | null {
  // Simplified trade extraction (reuse from previous, but abbreviated here)
  const meta = tx.meta!;
  const accountKeys = tx.transaction.message.accountKeys;
  const walletIndex = accountKeys.findIndex((k) => k.pubkey.toString() === walletAddress);
  if (walletIndex === -1) return null;

  const solChange = (meta.postBalances[walletIndex] - meta.preBalances[walletIndex]) / 1e9;
  
  // Find token change
  const preToken = meta.preTokenBalances?.filter(t => t.owner === walletAddress) || [];
  const postToken = meta.postTokenBalances?.filter(t => t.owner === walletAddress) || [];
  
  // Find largest token change
  let maxChange = 0; 
  let tradedMint = '';
  let tokenChangeAmount = 0;
  const changes = new Map<string, number>();

  preToken.forEach(t => changes.set(t.mint, -(t.uiTokenAmount.uiAmount || 0)));
  postToken.forEach(t => { const c = changes.get(t.mint)||0; changes.set(t.mint, c + (t.uiTokenAmount.uiAmount||0)); });

  for (const [mint, change] of changes.entries()) {
    if (Math.abs(change) > maxChange) { maxChange = Math.abs(change); tradedMint = mint; tokenChangeAmount = change; }
  }

  if (!tradedMint || Math.abs(solChange) < MIN_SOL_VOLUME) return null;

  if (solChange < 0 && tokenChangeAmount > 0) return { mint: tradedMint, type: 'buy', amountSol: Math.abs(solChange), amountTokens: tokenChangeAmount, timestamp: tx.blockTime||0, signature: tx.transaction.signatures[0] };
  if (solChange > 0 && tokenChangeAmount < 0) return { mint: tradedMint, type: 'sell', amountSol: Math.abs(solChange), amountTokens: Math.abs(tokenChangeAmount), timestamp: tx.blockTime||0, signature: tx.transaction.signatures[0] };
  return null;
}

function calculateMetrics(address: string, trades: Trade[], oldestTxTime: number): WalletAnalysis {
  // 1. Group by token
  const tokens = new Map<string, { bought: number, sold: number, entryTime: number, exitTime: number }>();
  
  trades.forEach(t => {
    if (!tokens.has(t.mint)) tokens.set(t.mint, { bought: 0, sold: 0, entryTime: t.timestamp, exitTime: t.timestamp });
    const stat = tokens.get(t.mint)!;
    if (t.type === 'buy') {
      stat.bought += t.amountSol;
      if (t.timestamp < stat.entryTime) stat.entryTime = t.timestamp;
    } else {
      stat.sold += t.amountSol;
      if (t.timestamp > stat.exitTime) stat.exitTime = t.timestamp;
    }
  });

  // 2. Score Components
  let totalPnL = 0;
  let totalSolSpent = 0;
  let profitableTokens = 0;
  let holdTimes: number[] = [];

  tokens.forEach(stat => {
    if (stat.bought > 0) {
      const pnl = stat.sold - stat.bought;
      totalPnL += pnl;
      totalSolSpent += stat.bought;
      if (pnl > 0) profitableTokens++;
      
      // Est hold time
      if (stat.sold > 0) holdTimes.push(stat.exitTime - stat.entryTime);
    }
  });

  const numTokens = tokens.size;
  const avgHoldTime = holdTimes.length > 0 ? holdTimes.reduce((a,b)=>a+b,0)/holdTimes.length : 0;
  const walletAgeDays = (Date.now()/1000 - oldestTxTime) / 86400;

  // 3. Normalized Scores
  const winRate = numTokens > 0 ? profitableTokens / numTokens : 0;
  const roi = totalSolSpent > 0 ? totalPnL / totalSolSpent : 0;
  
  // ROI Score: Cap at 300% (3.0) -> 30 pts
  const roiScore = Math.min(Math.max(roi, 0), 3.0) * 10; // 0 to 30

  // Win Rate Score: 0-100% -> 0-25 pts
  const winRateScore = winRate * 25;

  // Consistency: >2 profitable tokens -> max 20 pts
  const consistencyScore = Math.min(profitableTokens, 5) * 4; // 5 tokens = 20 pts

  // Trade Count: Capped at 50 -> 10 pts
  const tradeCountScore = Math.min(trades.length, 50) / 5; // 50 txs = 10 pts
  
  // Early Entry (Cannot easily calc historically for all tokens, assuming neutral for analyze phase)
  const earlyEntryScore = 7.5; // Give average

  const compositeScore = winRateScore + roiScore + consistencyScore + tradeCountScore + earlyEntryScore;

  // 4. Flags & Verdict
  const flags: string[] = [];
  if (avgHoldTime < 60 && numTokens > 2) flags.push('MEV/Bot');
  if (walletAgeDays < 7) flags.push('Fresh Wallet');
  if (numTokens < 3) flags.push('Low Sample');

  let verdict: 'KEEP' | 'DISCARD' = 'DISCARD';
  // Keep if Score > 50 AND no critical flags
  if (compositeScore > 50 && avgHoldTime > 60) {
    verdict = 'KEEP';
  }

  return {
    address,
    totalPnL,
    totalSolSpent,
    winRate,
    roi,
    totalTrades: trades.length,
    profitableTokens,
    tokensTraded: numTokens,
    avgHoldTime,
    walletAgeDays,
    compositeScore,
    verdict,
    tier: compositeScore > 80 ? 'High' : (compositeScore > 50 ? 'Medium' : 'Low'),
    flags
  };
}

analyzeWallets();
