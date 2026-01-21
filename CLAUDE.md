# Schizo Agent - API & SDK Reference

This document contains comprehensive API documentation for all services used in the Schizo Agent trading bot. This is loaded automatically for every Claude Code session.

---

## Quick Reference

| Service | SDK | Status | Use Case |
|---------|-----|--------|----------|
| Helius | `helius-sdk` | Active | RPC, DAS API, transactions |
| Jupiter | `@jup-ag/api` | Active | Token swaps for graduated tokens |
| Birdeye | Raw HTTP | No SDK | Trending tokens, security |
| DexScreener | Raw HTTP | No SDK | DEX pair data |
| PumpPortal | WebSocket + REST | No SDK | Pump.fun trades |

---

## 1. HELIUS SDK

### Installation
```bash
npm install helius-sdk
```

### Initialization
```typescript
import Helius from 'helius-sdk';

const helius = new Helius('your-api-key');
```

### Core Methods

#### DAS API (Digital Asset Standard)
```typescript
// Get single asset metadata
const asset = await helius.rpc.getAsset({ id: 'mint-address' });

// Get multiple assets (batch - up to 1000)
const assets = await helius.rpc.getAssetBatch({ ids: ['mint1', 'mint2'] });

// Get assets by owner (all NFTs/tokens in wallet)
const owned = await helius.rpc.getAssetsByOwner({
  ownerAddress: 'wallet-address',
  page: 1,
  limit: 100,
  sortBy: { sortBy: 'created', sortDirection: 'desc' }
});

// Get token accounts by mint or owner
const accounts = await helius.rpc.getTokenAccounts({
  mint: 'token-mint',
  limit: 100
});

// Search assets with filters
const results = await helius.rpc.searchAssets({
  ownerAddress: 'wallet',
  compressed: false,
  page: 1
});
```

#### Transactions
```typescript
// Get parsed transaction history
const txs = await helius.rpc.getTransactionsForAddress('wallet-address', {
  limit: 100
});

// Parse raw transactions
const parsed = await helius.parseTransactions({
  transactions: ['signature1', 'signature2']
});

// Get compute units estimate
const units = await helius.rpc.getComputeUnits({
  instructions: [...],
  payer: 'payer-pubkey'
});

// Get priority fee estimate
const fees = await helius.rpc.getPriorityFeeEstimate({
  accountKeys: ['program-id'],
  options: { recommended: true }
});
```

#### Smart Transactions
```typescript
// Create optimized transaction with compute budget
const smartTx = await helius.createSmartTransaction({
  instructions: [...],
  signers: [keypair],
  feePayer: keypair
});

// Send with automatic retry and confirmation
const sig = await helius.sendSmartTransaction(smartTx, {
  skipPreflight: false
});
```

#### Webhooks
```typescript
// Create webhook for address activity
const webhook = await helius.createWebhook({
  webhookURL: 'https://your-endpoint.com/webhook',
  transactionTypes: ['TRANSFER', 'SWAP'],
  accountAddresses: ['address1', 'address2']
});

// List all webhooks
const webhooks = await helius.getAllWebhooks();

// Delete webhook
await helius.deleteWebhook('webhook-id');
```

### Rate Limits by Tier

| Tier | RPC/sec | Enhanced/sec | WebSocket |
|------|---------|--------------|-----------|
| Free | 10 | 2 | No |
| Developer | 50 | 10 | Yes |
| Business | 200 | 50 | Yes |
| Professional | 500 | 100 | Yes |

---

## 2. JUPITER SDK

### Installation
```bash
npm install @jup-ag/api
```

### Initialization
```typescript
import { createJupiterApiClient } from '@jup-ag/api';

const jupiter = createJupiterApiClient();
```

### Core Methods

#### Get Quote
```typescript
const quote = await jupiter.quoteGet({
  inputMint: 'So11111111111111111111111111111111111111112', // SOL
  outputMint: 'token-mint-address',
  amount: 1000000000, // 1 SOL in lamports
  slippageBps: 50, // 0.5%
  swapMode: 'ExactIn'
});

console.log({
  inAmount: quote.inAmount,
  outAmount: quote.outAmount,
  priceImpactPct: quote.priceImpactPct,
  routePlan: quote.routePlan
});
```

#### Execute Swap
```typescript
// Get serialized transaction
const swapResult = await jupiter.swapPost({
  swapRequest: {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toString(),
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  }
});

// Deserialize and sign
const transaction = VersionedTransaction.deserialize(
  Buffer.from(swapResult.swapTransaction, 'base64')
);
transaction.sign([wallet]);

// Send
const signature = await connection.sendTransaction(transaction);
```

#### Token Information
```typescript
// Get token info
const tokens = await jupiter.tokensGet();

// Get specific token
const token = tokens.find(t => t.address === 'mint-address');
```

#### Price API
```typescript
// Get prices for multiple tokens
const prices = await fetch(
  'https://api.jup.ag/price/v2?ids=SOL,token-mint'
).then(r => r.json());
```

### Jupiter Swap Flow
1. Get quote with `quoteGet()`
2. Check `priceImpactPct` (reject if > 5%)
3. Get swap transaction with `swapPost()`
4. Sign and send transaction
5. Confirm transaction

### Important Notes
- Use for tokens that have **graduated from pump.fun** to Raydium
- NOT for active pump.fun bonding curve tokens (use PumpPortal)
- Always check price impact before swapping
- Set reasonable slippage (50-100 bps for liquid tokens)

---

## 3. BIRDEYE API

### Base URL
```
https://public-api.birdeye.so
```

### Headers
```typescript
const headers = {
  'X-API-KEY': process.env.BIRDEYE_API_KEY,
  'x-chain': 'solana'
};
```

### Endpoints

#### Trending Tokens
```typescript
GET /defi/token_trending
Query: sort_by=rank&sort_type=asc&offset=0&limit=20

Response: {
  data: {
    items: [{
      address: string,
      symbol: string,
      name: string,
      price: number,
      priceChange24h: number,
      volume24h: number,
      liquidity: number
    }]
  }
}
```

#### Top Gainers
```typescript
GET /defi/token_top_gainers
Query: time_frame=1h|4h|12h|24h&limit=20

Response: {
  data: [{
    address: string,
    symbol: string,
    priceChange: number
  }]
}
```

#### Token Security
```typescript
GET /defi/token_security
Query: address={mint}

Response: {
  data: {
    isHoneypot: boolean,
    isMintable: boolean,
    isFreezable: boolean,
    topHolders: [{
      address: string,
      percentage: number
    }]
  }
}
```

#### Token Overview
```typescript
GET /defi/token_overview
Query: address={mint}

Response: {
  data: {
    address: string,
    symbol: string,
    name: string,
    price: number,
    mc: number, // market cap
    liquidity: number,
    holder: number,
    extensions: {
      website: string,
      twitter: string,
      telegram: string
    }
  }
}
```

#### Top Traders (Smart Money)
```typescript
GET /defi/v2/tokens/{address}/top_traders
Query: time_frame=24h

Response: {
  data: [{
    address: string,
    pnl: number,
    volume: number,
    trades: number
  }]
}
```

### Rate Limits
- Free tier: 1 request/second
- Use 1200ms delay between requests (80% safety margin)

---

## 4. DEXSCREENER API

### Base URL
```
https://api.dexscreener.com
```

### Endpoints

#### Token Pairs
```typescript
GET /latest/dex/tokens/{tokenAddress}

Response: {
  pairs: [{
    chainId: 'solana',
    dexId: 'raydium',
    pairAddress: string,
    baseToken: { address, name, symbol },
    quoteToken: { address, name, symbol },
    priceNative: string,
    priceUsd: string,
    liquidity: { usd, base, quote },
    fdv: number,
    pairCreatedAt: number, // Unix timestamp
    txns: {
      m5: { buys, sells },
      h1: { buys, sells },
      h6: { buys, sells },
      h24: { buys, sells }
    },
    volume: { m5, h1, h6, h24 },
    priceChange: { m5, h1, h6, h24 }
  }]
}
```

#### Latest Tokens
```typescript
GET /token-profiles/latest/v1

Response: [{
  chainId: 'solana',
  tokenAddress: string,
  description: string,
  links: [{ type, url }]
}]
```

#### Search Tokens
```typescript
GET /latest/dex/search
Query: q={searchTerm}

Response: {
  pairs: [...]
}
```

### No Authentication Required
DexScreener is free with no API key needed.

---

## 5. PUMPPORTAL API

### WebSocket (Real-time Data)
```typescript
const ws = new WebSocket('wss://pumpportal.fun/api/data');

// Subscribe to new tokens
ws.send(JSON.stringify({
  method: 'subscribeNewToken'
}));

// Subscribe to trades for specific token
ws.send(JSON.stringify({
  method: 'subscribeTokenTrade',
  keys: ['token-mint-address']
}));

// Events
ws.on('message', (data) => {
  const event = JSON.parse(data);

  if (event.txType === 'create') {
    // New token created
    console.log({
      mint: event.mint,
      name: event.name,
      symbol: event.symbol,
      uri: event.uri, // IPFS metadata
      bondingCurve: event.bondingCurve,
      creator: event.traderPublicKey
    });
  }

  if (event.txType === 'buy' || event.txType === 'sell') {
    // Trade event
    console.log({
      mint: event.mint,
      type: event.txType,
      solAmount: event.solAmount,
      tokenAmount: event.tokenAmount,
      trader: event.traderPublicKey,
      marketCapSol: event.marketCapSol
    });
  }
});
```

### REST API (Trade Execution)
```typescript
// Get token info
GET /api/token/{mint}

Response: {
  mint: string,
  bondingCurve: string,
  price: number, // SOL per token
  marketCap: number, // in SOL
  supply: number,
  virtualSolReserves: number,
  virtualTokenReserves: number
}

// Execute trade (requires signing)
POST /api/trade-local
Body: {
  publicKey: string,
  action: 'buy' | 'sell',
  mint: string,
  amount: number, // SOL for buy, tokens for sell
  denominatedInSol: 'true' | 'false',
  slippage: number, // 1-100
  priorityFee: number // in SOL
}

Response: {
  transaction: string // Base64 serialized transaction
}
```

### Bonding Curve Formula
```
Price = virtualSolReserves / virtualTokenReserves
```

Tokens graduate to Raydium at ~$69k market cap (~400 SOL in reserves).

---

## 6. GECKOTERMINAL API

### Base URL
```
https://api.geckoterminal.com/api/v2
```

### Endpoints

#### Trending Pools
```typescript
GET /networks/solana/trending_pools

Response: {
  data: [{
    id: string,
    type: 'pool',
    attributes: {
      name: string,
      address: string,
      base_token_price_usd: string,
      fdv_usd: string,
      market_cap_usd: string,
      volume_usd: { h24: string },
      reserve_in_usd: string,
      pool_created_at: string
    },
    relationships: {
      base_token: { data: { id } },
      quote_token: { data: { id } }
    }
  }]
}
```

### No Authentication Required

---

## 7. MORALIS API

**Package**: `src/api/moralis.ts` (Custom client)
**Purpose**: Alternative trending token discovery with security scores
**Docs**: https://docs.moralis.com/web3-data-api/solana

### Key Endpoints

```typescript
import { getMoralisClient } from './api/moralis.js';

const moralis = getMoralisClient();

// Get trending tokens with filters
const trending = await moralis.getTrendingTokens({
  limit: 15,
  minSecurityScore: 30,  // 0-100 (higher = safer)
  minMarketCap: 10000,   // USD
  minLiquidity: 5000,    // USD
});

// Get top gainers
const gainers = await moralis.getTopGainers({
  limit: 10,
  timeFrame: '1h',  // '5m' | '1h' | '4h' | '12h' | '24h'
});

// Get top losers
const losers = await moralis.getTopLosers({
  limit: 10,
  timeFrame: '24h',
});

// Search tokens
const results = await moralis.searchTokens('BONK', 10);

// Get single token
const token = await moralis.getToken(tokenAddress);

// === DEX Integration Endpoints ===

// Get token bonding status (is it on bonding curve or graduated?)
const status = await moralis.getTokenBondingStatus(tokenAddress);
// Returns: { status: 'bonding' | 'graduated' | 'unknown', bondingProgress?, graduatedAt? }

// Get tokens currently in bonding phase (new opportunities)
const bondingTokens = await moralis.getBondingTokens('pumpfun', 20);

// Get recently graduated tokens (moved to Raydium/Jupiter)
const graduatedTokens = await moralis.getGraduatedTokens('pumpfun', 20);

// Get newest tokens from an exchange
const newTokens = await moralis.getNewTokens('pumpfun', 20);

// Get swap history for a token (analyze trading patterns)
const swaps = await moralis.getTokenSwaps(tokenAddress, 50);
// Returns: [{ signature, timestamp, type: 'buy'|'sell', solAmount, tokenAmount, wallet }]
```

### Response Format

```typescript
interface MoralisToken {
  tokenAddress: string;
  name: string;
  symbol: string;
  decimals: number;
  priceUsd: number;
  priceChange24h?: number;
  priceChange1h?: number;
  priceChange5m?: number;
  volume24h?: number;
  volume1h?: number;
  marketCap?: number;
  liquidity?: number;
  securityScore?: number;  // 0-100 (Moralis exclusive!)
  holders?: number;
  buyers24h?: number;
  sellers24h?: number;
}
```

### Security Score Feature

Moralis provides a **security score** (0-100) not available in Birdeye:
- **0-30**: High risk - avoid
- **30-50**: Medium risk - proceed with caution
- **50-70**: Lower risk - reasonable
- **70-100**: Safer tokens

### Rate Limits

- Free tier: 40 requests/second
- Built-in rate limiting in client (200ms delay)

---

## Trading Logic Reference

### When to Use Each API

| Scenario | API to Use |
|----------|-----------|
| New pump.fun token | PumpPortal WebSocket + REST |
| Token safety check | Helius DAS + Birdeye Security + Moralis Score |
| Graduated token swap | Jupiter |
| Trending discovery | Moralis + Birdeye + GeckoTerminal |
| Wallet analysis | Helius getTransactionsForAddress |
| Price data | DexScreener (free) or Birdeye |

### Token Lifecycle
1. **Creation** - PumpPortal WebSocket detects
2. **Bonding Curve** - Trade via PumpPortal REST
3. **Graduation** (~$69k mcap) - Migrates to Raydium
4. **Post-Graduation** - Trade via Jupiter

### Safety Checks Priority
1. Helius `getAsset()` - Check authorities
2. Birdeye `token_security` - Honeypot detection
3. Helius `getTokenAccounts()` - Holder concentration
4. DexScreener - Liquidity verification

---

## Environment Variables

```env
# Required
HELIUS_API_KEY=your-helius-key

# Token Discovery APIs (at least one recommended)
BIRDEYE_API_KEY=your-birdeye-key
MORALIS_API_KEY=your-moralis-key

# Optional
HELIUS_TIER=developer  # free|developer|business|professional
```

---

## Learning & Intelligence Components

### 1. BundleDetector (`src/analysis/bundle-detector.ts`)
Detects coordinated/manipulated trading patterns.

**Detection Methods:**
- Timing clusters (transactions within 30s window)
- Amount similarity (low variance = bots)
- Same-block detection (Jito bundles)
- Wallet concentration analysis

**Usage:**
```typescript
import { BundleDetector } from './analysis/bundle-detector.js';

const detector = new BundleDetector();
const analysis = detector.analyze(transactions);

if (analysis.isBundled) {
  console.log('Bundle detected!', analysis.flags);
  // Flags: TIMING_CLUSTER, SIMILAR_AMOUNTS, SAME_BLOCK, CONCENTRATED
}
```

### 2. SmartMoneyCopier (`src/trading/smart-money-copier.ts`)
Proactively watches profitable wallets and copies their trades.

**Key Difference from SmartMoneyTracker:**
- SmartMoneyTracker: Token detected → check who's buying
- SmartMoneyCopier: Watch wallets → copy when they buy

**Usage:**
```typescript
import { SmartMoneyCopier } from './trading/smart-money-copier.js';

const copier = new SmartMoneyCopier(helius, {
  minWalletPnl: 10,      // 10 SOL minimum profit
  minWinRate: 0.5,       // 50% win rate
  maxTradeAge: 60000,    // Copy within 1 minute
  maxCopySize: 0.1,      // 0.1 SOL max per copy
});

// Add wallets to watch
copier.addWallet({
  address: 'wallet-address',
  label: 'Whale #1',
  pnlSol: 500,
  winRate: 0.72,
  totalTrades: 150,
});

// Listen for signals
copier.onSignal((signal) => {
  console.log('Copy trade signal!', signal.trade.tokenMint);
  // Execute trade with signal.suggestedSize
});

copier.start();
```

### 3. LearningEngine (`src/analysis/learning-engine.ts`)
Tracks trade outcomes and learns which features predict success.

**What It Learns:**
- Which features correlate with wins (smart money, heat, holder count, etc.)
- Confidence calibration (is "high confidence" actually high win rate?)
- Feature weights that adjust over time

**Usage:**
```typescript
import { LearningEngine, TradeLesson } from './analysis/learning-engine.js';

const learner = new LearningEngine(db);

// After a trade closes, record the lesson
await learner.recordLesson({
  id: 'trade-123',
  tokenMint: 'mint-address',
  features: {
    bondingCurveProgress: 35,
    heatMetric: 67,
    smartMoneyCount: 2,
    holderCount: 150,
    // ... all features at entry time
  },
  outcome: 'win',
  pnlPercent: 45,
  confidenceAtEntry: 75,
});

// Use learned weights to score new tokens
const { adjustment, reasons, warnings } = learner.scoreFeatures(newTokenFeatures);
// adjustment: -30 to +30 points to add to base confidence

// Get insights
const insights = learner.getInsights();
// { bestFeatures: [...], worstFeatures: [...], calibrationIssues: [...] }
```

### 4. MomentumScanner (`src/analysis/momentum-scanner.ts`)
Detects early pump signals using heat metrics.

**Key Metrics:**
- Heat: `(1min_volume / 5min_volume) * 100`
- Buy pressure: Buy/Sell ratio
- Consecutive buys
- Price steps

**Phases:**
- Cold: < 33% heat
- Building: 33-48% heat
- Hot: 48-100% heat
- Peak: 100%+ heat (caution!)

**Usage:**
```typescript
import { MomentumScanner } from './analysis/momentum-scanner.js';

const scanner = new MomentumScanner();

// Feed trades as they come in
scanner.addTrade(tokenMint, {
  timestamp: Date.now(),
  type: 'buy',
  solAmount: 0.5,
  tokenAmount: 1000000,
  pricePerToken: 0.0000005,
  signature: 'sig...',
});

// Analyze momentum
const momentum = scanner.analyze(tokenMint);
// {
//   score: 72,
//   heatMetric: 55,
//   phase: 'hot',
//   recommendation: 'buy',
//   alerts: [{ type: 'heat', message: 'HOT: Heat at 55%' }]
// }
```

---

## MCP Server (Optional)

The Helius MCP server can be added for direct Claude access to blockchain data.

### Setup
```json
// %APPDATA%\Claude\claude_desktop_config.json
{
  "mcpServers": {
    "helius": {
      "command": "npx",
      "args": ["-y", "mcp-server-helius"],
      "env": {
        "HELIUS_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Available Tools
- `get_balance` - Wallet SOL balance
- `get_token_accounts` - Token holdings
- `get_asset` - NFT/token metadata
- `get_transactions` - Transaction history
- `execute_swap` - Jupiter swap execution
