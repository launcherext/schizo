---
phase: 04-personality-streaming
plan: 02
subsystem: trading
tags: [entertainment-mode, degen-trading, micro-bets, time-pressure]

# Dependency graph
requires:
  - phase: 04-01
    provides: MoodSystem for mood-based adjustments
provides:
  - EntertainmentMode class for aggressive trading
  - Time pressure mechanics (5-15 min quiet period)
  - Degen moment random apes (8% chance)
  - Micro betting (0.01-0.05 SOL)
  - Rate limiting (5 min cooldown, 6/hour max)
affects: [04-03, trading-loop-integration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Time pressure builds from 0 to 1 over quiet period
    - Quality score with threshold that drops under pressure
    - Hype detection via volume + holder count

key-files:
  created:
    - src/trading/entertainment-mode.ts
  modified:
    - src/trading/types.ts
    - src/trading/token-validator.ts
    - src/trading/index.ts

key-decisions:
  - "0.01-0.05 SOL position range for micro bets (~$2-10)"
  - "5 min quiet period before restlessness, max at 15 min"
  - "Risk threshold drops from 6/10 to 4/10 under time pressure"
  - "8% degen chance for random apes"
  - "5 min cooldown, 6 trades/hour rate limit"
  - "Hype detection: $10k volume AND 50+ holders"

patterns-established:
  - "Time pressure as 0-1 value for graduated desperation"
  - "Quality score calculation for simplified token evaluation"
  - "Mood effects applied as multipliers to risk/position"

# Metrics
duration: 5min
completed: 2026-01-20
---

# Phase 4 Plan 2: Entertainment Mode Summary

**EntertainmentMode class enabling frequent degen trading with micro bets, time pressure, and random ape moments**

## Performance

- **Duration:** 5 min
- **Started:** 2026-01-20
- **Completed:** 2026-01-20
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Created EntertainmentMode class with full degen trading decision logic
- Micro betting configuration (0.01-0.05 SOL per trade)
- Time pressure mechanic that lowers risk threshold as quiet periods extend
- 8% degen moment chance for random apes
- Hype detection based on volume ($10k) and holders (50+)
- Rate limiting with 5 min cooldown and 6 trades/hour max
- MoodSystem integration for mood-adjusted decisions
- Added ENTERTAINMENT to RiskProfile type union
- Updated TokenValidator with relaxed ENTERTAINMENT thresholds

## Task Commits

Each task was committed atomically:

1. **Task 1: Create EntertainmentMode class** - `43e8cb9` (feat)
2. **Task 2: Add ENTERTAINMENT to RiskProfile type** - `9caf949` (feat)
3. **Task 3: Export EntertainmentMode from trading index** - `828ea0b` (feat)

## Files Created/Modified

- `src/trading/entertainment-mode.ts` - EntertainmentMode class with time pressure, degen moments, and micro betting
- `src/trading/types.ts` - Added ENTERTAINMENT to RiskProfile union
- `src/trading/token-validator.ts` - Added ENTERTAINMENT thresholds (auto-fix for blocking issue)
- `src/trading/index.ts` - Exports for EntertainmentMode and related types

## Key Features

### Time Pressure Mechanics
- Starts at 0 after a trade
- No pressure during 5 min cooldown
- Builds linearly from 5-15 minutes of inactivity
- At max pressure (1.0), risk threshold drops from 0.6 to 0.4

### Degen Moments
- 8% base chance on each evaluation
- MANIC mood doubles chance to 16%
- PARANOID mood halves chance to 4%
- Triggers immediate trade regardless of quality

### Quality Score
Simple 0-1 score based on:
- Liquidity (+0.05 to +0.2)
- Holder count (+0.05 to +0.15)
- Volume (+0.05 to +0.15)
- Age penalty for <1 hour tokens (-0.1)

### Rate Limiting
- 5 minute cooldown between trades
- Maximum 6 trades per hour
- Trade recording for accurate rate tracking

## Decisions Made

- Position range 0.01-0.05 SOL keeps losses small while allowing frequent trading
- 5-15 minute time pressure window balances entertainment with not being too aggressive
- Quality score is intentionally simple - entertainment mode doesn't need deep analysis
- Hype detection requires BOTH volume AND holders to avoid wash trading

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added ENTERTAINMENT thresholds to TokenValidator**

- **Found during:** Task 2
- **Issue:** Adding ENTERTAINMENT to RiskProfile caused TypeScript errors in token-validator.ts where RiskProfile is used as object key
- **Fix:** Added ENTERTAINMENT values to liquidityThresholds, maxAgeMinutes, and minBuyPressure objects
- **Files modified:** src/trading/token-validator.ts
- **Commit:** 9caf949 (bundled with Task 2)

## Issues Encountered

Pre-existing TypeScript errors in `src/personality/commentary-system.ts` (missing exports from prompts.js) - not related to this plan.

## User Setup Required

None - EntertainmentMode is opt-in via configuration.

## Next Phase Readiness

- EntertainmentMode ready for integration with TradingLoop
- Can be enabled via `config.enabled = true`
- MoodSystem can be attached via `setMoodSystem()` method
- Ready for Plan 03: Streaming integration

---
*Phase: 04-personality-streaming*
*Completed: 2026-01-20*
