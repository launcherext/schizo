# Trading Bot Flow - AI-Driven Entry System

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TRADING BOT FLOW                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │
│  │  PumpPortal  │───▶│   WATCHLIST  │───▶│  AI ANALYSIS │───▶│   TRADE   │ │
│  │   WebSocket  │    │  (Collect    │    │  (DDQN Agent │    │ EXECUTION │ │
│  │              │    │   Data)      │    │   Decision)  │    │           │ │
│  └──────────────┘    └──────────────┘    └──────────────┘    └───────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Detailed Flow

### 1. TOKEN DETECTION (PumpPortal WebSocket)

```
┌─────────────────────────────────────────────────────┐
│              NEW TOKEN DETECTED                      │
│                                                      │
│   PumpPortal WS ──▶ newToken event                  │
│        │                                            │
│        ▼                                            │
│   ┌─────────────────────────────────────┐          │
│   │ 1. Cache bonding curve data         │          │
│   │ 2. Subscribe to token trades        │          │
│   │ 3. Add to WATCHLIST                 │          │
│   │ 4. Record initial price point       │          │
│   └─────────────────────────────────────┘          │
│                                                      │
│   OLD: Immediate snipe attempt                      │
│   NEW: Start data collection                        │
└─────────────────────────────────────────────────────┘
```

### 2. DATA COLLECTION (Token Watchlist)

```
┌─────────────────────────────────────────────────────┐
│                    WATCHLIST                         │
│                                                      │
│   For each token, collect:                          │
│   ┌─────────────────────────────────────┐          │
│   │ • Price history (min 10 data points)│          │
│   │ • Trade data (buys/sells)           │          │
│   │ • Unique traders count              │          │
│   │ • Dev wallet activity               │          │
│   │ • Peak/lowest price                 │          │
│   └─────────────────────────────────────┘          │
│                                                      │
│   Status progression:                               │
│   COLLECTING ──▶ READY ──▶ ANALYZING ──▶ BOUGHT    │
│        │                        │                   │
│        └──────▶ REJECTED ◀──────┘                   │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### 3. HARD FILTERS (Instant Rejection)

```
┌─────────────────────────────────────────────────────┐
│                 HARD FILTERS                         │
│         (Check every 5 seconds)                     │
│                                                      │
│   ┌─────────────────┐                               │
│   │ Token Ready?    │                               │
│   └────────┬────────┘                               │
│            │                                        │
│            ▼                                        │
│   ┌─────────────────┐    NO     ┌───────────────┐  │
│   │ Dev sold?       │─────────▶ │ Skip/Wait     │  │
│   └────────┬────────┘           └───────────────┘  │
│            │ NO                                     │
│            ▼                                        │
│   ┌─────────────────┐    NO     ┌───────────────┐  │
│   │ 10+ data points?│─────────▶ │ Keep          │  │
│   └────────┬────────┘           │ Collecting    │  │
│            │ YES                └───────────────┘  │
│            ▼                                        │
│   ┌─────────────────┐    YES    ┌───────────────┐  │
│   │ >30% drawdown?  │─────────▶ │ REJECT        │  │
│   └────────┬────────┘           │ "Crashed"     │  │
│            │ NO                 └───────────────┘  │
│            ▼                                        │
│   ┌─────────────────┐                               │
│   │ PASS TO AI      │                               │
│   └─────────────────┘                               │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### 4. AI ANALYSIS (DDQN Agent)

```
┌─────────────────────────────────────────────────────┐
│                  AI ANALYSIS                         │
│                                                      │
│   Extract Features:                                 │
│   ┌─────────────────────────────────────┐          │
│   │ • Price momentum                     │          │
│   │ • Volatility                         │          │
│   │ • Drawdown from peak                 │          │
│   │ • Buy pressure (% buys vs sells)     │          │
│   │ • Volume trend                       │          │
│   │ • Token age                          │          │
│   │ • Unique traders                     │          │
│   │ • Rug score                          │          │
│   └─────────────────────────────────────┘          │
│                       │                             │
│                       ▼                             │
│   ┌─────────────────────────────────────┐          │
│   │        DDQN Agent Decision          │          │
│   │   ┌─────┐  ┌─────┐  ┌──────┐       │          │
│   │   │HOLD │  │ BUY │  │ SELL │       │          │
│   │   └─────┘  └─────┘  └──────┘       │          │
│   │      │        │                     │          │
│   │      │        ▼                     │          │
│   │      │   Confidence > 70%?          │          │
│   │      │        │                     │          │
│   │      ▼        ▼                     │          │
│   │   [SKIP]   [TRADE]                  │          │
│   └─────────────────────────────────────┘          │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### 5. TRADE EXECUTION

```
┌─────────────────────────────────────────────────────┐
│               TRADE EXECUTION                        │
│                                                      │
│   Pre-Trade Checks:                                 │
│   ┌─────────────────────────────────────┐          │
│   │ • Capital allocation check           │          │
│   │ • Max positions check                │          │
│   │ • Daily loss limit check             │          │
│   │ • Drawdown guard check               │          │
│   └─────────────────────────────────────┘          │
│                       │                             │
│                       ▼                             │
│   ┌─────────────────────────────────────┐          │
│   │        EXECUTE BUY                   │          │
│   │   • Route to PumpFun (bonding curve) │          │
│   │   • Or Jupiter (graduated)           │          │
│   │   • 15% slippage tolerance           │          │
│   └─────────────────────────────────────┘          │
│                       │                             │
│                       ▼                             │
│   ┌─────────────────────────────────────┐          │
│   │        OPEN POSITION                 │          │
│   │   • Set stop loss: -12%              │          │
│   │   • Track initial investment         │          │
│   │   • Start position monitoring        │          │
│   └─────────────────────────────────────┘          │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### 6. POSITION MANAGEMENT (New TP Strategy)

```
┌─────────────────────────────────────────────────────┐
│            POSITION MONITORING                       │
│              (Every 1 second)                       │
│                                                      │
│   ┌─────────────────────────────────────┐          │
│   │ 1. STOP LOSS CHECK (-12%)           │          │
│   │    If price drops 12% from entry    │          │
│   │    ──▶ CLOSE ALL (stop_loss)        │          │
│   └─────────────────────────────────────┘          │
│                       │                             │
│                       ▼                             │
│   ┌─────────────────────────────────────┐          │
│   │ 2. TRAILING STOP CHECK              │          │
│   │    If price below trailing stop     │          │
│   │    ──▶ CLOSE ALL (trailing_stop)    │          │
│   └─────────────────────────────────────┘          │
│                       │                             │
│                       ▼                             │
│   ┌─────────────────────────────────────┐          │
│   │ 3. INITIAL RECOVERY (+50%)          │          │
│   │    If profit >= 50% AND not yet     │          │
│   │    recovered initial:               │          │
│   │    ──▶ Sell enough to recover       │          │
│   │        initial investment           │          │
│   │    ──▶ Set 15% trailing stop        │          │
│   └─────────────────────────────────────┘          │
│                       │                             │
│                       ▼                             │
│   ┌─────────────────────────────────────┐          │
│   │ 4. SCALED EXITS (+50% intervals)    │          │
│   │    After initial recovered,         │          │
│   │    every +50% gain:                 │          │
│   │    ──▶ Sell 20% of remaining        │          │
│   │    ──▶ Update trailing stop         │          │
│   └─────────────────────────────────────┘          │
│                                                      │
└─────────────────────────────────────────────────────┘
```

## Take Profit Example

```
Entry: 0.01 SOL for 1,000,000 tokens

┌────────────────────────────────────────────────────────────────────────────┐
│  Price     │ Action                           │ Tokens Left │ SOL Out     │
├────────────────────────────────────────────────────────────────────────────┤
│  Entry     │ Buy 1M tokens for 0.01 SOL       │ 1,000,000   │ -0.01       │
│  +50%      │ Sell ~666K to recover 0.01 SOL   │   333,333   │  0.01       │
│            │ (Initial recovered!)              │             │             │
│  +100%     │ Sell 20% (66K) = 0.0133 SOL      │   266,667   │  0.0133     │
│  +150%     │ Sell 20% (53K) = 0.0133 SOL      │   213,333   │  0.0133     │
│  +200%     │ Sell 20% (43K) = 0.0172 SOL      │   170,667   │  0.0172     │
│  ...       │ Trailing stop hits at -15%       │      0      │  Rest       │
├────────────────────────────────────────────────────────────────────────────┤
│  TOTAL     │ Initial recovered + pure profit  │             │             │
└────────────────────────────────────────────────────────────────────────────┘
```

## Comparison: Old vs New

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        OLD SYSTEM                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   New Token ──▶ Velocity Check ──▶ Buy Immediately ──▶ Hope it pumps        │
│                                                                              │
│   Problems:                                                                  │
│   • Buying tokens with 0 track record                                       │
│   • 50% stop loss = massive losses                                          │
│   • Most tokens rug within 1 minute                                         │
│   • Take profit rarely triggers                                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        NEW SYSTEM                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   New Token ──▶ Watchlist ──▶ Collect Data ──▶ Hard Filters ──▶ AI ──▶ Buy  │
│                    │              │                │            │           │
│                    │              │                │            │           │
│              Track trades    10+ points      Dev sold?      High           │
│              Track price                     >30% crash?   confidence      │
│              Track dev                                                      │
│                                                                              │
│   Benefits:                                                                  │
│   • Only buy proven survivors                                               │
│   • 12% stop loss = smaller losses                                          │
│   • Dev dump = instant rejection                                            │
│   • Recover initial at +50%, then scale out                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Frontend Dashboard

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  TOKEN WATCHLIST                          [12 watching] [3 ready] [2 dev]   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ BONK...      [READY]                                        2m old  │   │
│  │ Price: +15.2%  Drawdown: -5.1%  Buy Pressure: 72%  Traders: 45     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ ABC123...    [COLLECTING]                                   30s old │   │
│  │ [======     ] 6/10 data points                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ RUGGED...    [REJECTED]                                      1m old │   │
│  │ Reason: Dev sold                                                    │   │
│  │ [! DEV SOLD]                                                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ CRASH...     [REJECTED]                                      3m old │   │
│  │ Reason: Crashed 45% from peak (max 30%)                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Parameters

| Parameter | Old Value | New Value | Reason |
|-----------|-----------|-----------|--------|
| Stop Loss | 50% | 12% | Smaller losses |
| Initial TP | 2x | +50% recover initial | Protect capital |
| Scaled TP | 25% at 2x, 3x | 20% every +50% | Ride winners |
| Trailing Stop | 20% | 15% | Tighter protection |
| Min Data Points | N/A | 10 | Prove token viability |
| Max Drawdown | N/A | 30% | Reject crashed tokens |
| Dev Sold | Not tracked | Instant reject | Avoid rugs |
