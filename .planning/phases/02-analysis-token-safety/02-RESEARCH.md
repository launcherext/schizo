# Phase 02: Analysis & Token Safety - Research

**Researched:** 2026-01-20
**Domain:** Solana token safety analysis, wallet forensics, smart money identification
**Confidence:** HIGH

## Summary

This phase focuses on building the analysis capabilities to detect honeypot tokens and identify profitable "smart money" wallets before trading. The research covers three main areas: (1) token safety checks using Helius DAS API to detect dangerous token configurations like freeze authority, mint authority, and Token-2022 extensions; (2) deep wallet analysis using the existing `getTransactionsForAddress` to calculate win rates, ROI, and trading patterns; (3) smart money identification using threshold-based classification from transaction history.

The Helius DAS API provides the `getAsset` method which returns `mint_authority`, `freeze_authority`, and `mint_extensions` fields - exactly what's needed for honeypot detection. The existing HeliusClient already has transaction fetching; this phase adds token metadata fetching and analysis logic. For Token-2022 tokens, the `permanent_delegate` and `transfer_fee` extensions are critical red flags that must be checked.

**Primary recommendation:** Build a TokenSafetyAnalyzer that uses Helius `getAsset` to check authorities/extensions, and a WalletAnalyzer that processes transaction history to calculate P&L metrics and identify smart money wallets.

## Standard Stack

The established libraries/tools for this domain:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| helius-sdk | 2.x | DAS API for token metadata | Official Helius SDK with getAsset method |
| @solana/web3.js | 1.x | Solana connection (already in project) | Standard Solana library |
| better-sqlite3 | (existing) | Cache analysis results | Already used in Phase 1 |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| bignumber.js | 9.x | Precise financial calculations | For P&L, ROI calculations with decimal precision |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| helius-sdk | Raw fetch (existing) | SDK adds convenience but existing fetch pattern already works well |
| bignumber.js | Native BigInt | BigInt lacks decimal support needed for SOL/token amounts |

**Installation:**
```bash
npm install bignumber.js
```

Note: The existing project already uses raw fetch for Helius API calls. We can extend that pattern rather than adding helius-sdk, maintaining consistency with Phase 1 code.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── analysis/
│   ├── index.ts                    # Export all analyzers
│   ├── token-safety.ts             # TokenSafetyAnalyzer class
│   ├── wallet-analyzer.ts          # WalletAnalyzer class
│   ├── smart-money.ts              # SmartMoneyTracker class
│   └── types.ts                    # Analysis result types
├── api/
│   ├── helius.ts                   # Extend with getAsset method
│   └── ...
└── db/
    └── repositories/
        └── analysis-cache.ts       # AnalysisCacheRepository
```

### Pattern 1: Token Safety Analyzer
**What:** Dedicated class that checks all safety indicators for a token mint address
**When to use:** Before any trade consideration, on token discovery
**Example:**
```typescript
// Source: QuickNode DAS API docs + Helius blog
interface TokenSafetyResult {
  mint: string;
  isSafe: boolean;
  risks: TokenRisk[];
  authorities: {
    mintAuthority: string | null;    // null = safe (revoked)
    freezeAuthority: string | null;  // null = safe (revoked)
    updateAuthority: string | null;  // null = safe (immutable)
  };
  extensions: {
    hasPermanentDelegate: boolean;   // true = DANGER
    hasTransferFee: boolean;         // true = WARNING
    hasTransferHook: boolean;        // true = WARNING
    permanentDelegateAddress?: string;
    transferFeePercent?: number;
  };
  metadata: {
    isMutable: boolean;              // true = can change name/image
  };
  timestamp: number;
}

type TokenRisk =
  | 'MINT_AUTHORITY_ACTIVE'
  | 'FREEZE_AUTHORITY_ACTIVE'
  | 'PERMANENT_DELEGATE'
  | 'HIGH_TRANSFER_FEE'
  | 'TRANSFER_HOOK'
  | 'MUTABLE_METADATA';
```

### Pattern 2: Wallet Analyzer with P&L Calculation
**What:** Analyzes wallet transaction history to calculate trading performance
**When to use:** To evaluate if a wallet is "smart money" worth following
**Example:**
```typescript
// Source: Nansen methodology + Solsniffer patterns
interface WalletAnalysis {
  address: string;
  metrics: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;              // wins / totalTrades
    totalRealizedPnL: number;     // in SOL
    totalROI: number;             // percentage
    avgHoldTime: number;          // seconds
    tokensTraded: number;
  };
  tradingPattern: 'sniper' | 'holder' | 'flipper' | 'unknown';
  isSmartMoney: boolean;
  smartMoneyScore: number;        // 0-100
  lastAnalyzed: number;
}
```

### Pattern 3: Transaction-to-Trade Mapping
**What:** Convert raw Helius transactions into trade records with P&L
**When to use:** Processing getTransactionsForAddress results
**Example:**
```typescript
// From Helius Enhanced Transactions API
interface ParsedTrade {
  signature: string;
  timestamp: number;
  type: 'BUY' | 'SELL';
  tokenMint: string;
  tokenAmount: number;
  solAmount: number;
  pricePerToken: number;
  dex: string;                    // Jupiter, Raydium, PumpFun, etc.
}

// Trade matching for P&L calculation
interface Position {
  tokenMint: string;
  entries: ParsedTrade[];         // Buy transactions
  exits: ParsedTrade[];           // Sell transactions
  realizedPnL: number;
  isOpen: boolean;
}
```

### Anti-Patterns to Avoid
- **Checking only one authority:** Must check ALL of mint, freeze, update authorities AND Token-2022 extensions
- **Ignoring Token-2022:** Many scam tokens use permanent delegate extension - this is often missed
- **Win rate without context:** A 90% win rate on 3 trades is meaningless; require minimum trade count
- **Caching indefinitely:** Token metadata can change (if mutable); smart money status decays over time

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Decimal math for SOL | parseFloat/Number | bignumber.js or fixed-point integers (lamports) | Floating point precision errors in financial calcs |
| Transaction type parsing | Manual instruction decoding | Helius Enhanced API `type` field | Helius already classifies 500+ tx types |
| DEX swap detection | Parse each DEX's instructions | Helius `events.swap` object | Aggregates Jupiter, Raydium, Orca, etc. |
| Token metadata | getMint + getAccountInfo | Helius getAsset DAS API | Single call returns all authorities + extensions |

**Key insight:** Helius Enhanced Transactions API already does the hard work of parsing swaps, transfers, and DEX interactions. Use their `type` field and `events` object rather than decoding raw instructions.

## Common Pitfalls

### Pitfall 1: Missing Token-2022 Extensions
**What goes wrong:** Checking only classic SPL Token authorities misses Token-2022 permanent delegate
**Why it happens:** Token-2022 is newer; many guides focus only on freeze/mint authority
**How to avoid:** Always check `mint_extensions` in getAsset response; specifically look for PermanentDelegate
**Warning signs:** Token uses Token-2022 program (check `token_program` field)

### Pitfall 2: Incomplete P&L Calculation
**What goes wrong:** Calculating wins/losses without matching buys to sells per token
**Why it happens:** Naive approach counts each profitable tx as "win" without position tracking
**How to avoid:** Build position tracking: match sells to previous buys for same token
**Warning signs:** Win rate seems impossibly high; P&L doesn't match intuition

### Pitfall 3: Stale Smart Money Classification
**What goes wrong:** Following a wallet that was "smart money" 6 months ago but isn't anymore
**Why it happens:** One-time analysis without expiration
**How to avoid:** Recalculate periodically (30-day window); weight recent performance higher
**Warning signs:** Following wallets that are now losing money

### Pitfall 4: API Rate Limits on Full History
**What goes wrong:** Hitting rate limits when fetching complete transaction history
**Why it happens:** Some wallets have 10,000+ transactions; fetching all at once
**How to avoid:** Use pagination with delays; cache partial results; implement incremental updates
**Warning signs:** 429 errors; circuit breaker opening frequently

### Pitfall 5: Confusing Unrealized vs Realized P&L
**What goes wrong:** Showing paper gains as actual profits
**Why it happens:** Including open positions in total P&L
**How to avoid:** Separate metrics: `realizedPnL` (closed positions) vs `unrealizedPnL` (open)
**Warning signs:** P&L swings wildly on token price changes

## Code Examples

Verified patterns from official sources:

### Fetching Token Metadata with getAsset
```typescript
// Source: QuickNode DAS API docs / Helius DAS API
interface GetAssetResponse {
  interface: string;
  id: string;
  content: {
    metadata: { name: string; symbol: string };
  };
  authorities: Array<{ address: string; scopes: string[] }>;
  ownership: {
    frozen: boolean;
    owner: string;
  };
  token_info?: {
    supply: number;
    decimals: number;
    token_program: string;
    mint_authority: string | null;
    freeze_authority: string | null;
  };
  mint_extensions?: {
    permanent_delegate?: { delegate: string };
    transfer_fee_config?: {
      transfer_fee_basis_points: number;
      maximum_fee: number;
    };
    transfer_hook?: { program_id: string };
  };
  mutable: boolean;
}

async function getAsset(mintAddress: string): Promise<GetAssetResponse> {
  const response = await fetch(`${this.baseUrl}/?api-key=${this.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAsset',
      params: { id: mintAddress }
    })
  });
  const json = await response.json();
  return json.result;
}
```

### Token Safety Check Logic
```typescript
// Source: Phantom docs + Solana Token-2022 docs
function analyzeTokenSafety(asset: GetAssetResponse): TokenSafetyResult {
  const risks: TokenRisk[] = [];

  // Check classic authorities
  const tokenInfo = asset.token_info;
  if (tokenInfo?.mint_authority) {
    risks.push('MINT_AUTHORITY_ACTIVE');
  }
  if (tokenInfo?.freeze_authority) {
    risks.push('FREEZE_AUTHORITY_ACTIVE');
  }

  // Check Token-2022 extensions (CRITICAL)
  const extensions = asset.mint_extensions;
  if (extensions?.permanent_delegate) {
    risks.push('PERMANENT_DELEGATE');  // Most dangerous!
  }
  if (extensions?.transfer_fee_config) {
    const feeBps = extensions.transfer_fee_config.transfer_fee_basis_points;
    if (feeBps > 100) { // > 1%
      risks.push('HIGH_TRANSFER_FEE');
    }
  }
  if (extensions?.transfer_hook) {
    risks.push('TRANSFER_HOOK');
  }

  // Check metadata mutability
  if (asset.mutable) {
    risks.push('MUTABLE_METADATA');
  }

  return {
    mint: asset.id,
    isSafe: risks.length === 0 ||
            (risks.length === 1 && risks[0] === 'MUTABLE_METADATA'),
    risks,
    authorities: {
      mintAuthority: tokenInfo?.mint_authority ?? null,
      freezeAuthority: tokenInfo?.freeze_authority ?? null,
      updateAuthority: asset.authorities[0]?.address ?? null
    },
    extensions: {
      hasPermanentDelegate: !!extensions?.permanent_delegate,
      hasTransferFee: !!extensions?.transfer_fee_config,
      hasTransferHook: !!extensions?.transfer_hook,
      permanentDelegateAddress: extensions?.permanent_delegate?.delegate,
      transferFeePercent: extensions?.transfer_fee_config
        ? extensions.transfer_fee_config.transfer_fee_basis_points / 100
        : undefined
    },
    metadata: { isMutable: asset.mutable },
    timestamp: Date.now()
  };
}
```

### Smart Money Classification
```typescript
// Source: Nansen methodology
interface SmartMoneyThresholds {
  minTrades: number;           // Minimum trades for valid sample
  minWinRate: number;          // Minimum win rate (0-1)
  minRealizedPnL: number;      // Minimum realized P&L in SOL
  minROI: number;              // Minimum ROI percentage
  analysisWindowDays: number;  // Only consider recent trades
}

const DEFAULT_THRESHOLDS: SmartMoneyThresholds = {
  minTrades: 10,               // At least 10 closed positions
  minWinRate: 0.65,            // 65% win rate minimum
  minRealizedPnL: 50,          // 50 SOL minimum profit
  minROI: 100,                 // 100% ROI minimum
  analysisWindowDays: 30       // Last 30 days only
};

function classifySmartMoney(
  analysis: WalletAnalysis,
  thresholds: SmartMoneyThresholds = DEFAULT_THRESHOLDS
): { isSmartMoney: boolean; score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // Must meet minimum trade count
  if (analysis.metrics.totalTrades < thresholds.minTrades) {
    return { isSmartMoney: false, score: 0, reasons: ['Insufficient trades'] };
  }

  // Score each metric
  if (analysis.metrics.winRate >= thresholds.minWinRate) {
    score += 25;
    reasons.push(`Win rate: ${(analysis.metrics.winRate * 100).toFixed(1)}%`);
  }
  if (analysis.metrics.totalRealizedPnL >= thresholds.minRealizedPnL) {
    score += 25;
    reasons.push(`P&L: ${analysis.metrics.totalRealizedPnL.toFixed(2)} SOL`);
  }
  if (analysis.metrics.totalROI >= thresholds.minROI) {
    score += 25;
    reasons.push(`ROI: ${analysis.metrics.totalROI.toFixed(1)}%`);
  }
  // Bonus for high trade volume with good metrics
  if (analysis.metrics.totalTrades >= 50 && score >= 50) {
    score += 25;
    reasons.push('High volume trader');
  }

  return {
    isSmartMoney: score >= 75,  // Need 75+ to qualify
    score,
    reasons
  };
}
```

### Caching Analysis Results in SQLite
```typescript
// Source: Phase 1 schema (analysis_cache table)
interface AnalysisCacheEntry {
  address: string;
  analysisType: 'token_safety' | 'wallet_analysis' | 'smart_money';
  result: string;  // JSON stringified
  expiresAt: number;
}

// TTL recommendations:
const CACHE_TTL = {
  tokenSafety: 24 * 60 * 60 * 1000,     // 24 hours - authorities rarely change
  walletAnalysis: 6 * 60 * 60 * 1000,   // 6 hours - recalculate frequently
  smartMoney: 24 * 60 * 60 * 1000       // 24 hours - daily recalculation
};

class AnalysisCacheRepository {
  constructor(private db: Database.Database) {}

  get<T>(address: string, type: string): T | null {
    const row = this.db.prepare(`
      SELECT result FROM analysis_cache
      WHERE address = ? AND analysis_type = ? AND expires_at > ?
    `).get(address, type, Date.now());
    return row ? JSON.parse(row.result) : null;
  }

  set(address: string, type: string, result: unknown, ttl: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO analysis_cache
      (address, analysis_type, result, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(address, type, JSON.stringify(result), Date.now() + ttl, Date.now());
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Check only freeze/mint authority | Check ALL authorities + Token-2022 extensions | Token-2022 launch 2023 | Permanent delegate is now primary scam vector |
| Surface-level wallet tracking | Deep forensic analysis with P&L calculation | 2024-2025 | Nansen/Arkham set standard for wallet intelligence |
| Manual smart money lists | Algorithmic classification with thresholds | 2025 | Scalable, reproducible, less bias |
| Pump.fun to Raydium only | PumpSwap internal DEX option | March 2025 | Token graduation flow changed |

**Deprecated/outdated:**
- Checking only `freeze_authority`: Insufficient - must also check `permanent_delegate` extension
- Following KOL wallets blindly: Now requires validation with actual P&L metrics
- Single DEX analysis: Jupiter aggregates across all DEXs; analyze Jupiter routes

## Open Questions

Things that couldn't be fully resolved:

1. **Exact getAsset response format for Token-2022 extensions**
   - What we know: Fields exist for permanent_delegate, transfer_fee, transfer_hook
   - What's unclear: Exact nesting structure varies by documentation source
   - Recommendation: Test with real Token-2022 tokens on devnet/mainnet to verify

2. **Optimal smart money thresholds for Solana memecoins**
   - What we know: Nansen uses $1.5M+ for "all time" label; 65%+ win rate cited
   - What's unclear: Memecoin-specific thresholds (faster trades, smaller amounts)
   - Recommendation: Start conservative, tune based on observed performance

3. **Helius Enhanced API swap event structure**
   - What we know: Returns parsed swap data with input/output tokens
   - What's unclear: Exact field names for amount, price, DEX source
   - Recommendation: Log and inspect actual responses; adjust parsing as needed

## Sources

### Primary (HIGH confidence)
- QuickNode DAS API docs (getAsset response schema with mint_authority, freeze_authority)
- Solana Token-2022 docs (permanent delegate extension detection)
- Helius Enhanced Transactions API docs (transaction type parsing)
- Nansen methodology guide (smart money classification criteria)

### Secondary (MEDIUM confidence)
- Helius blog on DAS API (authority checking approach)
- Phantom docs on Token-2022 warnings (extension risk assessment)
- Chainstack pump.fun migration guide (graduation detection)

### Tertiary (LOW confidence)
- WebSearch findings on smart money thresholds (varies by source)
- Community patterns for memecoin analysis (anecdotal)

## Metadata

**Confidence breakdown:**
- Token safety checks: HIGH - DAS API well documented, multiple sources agree
- Wallet analysis P&L: MEDIUM - Logic is sound but exact Helius response format needs verification
- Smart money classification: MEDIUM - Thresholds are reasonable starting points but may need tuning

**Research date:** 2026-01-20
**Valid until:** 2026-02-20 (30 days - stable domain, APIs unlikely to change)
