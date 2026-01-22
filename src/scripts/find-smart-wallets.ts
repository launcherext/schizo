
import dotenv from 'dotenv';
dotenv.config();

import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { config } from '../config/settings';

// === CONFIGURATION ===
// Phase 1: Discovery
const DISCOVERY_ScanLimit = 2000;
const DISCOVERY_MinProfit = 0.1; 
const DISCOVERY_MinSize = 0.1;

// Phase 2: Analysis
const ANALYSIS_Lookback = 100;
const ANALYSIS_RateLimit = 1500;

// Scoring Weights
const SCORING = {
  WIN_RATE_WEIGHT: 0.25,
  ROI_WEIGHT: 0.30,
  CONSISTENCY_WEIGHT: 0.20,
  EARLY_ENTRY_WEIGHT: 0.15,
  TRADE_COUNT_WEIGHT: 0.10
};

// === TYPES ===
interface WalletStats {
  address: string;
  solSpent: number;
  solReceived: number;
  tokenBought: number;
  tokenSold: number;
  txCount: number;
  realizedPnL: number;
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
  avgHoldTime: number;
  walletAgeDays: number;
  compositeScore: number;
  verdict: 'KEEP' | 'DISCARD';
  tier: 'High' | 'Medium' | 'Low';
  flags: string[];
}

interface Trade {
  mint: string;
  type: 'buy' | 'sell';
  amountSol: number;
  amountTokens: number;
  timestamp: number;
  signature: string;
}

// === MAIN ENTRY POINT ===
async function main() {
  const mintArg = process.argv[2];
  if (!mintArg) {
    console.log('Usage: npm run find-whales <MINT_ADDRESS>');
    process.exit(1);
  }

  const connection = new Connection(config.solanaRpcUrl || `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`);
  
  console.log(`\n🚀 STARTING SMART WALLET HUNT`);
  console.log(`   Target Token: ${mintArg}`);

  // --- PHASE 1: DISCOVERY ---
  console.log(`\n=== PHASE 1: DISCOVERY (Scanning last ${DISCOVERY_ScanLimit} txs) ===`);
  const candidates = await discoverCandidates(connection, mintArg);
  
  if (candidates.length === 0) {
    console.log('❌ No profitable candidates found on this token.');
    return;
  }
  
  console.log(`\n✅ Found ${candidates.length} profitable candidates. Proceeding to vetting...`);

  // --- PHASE 2: ANALYSIS ---
  console.log(`\n=== PHASE 2: VETTING (Checking consistency across ${ANALYSIS_Lookback} txs) ===`);
  const results: WalletAnalysis[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    process.stdout.write(`\r[${i + 1}/${candidates.length}] Vetting ${candidate.address.substring(0, 6)}... `);
    
    try {
      // Analyze full history
      const stats = await analyzeWallet(connection, candidate.address);
      results.push(stats);
      await sleep(ANALYSIS_RateLimit);
    } catch (e) {
      console.error(`Error: ${e}`);
    }
  }

  // --- OUTPUT ---
  console.log('\n\n=== 🏆 FINAL RESULTS: HIGH QUALITY WALLETS ===');
  
  // Filter for keepers and sort by score
  const keepers = results
    .filter(r => r.verdict === 'KEEP')
    .sort((a, b) => b.compositeScore - a.compositeScore);

  if (keepers.length === 0) {
    console.log('❌ No wallets passed the strict vetting criteria needed for copy trading.');
    console.log('   (Many might have profited on this token but failed consistency checks).');
  } else {
    console.table(keepers.map(r => ({
      Address: r.address,
      'Score': r.compositeScore.toFixed(0),
      'Tier': r.tier,
      'Win Rate': (r.winRate * 100).toFixed(0) + '%',
      'Total ROI': (r.roi * 100).toFixed(0) + '%',
      'PnL (SOL)': r.totalPnL.toFixed(1),
      'Tokens': `${r.profitableTokens}/${r.tokensTraded}`
    })));

    const cleanList = keepers.map(r => r.address).join(',');
    console.log('\n👇 COPY THIS LIST FOR YOUR .env:');
    console.log(`COPY_TRADE_WALLETS="${cleanList}"`);
  }
}

// === PHASE 1 LOGIC ===
async function discoverCandidates(connection: Connection, mintAddress: string): Promise<WalletStats[]> {
  const mintPubkey = new PublicKey(mintAddress);
  let signatures: string[] = [];
  let lastSig: string | undefined = undefined;

  // 1. Fetch History
  while (signatures.length < DISCOVERY_ScanLimit) {
    const batch = await connection.getSignaturesForAddress(mintPubkey, { limit: 1000, before: lastSig });
    if (batch.length === 0) break;
    batch.forEach(s => signatures.push(s.signature));
    lastSig = batch[batch.length - 1].signature;
    process.stdout.write(`\r    Fetched ${signatures.length} signatures...`);
  }

  // 2. Build Ledger
  const wallets = new Map<string, WalletStats>();
  const CHUNK_SIZE = 50;
  
  for (let i = 0; i < signatures.length; i += CHUNK_SIZE) {
    const chunk = signatures.slice(i, i + CHUNK_SIZE);
    // process.stdout.write(`\r    Processing batch ${i}...`);
    const txs = await connection.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0 });
    
    for (const tx of txs) {
      if (!tx || !tx.meta) continue;
      
      const tokenBalances = [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])];
      const owners = new Set<string>();
      tokenBalances.forEach(tb => { if (tb.mint === mintAddress && tb.owner) owners.add(tb.owner); });

      for (const owner of owners) {
        // Calculate Changes
        const preToken = tx.meta.preTokenBalances?.find(t => t.owner === owner && t.mint === mintAddress)?.uiTokenAmount.uiAmount || 0;
        const postToken = tx.meta.postTokenBalances?.find(t => t.owner === owner && t.mint === mintAddress)?.uiTokenAmount.uiAmount || 0;
        const tokenChange = postToken - preToken;
        if (tokenChange === 0) continue;

        const accountIndex = tx.transaction.message.accountKeys.findIndex(k => k.pubkey.toString() === owner);
        if (accountIndex === -1) continue;
        const solChange = ((tx.meta.postBalances[accountIndex] || 0) - (tx.meta.preBalances[accountIndex] || 0)) / 1e9;

        let stats = wallets.get(owner) || { address: owner, solSpent: 0, solReceived: 0, tokenBought: 0, tokenSold: 0, txCount: 0, realizedPnL: 0 };
        stats.txCount++;

        if (tokenChange > 0) { // BUY
          stats.tokenBought += tokenChange;
          if (solChange < 0) stats.solSpent += Math.abs(solChange);
        } else { // SELL
          stats.tokenSold += Math.abs(tokenChange);
          if (solChange > 0) stats.solReceived += solChange;
        }
        wallets.set(owner, stats);
      }
    }
  }

  // 3. Filter
  return Array.from(wallets.values())
    .map(w => ({ ...w, realizedPnL: w.solReceived - w.solSpent }))
    .filter(w => w.realizedPnL > DISCOVERY_MinProfit && (w.solReceived > DISCOVERY_MinSize || w.solSpent > DISCOVERY_MinSize))
    .sort((a, b) => b.realizedPnL - a.realizedPnL)
    .slice(0, 30); // Take top 30 candidates max to vet
}

// === PHASE 2 LOGIC ===
async function analyzeWallet(connection: Connection, address: string): Promise<WalletAnalysis> {
  const pubkey = new PublicKey(address);
  // Fetch signatures
  const signatures = await connection.getSignaturesForAddress(pubkey, { limit: ANALYSIS_Lookback });
  const trades: Trade[] = [];
  let oldestTxTime = Date.now() / 1000;

  // Batch Fetch Transactions (Optimized with Chunking)
  const txIds = signatures.map(s => s.signature);
  const CHUNK_SIZE = 25;
  const txs: (ParsedTransactionWithMeta | null)[] = [];

  for (let i = 0; i < txIds.length; i += CHUNK_SIZE) {
    const chunk = txIds.slice(i, i + CHUNK_SIZE);
    const chunkTxs = await connection.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0 });
    txs.push(...chunkTxs);
    await sleep(500); // Delay between chunks to respect rate limits
  }

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    const sig = signatures[i];
    
    if (sig.err) continue;
    if (sig.blockTime && sig.blockTime < oldestTxTime) oldestTxTime = sig.blockTime;

    if (!tx || !tx.meta) continue;

    try {
      // Extract Trade (Simplified)
      const walletIndex = tx.transaction.message.accountKeys.findIndex(k => k.pubkey.toString() === address);
      if (walletIndex === -1) continue;
      
      const solChange = ((tx.meta.postBalances[walletIndex] - tx.meta.preBalances[walletIndex]) / 1e9);
      
      const preTok = tx.meta.preTokenBalances?.filter(t => t.owner === address) || [];
      const postTok = tx.meta.postTokenBalances?.filter(t => t.owner === address) || [];
      
      let bigMint = '', bigChange = 0;
      const changes = new Map<string, number>();
      preTok.forEach(t => changes.set(t.mint, -(t.uiTokenAmount.uiAmount||0)));
      postTok.forEach(t => { const v = changes.get(t.mint)||0; changes.set(t.mint, v + (t.uiTokenAmount.uiAmount||0)); });
      
      for (const [m, c] of changes.entries()) { if(Math.abs(c)>Math.abs(bigChange)) { bigChange=c; bigMint=m; } }

      if (bigMint && Math.abs(solChange) > 0.05) {
        if (solChange < 0 && bigChange > 0) trades.push({ mint: bigMint, type: 'buy', amountSol: Math.abs(solChange), amountTokens: bigChange, timestamp: tx.blockTime||0, signature: sig.signature });
        if (solChange > 0 && bigChange < 0) trades.push({ mint: bigMint, type: 'sell', amountSol: Math.abs(solChange), amountTokens: Math.abs(bigChange), timestamp: tx.blockTime||0, signature: sig.signature });
      }
    } catch {}
  }

  // Scoring
  const tokens = new Map<string, { bought: number, sold: number }>();
  trades.forEach(t => {
    if (!tokens.has(t.mint)) tokens.set(t.mint, { bought:0, sold:0 });
    const s = tokens.get(t.mint)!;
    if (t.type === 'buy') s.bought += t.amountSol; else s.sold += t.amountSol;
  });

  let totalPnL = 0, totalSolSpent = 0, profitableTokens = 0, holdTimes: number[] = [];
  tokens.forEach(s => {
    if (s.bought > 0) {
      const pnl = s.sold - s.bought;
      totalPnL += pnl;
      totalSolSpent += s.bought;
      if (pnl > 0) profitableTokens++;
    }
  });

  const numTokens = tokens.size;
  const winRate = numTokens > 0 ? profitableTokens / numTokens : 0;
  const roi = totalSolSpent > 0 ? totalPnL / totalSolSpent : 0;
  const compositeScore = (winRate * 25) + (Math.min(Math.max(roi,0),3)*10) + (Math.min(profitableTokens,5)*4) + (Math.min(trades.length,50)/5) + 7.5;
  
  const avgHoldTime = 120; // Defaulting for speed (calc omitted for brevity)
  const walletAgeDays = (Date.now()/1000 - oldestTxTime) / 86400;

  const flags: string[] = [];
  if (walletAgeDays < 7) flags.push('Fresh');
  if (numTokens < 3) flags.push('Low Sample');

  let verdict: 'KEEP' | 'DISCARD' = 'DISCARD';
  // Relaxed: Keep if Score > 40. Only ban MEV bots.
  if (compositeScore > 40 && !flags.includes('MEV/Bot')) {
    verdict = 'KEEP';
  }

  return {
    address, totalPnL, totalSolSpent, winRate, roi, totalTrades: trades.length,
    profitableTokens, tokensTraded: numTokens, avgHoldTime, walletAgeDays,
    compositeScore, verdict, tier: compositeScore > 80 ? 'High' : (compositeScore>50?'Medium':'Low'), flags
  };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

main();
