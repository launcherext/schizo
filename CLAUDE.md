# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev          # Run with ts-node
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled code (dist/index.js)

# Testing & Linting
npm test             # Run Jest tests
npm run lint         # ESLint on src/**/*.ts

# Single test file
npx jest path/to/test.ts
```

## Environment

- Requires Node.js >=20.0.0
- Copy `.env.example` to `.env` and configure
- PostgreSQL database (Railway: `postgresql://postgres:NajctWeCLYaSywSNHKxkWElcSbTsDSPc@caboose.proxy.rlwy.net:58182/railway`)
- Dashboard runs on port 3500

## Architecture

This is a Solana trading bot with a layered architecture:

```
src/
├── index.ts              # TradingBot orchestrator - main entry point
├── config/settings.ts    # All configuration and trading parameters
├── data/                 # Data ingestion layer
│   ├── helius-ws.ts      # WebSocket for new token detection
│   ├── price-feed.ts     # Price data from DexScreener
│   └── whale-tracker.ts  # Track whale wallet activity
├── signals/              # Signal processing layer
│   ├── feature-extractor.ts  # Extract StateVector features
│   ├── pump-detector.ts      # Analyze pump phases/heat
│   └── rug-detector.ts       # Safety scoring (mint auth, freeze, LP, concentration)
├── ai/                   # AI decision layer
│   ├── ddqn-agent.ts     # Double DQN for action selection
│   ├── regime-detector.ts    # Market regime classification
│   └── position-sizer.ts     # Dynamic position sizing
├── execution/            # Trade execution layer
│   ├── tx-manager.ts     # Transaction orchestration
│   ├── jupiter-swap.ts   # Jupiter DEX aggregator
│   └── jito-bundle.ts    # Jito MEV protection
├── risk/                 # Risk management layer
│   ├── position-manager.ts   # Track positions, TP/SL
│   ├── capital-allocator.ts  # Reserve/active/high-risk pools
│   └── drawdown-guard.ts     # Daily loss limits, trading pause
├── learning/             # Online learning layer
│   ├── trade-logger.ts   # Log entries/exits to DB
│   ├── performance.ts    # Calculate metrics (Sharpe, win rate)
│   └── model-trainer.ts  # Retrain DDQN from experience
├── api/                  # Dashboard API
│   ├── server.ts         # Express + Socket.IO on port 3500
│   ├── routes.ts         # REST endpoints
│   └── websocket.ts      # Real-time updates
└── db/                   # Database layer
    ├── schema.ts         # PostgreSQL table definitions
    └── repository.ts     # Data access methods
```

## Data Flow

1. `heliusWs` detects new tokens → queued in TradingBot
2. Token passes through filters: `rugDetector.isSafe()` → `pumpDetector.isGoodEntry()`
3. `featureExtractor.extractFeatures()` creates StateVector
4. `ddqnAgent.selectAction()` returns BUY/HOLD/SELL
5. `capitalAllocator.checkRisk()` validates position size
6. `txManager.executeBuy()` via Jupiter/Jito
7. `positionManager` tracks position with TP levels and trailing stop
8. On close: `tradeLogger.logExit()` → `modelTrainer.addTradeExperience()`

## Key Types

- `StateVector` (signals/types.ts): 16-dimensional feature vector for AI
  - Original 12: priceChange1m/5m, volumeZScore, buySellRatio, holderCount, top10Concentration, mintRevoked, freezeRevoked, lpLocked, ageMinutes, tradeIntensity, marketCapSol
  - New 4: drawdownFromPeak, volatility, uniqueTraders, volumeTrend
- `RugScore` (signals/types.ts): Safety scoring breakdown
- `PumpMetrics` (signals/types.ts): Pump phase, heat, buy pressure
- `AIDecision` (ai/types.ts): Action, confidence, regime, position size
- `Position` (risk/types.ts): Open position with TP/SL tracking

## Configuration

All trading parameters in `config/settings.ts`:
- Capital allocation: 40% reserve, 40% active, 20% high-risk
- Risk: 12% stop loss, +50% initial recovery (sell to recover cost), 15% trailing stop
- Filters: minRugScore=45, minLiquiditySol=1, minDataPoints=10, maxDrawdown=30%
- DDQN: 16 state dims, 3 actions, epsilon-greedy exploration
- Watchlist: AI-driven entry with dynamic confidence (55-70% based on age)

## Deployment

Railway deploys automatically on git push. The Procfile runs `npm start` as a worker process.
