# Roadmap: $SCHIZO

## Overview

$SCHIZO is a paranoid AI trading agent for Solana memecoins that combines deep wallet forensics (Helius), automated execution (PumpPortal), and an entertaining paranoid personality (Claude) with live streaming. The roadmap moves from secure foundations through analysis capabilities, into active trading with tokenomics, and finally to the public-facing personality and streaming layer. Each phase delivers a complete, verifiable capability.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3, 4): Planned milestone work
- Decimal phases (e.g., 2.1): Urgent insertions if needed

- [x] **Phase 1: Foundation & Security** - Secure wallet management, persistent state, and rate-limited API client
- [x] **Phase 2: Analysis & Token Safety** - Forensic wallet analysis and token risk assessment
- [x] **Phase 3: Trading & Economic Loop** - Trade execution, risk management, fee claiming, and buybacks
- [ ] **Phase 4: Personality & Streaming** - Entertainment mode, mood system, commentary timing, and live streaming

## Phase Details

### Phase 1: Foundation & Security
**Goal**: Agent has secure wallet management, persistent state storage, and efficient Helius API access
**Depends on**: Nothing (first phase)
**Requirements**: FOUND-01, FOUND-02, FOUND-03
**Success Criteria** (what must be TRUE):
  1. Private key is stored encrypted and never exposed in logs, env vars, or code
  2. Agent can restart and recover all previous state (trades, analysis, P&L)
  3. Helius API calls are rate-limited and cached (no rate limit errors under normal operation)
  4. Agent can sign and submit a test transaction to Solana devnet
**Plans**: 5 plans in 3 waves

Plans:
- [x] 01-01-PLAN.md — Project setup with TypeScript, dependencies, and Pino logger
- [x] 01-02-PLAN.md — Encrypted keystore for secure wallet management (FOUND-01)
- [x] 01-03-PLAN.md — SQLite state store for trades and P&L tracking (FOUND-02)
- [x] 01-04-PLAN.md — Rate-limited Helius client with caching (FOUND-03)
- [x] 01-05-PLAN.md — Devnet integration test verifying all systems

### Phase 2: Analysis & Token Safety
**Goal**: Agent can analyze wallets and tokens to identify risks and opportunities before trading
**Depends on**: Phase 1
**Requirements**: ANAL-01, ANAL-02, ANAL-03
**Success Criteria** (what must be TRUE):
  1. Agent can detect honeypot tokens and refuse to trade them
  2. Agent can retrieve and analyze full transaction history for any wallet (via getTransactionsForAddress)
  3. Agent can identify smart money wallets from historical trade patterns
  4. Analysis results are cached to avoid redundant API calls
**Plans**: 4 plans in 3 waves

Plans:
- [x] 02-01-PLAN.md — Foundation types, HeliusClient.getAsset, and AnalysisCacheRepository
- [x] 02-02-PLAN.md — TokenSafetyAnalyzer for honeypot detection (ANAL-01)
- [x] 02-03-PLAN.md — WalletAnalyzer with P&L calculation (ANAL-02)
- [x] 02-04-PLAN.md — SmartMoneyTracker for profitable wallet identification (ANAL-03)

### Phase 3: Trading & Economic Loop
**Goal**: Agent can execute trades with risk management and sustain itself through fee claiming and buybacks
**Depends on**: Phase 2
**Requirements**: TRADE-01, TRADE-02, TRADE-03, ECON-01, ECON-02, ECON-03
**Success Criteria** (what must be TRUE):
  1. Agent can buy and sell memecoins via PumpPortal API
  2. Position sizes respect configured limits (max per trade, total exposure)
  3. Stop-loss and take-profit rules execute automatically when thresholds hit
  4. Agent auto-claims pump.fun creator fees on schedule
  5. Profits trigger automatic $SCHIZO token buybacks
**Plans**: 4 plans in 2 waves

Plans:
- [x] 03-01-PLAN.md — PumpPortal client with trade execution
- [x] 03-02-PLAN.md — Trading engine with risk management
- [x] 03-03-PLAN.md — Fee claiming and buyback system
- [x] 03-04-PLAN.md — Economic flywheel integration

### Phase 4: Personality & Streaming (ENTERTAINMENT MODE)
**Goal**: Agent trades frequently (3-5/hour), has visible moods, and speaks at narrative beats
**Depends on**: Phase 3
**Requirements**: PERS-01, PERS-02, PERS-03, PERS-04, PERS-05
**Success Criteria** (what must be TRUE):
  1. Agent trades 3-5 times per hour with micro positions (0.01-0.05 SOL)
  2. Mood system shows confident/paranoid/restless states based on results
  3. Commentary happens at narrative beats with 15-20 second minimum gaps
  4. Time pressure builds during quiet periods, lowering risk thresholds
  5. Random degen moments occasionally trigger impulsive trades
  6. Frontend displays current mood and trading activity
**Plans**: 4 plans in 2 waves

Plans:
- [ ] 04-01-PLAN.md — Mood System (tracks emotional state, affects trading)
- [ ] 04-02-PLAN.md — Entertainment Mode (relaxed thresholds, micro bets, time pressure)
- [ ] 04-03-PLAN.md — Commentary System (timing control, narrative beats)
- [ ] 04-04-PLAN.md — Integration (wire all systems into trading loop)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation & Security | 5/5 | Complete | 2026-01-20 |
| 2. Analysis & Token Safety | 4/4 | Complete | 2026-01-20 |
| 3. Trading & Economic Loop | 4/4 | Complete | 2026-01-20 |
| 4. Personality & Streaming | 0/4 | Ready | - |

---
*Roadmap created: 2026-01-20*
*Phase 4 replanned: 2026-01-20 (Entertainment Mode focus)*
*Depth: Quick (4 phases)*
*Coverage: 17/17 v1 requirements mapped*
