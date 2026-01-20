# Phase 3 Research: Trading & Economic Loop

**Phase:** 3 of 4  
**Focus:** PumpPortal integration, trade execution, and $SCHIZO buyback flywheel  
**Started:** 2026-01-20

## Overview

Phase 3 implements the core economic engine of $SCHIZO: executing trades on pump.fun via PumpPortal API and creating the self-funding flywheel through buybacks.

## Scope

### In Scope

1. **PumpPortal Integration**
   - API client for trading endpoints
   - Fee claiming from pump.fun creator fees
   - Trade execution (buy/sell)
   - Transaction signing and submission

2. **Trading Engine**
   - Decision-making logic based on Phase 2 analysis
   - Position sizing and risk management
   - Trade tracking and persistence
   - Slippage protection

3. **Economic Flywheel**
   - Fee claiming automation
   - Configurable fee split (creator wallet vs trading wallet)
   - Buyback execution when trades are profitable
   - Buyback tracking and reporting

4. **Integration**
   - Connect analysis modules to trading decisions
   - Integrate with existing database for trade persistence
   - Error handling and recovery

### Out of Scope

- Live streaming of reasoning (Phase 4)
- Web interface (Phase 4)
- Personality/paranoid outputs (Phase 4)
- Advanced trading strategies (v2)

## Research

### PumpPortal API

**Documentation:** https://pumpportal.fun/docs

#### Key Endpoints

1. **Trading:**
   - `POST /trade` - Execute buy/sell orders
   - Parameters: `mint`, `amount`, `slippage`, `action` (buy/sell)
   - Returns: transaction signature

2. **Fee Claiming:**
   - `POST /claim-fees` - Claim creator fees
   - Parameters: `token_address`
   - Returns: claimable amount and transaction

3. **Token Info:**
   - `GET /token/{mint}` - Get token metadata
   - Returns: price, liquidity, holder count

#### Authentication

- API key required (set in environment)
- Wallet signing for transactions
- Rate limits: TBD (check docs)

#### Transaction Flow

```
1. Build trade parameters
2. Sign transaction with agent wallet
3. Submit to PumpPortal
4. Wait for confirmation
5. Parse result and update database
```

### Trading Decision Logic

Based on Phase 2 analysis modules:

#### Token Evaluation

```typescript
// Use TokenSafetyAnalyzer
const safety = await tokenSafety.analyze(mint);

// Red flags (DO NOT TRADE):
- safety.isHoneypot === true
- safety.freezeAuthority !== null
- safety.mintAuthority !== null
- safety.top10Concentration > 50%

// Yellow flags (REDUCE POSITION SIZE):
- safety.top10Concentration > 30%
- safety.holderCount < 100
```

#### Wallet Evaluation

```typescript
// Use SmartMoneyTracker
const holders = await getTopHolders(mint); // From Helius
const smartMoneyCount = 0;

for (const holder of holders) {
  const classification = await smartMoney.classify(holder);
  if (classification.isSmartMoney) {
    smartMoneyCount++;
  }
}

// Positive signal:
// - smartMoneyCount >= 3 (multiple smart wallets holding)
```

#### Position Sizing

```typescript
// Base position size
const BASE_POSITION_SOL = 0.5; // 0.5 SOL per trade

// Adjust based on risk:
let positionSize = BASE_POSITION_SOL;

// Reduce for yellow flags
if (safety.top10Concentration > 30%) {
  positionSize *= 0.5;
}

// Increase for strong signals
if (smartMoneyCount >= 5) {
  positionSize *= 1.5;
}

// Never exceed max position
const MAX_POSITION_SOL = 2.0;
positionSize = Math.min(positionSize, MAX_POSITION_SOL);
```

### Economic Flywheel

#### Fee Claiming

```typescript
// Check claimable fees periodically (every 1 hour)
const fees = await pumpPortal.getClaimableFees(SCHIZO_TOKEN_MINT);

if (fees.amount > MIN_CLAIM_THRESHOLD) {
  // Claim fees
  const tx = await pumpPortal.claimFees(SCHIZO_TOKEN_MINT);
  
  // Split fees
  const creatorShare = fees.amount * CREATOR_FEE_SPLIT; // e.g., 0.3 (30%)
  const tradingShare = fees.amount * (1 - CREATOR_FEE_SPLIT); // 0.7 (70%)
  
  // Transfer creator share to creator wallet
  await transferSOL(creatorShare, CREATOR_WALLET);
  
  // Trading share stays in agent wallet for trading
}
```

#### Buyback Logic

```typescript
// After a profitable trade closes
if (trade.realizedPnL > 0) {
  // Use a percentage of profits for buyback
  const buybackAmount = trade.realizedPnL * BUYBACK_PERCENTAGE; // e.g., 0.5 (50%)
  
  // Execute buyback of $SCHIZO token
  await pumpPortal.buy({
    mint: SCHIZO_TOKEN_MINT,
    amount: buybackAmount,
    slippage: 0.05, // 5% slippage tolerance
  });
  
  // Log buyback
  await db.trades.create({
    type: 'BUYBACK',
    mint: SCHIZO_TOKEN_MINT,
    amount: buybackAmount,
    timestamp: Date.now(),
  });
}
```

### Risk Management

#### Trade Limits

- **Max position size:** 2.0 SOL per trade
- **Max open positions:** 5 concurrent positions
- **Max daily trades:** 20 trades
- **Min liquidity:** 10 SOL in pool before trading

#### Stop Loss

- **Time-based:** Close position after 24 hours regardless of P&L
- **Loss-based:** Close if position down > 50%

#### Circuit Breaker

- **Daily loss limit:** Stop trading if daily P&L < -5 SOL
- **Consecutive losses:** Stop after 5 consecutive losing trades
- **Resume:** Manual intervention required to reset circuit breaker

### Database Schema Extensions

#### Trades Table (Existing)

Already exists from Phase 1. May need additional fields:

```sql
ALTER TABLE trades ADD COLUMN trade_type TEXT; -- 'TRADE' or 'BUYBACK'
ALTER TABLE trades ADD COLUMN analysis_snapshot TEXT; -- JSON of safety/wallet analysis
```

#### New Table: Fee Claims

```sql
CREATE TABLE fee_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  token_mint TEXT NOT NULL,
  amount_claimed REAL NOT NULL,
  creator_share REAL NOT NULL,
  trading_share REAL NOT NULL,
  tx_signature TEXT NOT NULL
);
```

#### New Table: Buybacks

```sql
CREATE TABLE buybacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  source_trade_id INTEGER, -- FK to trades table
  amount_sol REAL NOT NULL,
  amount_tokens REAL NOT NULL,
  price REAL NOT NULL,
  tx_signature TEXT NOT NULL,
  FOREIGN KEY (source_trade_id) REFERENCES trades(id)
);
```

## Technical Decisions

### 1. PumpPortal vs Direct Solana

**Decision:** Use PumpPortal API

**Rationale:**
- Abstracts pump.fun protocol complexity
- Handles fee claiming automatically
- Established API with community support
- Faster to implement than direct protocol interaction

**Trade-offs:**
- Dependency on third-party service
- Potential rate limits
- API fees (if any)

### 2. Trading Strategy

**Decision:** Conservative threshold-based strategy (Phase 3), AI-driven strategy later (v2)

**Rationale:**
- Phase 3 focuses on infrastructure and flywheel mechanics
- Simple rules easier to debug and verify
- AI decision-making requires more research and prompt engineering
- Can iterate on strategy without changing infrastructure

**Implementation:**
- Use Phase 2 analysis as inputs
- Hard-coded thresholds for safety/smart money signals
- Position sizing based on risk factors
- Phase 4 can add AI reasoning layer on top

### 3. Fee Split Configuration

**Decision:** Environment variable for creator fee split percentage

**Rationale:**
- Flexibility to adjust split without code changes
- Creator can optimize for growth vs immediate revenue
- Default: 30% creator, 70% trading (maximize flywheel)

**Configuration:**
```
CREATOR_FEE_SPLIT=0.30
CREATOR_WALLET=<address>
```

### 4. Buyback Timing

**Decision:** Immediate buyback on profitable trade close

**Rationale:**
- Simple to implement
- Creates immediate buying pressure
- Transparent and predictable

**Alternative considered:** Batch buybacks (e.g., daily)
- Rejected: Less transparent, delays flywheel effect

### 5. Transaction Confirmation

**Decision:** Wait for `confirmed` commitment level

**Rationale:**
- Balance between speed and reliability
- `finalized` too slow for trading
- `processed` too risky (could be dropped)
- `confirmed` is standard for most dApps

## Must-Haves (Phase 3 Success Criteria)

### Truth 1: Agent can execute trades via PumpPortal
- [ ] Buy and sell transactions successfully submitted
- [ ] Transaction signatures returned and stored
- [ ] Slippage protection works

### Truth 2: Agent claims creator fees and splits them
- [ ] Fee claiming works for $SCHIZO token
- [ ] Fees split according to configuration
- [ ] Creator share transferred to creator wallet

### Truth 3: Profitable trades trigger buybacks
- [ ] Buyback executed when trade closes with profit
- [ ] Buyback amount calculated correctly
- [ ] Buyback transactions recorded in database

### Truth 4: Risk management prevents catastrophic losses
- [ ] Position size limits enforced
- [ ] Circuit breaker stops trading on excessive losses
- [ ] Max open positions enforced

## Plan Breakdown

### Plan 03-01: PumpPortal Client
- Create PumpPortal API client
- Implement trade execution (buy/sell)
- Add transaction signing and submission
- Error handling and retries

### Plan 03-02: Trading Engine
- Create TradingEngine class
- Implement decision logic using Phase 2 analyzers
- Position sizing and risk calculations
- Trade tracking and database integration

### Plan 03-03: Fee Claiming & Splitting
- Implement fee claiming logic
- Add fee split calculation
- Creator wallet transfer
- Fee claim tracking in database

### Plan 03-04: Buyback System
- Implement buyback logic
- Trigger on profitable trade close
- Buyback tracking and reporting
- Integration with trading engine

## Open Questions

1. **PumpPortal rate limits:** What are the actual rate limits? Need to check docs or test.
2. **Minimum claim threshold:** What's a reasonable minimum for fee claims to avoid gas waste?
3. **Buyback percentage:** Start with 50% of profits? Configurable?
4. **Circuit breaker reset:** Manual intervention or time-based auto-reset?

## Dependencies

- Phase 1: Database, keystore, Helius client ✅
- Phase 2: TokenSafetyAnalyzer, WalletAnalyzer, SmartMoneyTracker ✅
- External: PumpPortal API (requires API key)

## Risks

1. **PumpPortal API changes:** Mitigation: Version pinning, monitoring
2. **Slippage on buybacks:** Mitigation: Slippage tolerance, retry logic
3. **Insufficient liquidity:** Mitigation: Minimum liquidity checks before trading
4. **Gas fee spikes:** Mitigation: Priority fee configuration, transaction timeout

---

*Research complete. Ready for plan creation.*
