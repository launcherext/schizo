
import dotenv from 'dotenv';
dotenv.config();

import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { config } from '../config/settings';

// === CONFIGURATION ===
const SCAN_LIMIT = 2000;           // Be aggressive: Scan last 2000 txs (approx 10-20 mins on active meme)
const MIN_REALIZED_PROFIT = 1.0;   // Loose Tier: At least 1 SOL profit banked
const MIN_TRADE_SIZE = 0.5;        // Medium Tier: Ignore < 0.5 SOL trades

interface WalletStats {
  address: string;
  solSpent: number;     // Cost Basis (Buys)
  solReceived: number;  // Realized Gains (Sells)
  tokenBought: number;
  tokenSold: number;
  txCount: number;
  isEarly: boolean;     // Heuristic: Sold but never bought in this window (implies bought before)
  firstActionTime: number;
}

async function discoverWhales(mintAddress: string) {
  console.log(`\n🕵️  Deep Scanning Token: ${mintAddress}`);
  console.log(`    Strategy: Realized PnL Analysis (Last ${SCAN_LIMIT} txs)`);
  
  const connection = new Connection(config.solanaRpcUrl || `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`);
  
  try {
    const mintPubkey = new PublicKey(mintAddress);
    
    // 1. Fetch Transaction History (Batching to respect limits)
    console.log(`\n⏳ Fetching transaction history...`);
    let signatures: string[] = [];
    let lastSig: string | undefined = undefined;
    
    while (signatures.length < SCAN_LIMIT) {
      const batch = await connection.getSignaturesForAddress(mintPubkey, { 
        limit: 1000, 
        before: lastSig 
      });
      
      if (batch.length === 0) break;
      
      batch.forEach(s => signatures.push(s.signature));
      lastSig = batch[batch.length - 1].signature;
      
      process.stdout.write(`\r    Fetched ${signatures.length} signatures...`);
      if (batch.length < 1000) break; // Reached end of history
    }
    console.log(`\n    ✅ Scan complete. Found ${signatures.length} transactions.`);

    // 2. Analyze Transactions & Build Ledgers
    console.log(`\n🧮 reconstructing ledger & calculating PnL...`);
    const wallets = new Map<string, WalletStats>();
    
    // Process in chunks to avoid rate limits
    const CHUNK_SIZE = 50; 
    for (let i = 0; i < signatures.length; i += CHUNK_SIZE) {
      const chunk = signatures.slice(i, i + CHUNK_SIZE);
      process.stdout.write(`\r    Processing tx ${i + 1} to ${Math.min(i + CHUNK_SIZE, signatures.length)}...`);
      
      const txs = await connection.getParsedTransactions(chunk, { 
        maxSupportedTransactionVersion: 0 
      });

      for (const tx of txs) {
        if (!tx || !tx.meta) continue;
        analyzeTransaction(tx, mintAddress, wallets);
      }
      
      // Safety delay for RPC
      await new Promise(r => setTimeout(r, 100));
    }

    // 3. Filter & Rank Candidates
    const candidates = Array.from(wallets.values())
      .map(stats => {
        const realizedPnL = stats.solReceived - stats.solSpent;
        // If they sold more tokens than they bought in this window, 
        // it means they entered BEFORE this window.
        // We assume their "Cost" for those extra tokens was effectively 0 (or low) 
        // relative to current price, so the PnL is valid "Realized" gains from this pump.
        return { ...stats, realizedPnL };
      })
      .filter(w => {
        // FILTER LOGIC
        if (w.realizedPnL < MIN_REALIZED_PROFIT) return false; // Must be profitable
        if (w.solReceived < MIN_TRADE_SIZE && w.solSpent < MIN_TRADE_SIZE) return false; // Ignore dust
        return true;
      })
      .sort((a, b) => b.realizedPnL - a.realizedPnL); // Rank by highest profit

    // 4. Output Results
    console.log(`\n\n🏆 TOP PROFITABLE WALLETS (Last 2000 Txs)`);
    console.log(`   Criteria: Realized PnL > ${MIN_REALIZED_PROFIT} SOL`);

    if (candidates.length === 0) {
      console.log('   ❌ No whales found matching criteria. Analysis suggests this might be new or PVP.');
      return;
    }

    const tableData = candidates.slice(0, 15).map(c => ({
      Address: c.address,
      'Realized PnL': `${c.realizedPnL.toFixed(2)} SOL`,
      'Est. ROI': c.solSpent > 0 ? `${((c.realizedPnL / c.solSpent) * 100).toFixed(0)}%` : 'EARLY',
      'Action': c.solSpent === 0 ? 'SOLD ONLY' : (c.solReceived === 0 ? 'BOUGHT ONLY' : 'TRADED'),
      'Tx Count': c.txCount
    }));

    console.table(tableData);
    
    // Output clean list for .env
    console.log('\n👇 COPY THIS LIST FOR YOUR .env:');
    const cleanList = candidates.slice(0, 15).map(c => c.address).join(',');
    console.log(`COPY_TRADE_WALLETS="${cleanList}"`);

  } catch (error) {
    console.error('\n❌ Discovery failed:', error);
  }
}

function analyzeTransaction(tx: ParsedTransactionWithMeta, mint: string, wallets: Map<string, WalletStats>) {
  if (!tx.meta) return;
  
  // Identify who traded using pre/post balances
  // Strategy: Scan all token balance changes.
  
  const tokenBalances = [
    ...(tx.meta.preTokenBalances || []),
    ...(tx.meta.postTokenBalances || [])
  ];
  
  // Get unique owners involved with THIS token
  const owners = new Set<string>();
  tokenBalances.forEach(tb => {
    if (tb.mint === mint && tb.owner) owners.add(tb.owner);
  });

  for (const owner of owners) {
    // Determine Token Change
    const preToken = tx.meta.preTokenBalances?.find(t => t.owner === owner && t.mint === mint)?.uiTokenAmount.uiAmount || 0;
    const postToken = tx.meta.postTokenBalances?.find(t => t.owner === owner && t.mint === mint)?.uiTokenAmount.uiAmount || 0;
    const tokenChange = postToken - preToken;
    
    if (tokenChange === 0) continue; // No movement for this user

    // Determine SOL Change (Cost/Revenue)
    // Find account index
    const accountIndex = tx.transaction.message.accountKeys.findIndex(k => k.pubkey.toString() === owner);
    if (accountIndex === -1) continue;

    const preSol = tx.meta.preBalances[accountIndex] || 0;
    const postSol = tx.meta.postBalances[accountIndex] || 0;
    const solChange = (postSol - preSol) / 1e9; // Lamports back to SOL
    
    // Ignore gas-only changes (approx < 0.01 SOL change with no token movement? No, we checked token movement)
    // Actually, SOL change might include other transfers, but usually accurate enough for swaps.
    
    let stats = wallets.get(owner) || {
      address: owner,
      solSpent: 0,
      solReceived: 0,
      tokenBought: 0,
      tokenSold: 0,
      txCount: 0,
      isEarly: false,
      firstActionTime: tx.blockTime || Date.now()/1000
    };
    
    stats.txCount++;
    if (tx.blockTime && tx.blockTime < stats.firstActionTime) stats.firstActionTime = tx.blockTime;

    if (tokenChange > 0) {
      // BUY: Gained Token, Spent SOL (solChange negative)
      stats.tokenBought += tokenChange;
      if (solChange < 0) stats.solSpent += Math.abs(solChange);
    } else {
      // SELL: Lost Token, Gained SOL (solChange positive)
      stats.tokenSold += Math.abs(tokenChange);
      if (solChange > 0) stats.solReceived += solChange;
    }
    
    wallets.set(owner, stats);
  }
}

const mintArg = process.argv[2];
if (!mintArg) {
  console.log('Usage: npm run discover <MINT_ADDRESS>');
  process.exit(1);
}

discoverWhales(mintArg);
