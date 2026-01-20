# Architecture Patterns: Autonomous AI Trading Agent

**Domain:** Solana AI Memecoin Trading Agent ($SCHIZO)
**Researched:** 2026-01-20
**Overall Confidence:** HIGH (based on current 2026 ecosystem documentation)

---

## Executive Summary

This document defines the architecture for $SCHIZO, a paranoid AI trading agent on Solana. The system follows a **multi-loop autonomous agent architecture** with clear component boundaries, event-driven coordination, and Claude as the decision engine (not executor).

The architecture separates concerns into five primary loops (fee claiming, analysis, trading, buyback, streaming) coordinated by a central orchestrator with shared state. This follows 2026 best practices for agentic trading systems: specialized agents with clear responsibilities, stateful workflows, and policy-controlled execution.

---

## System Overview

```
+------------------------------------------------------------------+
|                        $SCHIZO AGENT                              |
+------------------------------------------------------------------+
|                                                                   |
|  +------------------+     +------------------+                    |
|  |   ORCHESTRATOR   |<--->|   STATE STORE    |                    |
|  |   (Main Loop)    |     |   (SQLite/JSON)  |                    |
|  +--------+---------+     +------------------+                    |
|           |                                                       |
|  +--------v---------+-----+-----+-----+-----+                     |
|  |                  |     |     |     |     |                     |
|  v                  v     v     v     v     v                     |
| +--------+  +--------+  +------+  +------+  +--------+            |
| |FEE LOOP|  |ANALYSIS|  |TRADE |  |BUYBACK|  |STREAM  |           |
| |        |  |LOOP    |  |LOOP  |  |LOOP   |  |LOOP    |           |
| +---+----+  +---+----+  +--+---+  +---+---+  +----+---+            |
|     |           |          |         |           |                |
+-----|-----------|----------|---------|-----------|----------------+
      |           |          |         |           |
      v           v          v         v           v
+----------+ +---------+ +---------+ +---------+ +----------+
|PumpPortal| | Helius  | |PumpPortal| |Jupiter/ | |pump.fun  |
|Fee API   | | API     | |Trade API | |Raydium  | |WebSocket |
+----------+ +---------+ +---------+ +---------+ +----------+
```

---

## Core Components

### 1. Orchestrator (Central Coordinator)

**Responsibility:** Coordinate all loops, manage shared state, handle scheduling

**Boundaries:**
- DOES: Schedule loop execution, manage state transitions, handle errors
- DOES NOT: Make trading decisions, execute transactions directly

```typescript
interface Orchestrator {
  // Loop scheduling
  startAllLoops(): Promise<void>;
  stopAllLoops(): Promise<void>;

  // State coordination
  getSharedState(): AgentState;
  updateState(partial: Partial<AgentState>): void;

  // Event coordination
  emit(event: AgentEvent): void;
  on(event: string, handler: EventHandler): void;
}
```

**Implementation Pattern:**
- Use `setInterval` with configurable intervals per loop
- Event emitter for cross-loop communication
- Centralized error handling with circuit breakers

### 2. State Store

**Responsibility:** Persist agent state between runs, track positions, history

**Data Model:**
```typescript
interface AgentState {
  // Wallet state
  wallet: {
    address: string;
    solBalance: number;
    tokenBalances: Map<string, number>;
    ownTokenBalance: number;  // $SCHIZO holdings
  };

  // Trading state
  positions: Position[];
  pendingOrders: Order[];
  tradeHistory: Trade[];

  // Analysis state
  watchlist: Token[];
  smartWallets: WalletProfile[];
  analysisCache: Map<string, TokenAnalysis>;

  // Fee state
  unclaimedFees: number;
  feeClaimHistory: FeeClaim[];

  // Agent state
  lastRunTime: Record<LoopName, Date>;
  paranoidMood: number;  // 0-100 for personality variance
  errors: ErrorLog[];
}
```

**Storage Recommendation:** SQLite via `better-sqlite3`
- File-based, no server needed
- ACID compliant for financial data
- Easy backup/restore
- JSON columns for complex objects

### 3. Fee Claiming Loop

**Responsibility:** Auto-claim pump.fun creator fees via PumpPortal

**Flow:**
```
[Timer: Every 3-5 min]
    |
    v
Check unclaimed fees (PumpPortal API)
    |
    v
Fees > threshold? ----NO----> Sleep
    |
   YES
    |
    v
Build claim transaction
    |
    v
Sign & submit via PumpPortal Lightning API
    |
    v
Update state: feeClaimHistory, wallet.solBalance
    |
    v
Emit event: FEE_CLAIMED
```

**External Dependencies:**
- PumpPortal Lightning Transaction API (fee claiming endpoint)
- Wallet keypair for signing

**Interval:** 3-5 minutes (matches FROZEN tool pattern)
**Threshold:** Configurable minimum SOL to justify gas

### 4. Analysis Loop

**Responsibility:** Find smart money, analyze tokens, build watchlist

**Flow:**
```
[Timer: Every 15-30 min]
    |
    v
Get new token launches (PumpPortal WebSocket or polling)
    |
    v
For each interesting token:
    |
    +---> Fetch holder wallets (Helius getAssetsByOwner)
    |
    +---> Analyze top holder history (Helius getTransactionsForAddress)
    |
    +---> Build wallet profiles (win rate, patterns)
    |
    v
Claude Decision: "Is this token interesting? Why?"
    |
    v
Add to watchlist with analysis
    |
    v
Emit event: TOKEN_ANALYZED
```

**Helius Integration:**
```typescript
interface HeliusClient {
  // Enhanced transaction parsing
  getTransactionsForAddress(
    address: string,
    options: { limit?: number; before?: string }
  ): Promise<EnhancedTransaction[]>;

  // Token holdings
  getAssetsByOwner(address: string): Promise<Asset[]>;

  // Real-time via WebSocket
  subscribeToAddress(address: string, callback: TxCallback): void;
}
```

**Claude Integration Point:**
- Input: Token data, holder profiles, on-chain metrics
- Output: Structured analysis with confidence score
- Personality: Paranoid/forensic commentary included

### 5. Trading Loop (Decision Engine)

**Responsibility:** Make buy/sell decisions, execute trades

**CRITICAL: Claude is Decision Engine, Not Executor**

```
[Timer: Every 1-5 min OR Event-driven]
    |
    v
Gather context:
  - Current positions
  - Watchlist tokens
  - Recent analysis
  - Portfolio state
  - Market conditions
    |
    v
Claude Decision: "What should I trade and why?"
    |
    v
Validate decision against rules:
  - Position size limits
  - Max portfolio exposure
  - Slippage tolerance
  - Blacklisted tokens
    |
    v
Valid? ----NO----> Log rejection, continue
    |
   YES
    |
    v
Build transaction (PumpPortal Local or Lightning API)
    |
    v
Simulate transaction (optional safety check)
    |
    v
Execute trade
    |
    v
Update state: positions, tradeHistory
    |
    v
Emit event: TRADE_EXECUTED
```

**Decision Engine Pattern:**
```typescript
interface TradingDecision {
  action: 'BUY' | 'SELL' | 'HOLD';
  token: string;
  amount: number;
  reasoning: string;        // Paranoid commentary
  confidence: number;       // 0-100
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
}

// Claude produces the decision
async function getTradeDecision(context: TradingContext): Promise<TradingDecision> {
  const prompt = buildTradingPrompt(context);
  const response = await claude.complete(prompt);
  return parseDecision(response);
}

// Orchestrator validates and executes
async function executeIfValid(decision: TradingDecision): Promise<void> {
  if (!validateAgainstRules(decision)) {
    log('Decision rejected by rules');
    return;
  }
  await executeTrade(decision);
}
```

### 6. Buyback Loop

**Responsibility:** Take profits from winning trades, buy back $SCHIZO token

**Flow:**
```
[Timer: Every 30-60 min OR on TRADE_EXECUTED event]
    |
    v
Calculate realized profits since last buyback
    |
    v
Profits > threshold? ----NO----> Sleep
    |
   YES
    |
    v
Calculate buyback amount (% of profits)
    |
    v
Execute $SCHIZO buy via Jupiter/Raydium
    |
    v
Update state: ownTokenBalance
    |
    v
Emit event: BUYBACK_EXECUTED
```

**Routing:**
- If $SCHIZO still on pump.fun bonding curve: Use PumpPortal
- If migrated to Raydium: Use Jupiter aggregator for best price

### 7. Streaming Loop (Commentary)

**Responsibility:** Stream live reasoning to pump.fun chat, build audience

**Flow:**
```
[Event-driven: On significant events]
    |
    v
Event received (TRADE_EXECUTED, TOKEN_ANALYZED, etc.)
    |
    v
Claude: Generate paranoid commentary
    |
    v
Format for pump.fun chat
    |
    v
Send via pump.fun WebSocket (pump-chat-client)
    |
    v
Log to streaming history
```

**Message Types:**
- Trade announcements with reasoning
- Analysis findings ("I found something suspicious...")
- Fee claims ("Another win for the cause")
- Buyback announcements ("Accumulating more")
- General paranoid observations

**Rate Limiting:** Avoid spam, target 1-3 messages per significant event

---

## Data Flow Diagram

```
                    EXTERNAL DATA SOURCES
                           |
    +----------------------+----------------------+
    |                      |                      |
    v                      v                      v
+--------+          +-----------+          +----------+
|Helius  |          |PumpPortal |          |pump.fun  |
|API     |          |API        |          |WebSocket |
+---+----+          +-----+-----+          +-----+----+
    |                     |                      |
    |  Wallet/Token Data  |  Trade/Fee Data      |  Chat/Events
    |                     |                      |
    +----------+----------+----------+-----------+
               |                     |
               v                     v
         +----------+          +-----------+
         | ANALYSIS |          |  TRADING  |
         |  LOOP    |          |   LOOP    |
         +----+-----+          +-----+-----+
              |                      |
              |    Findings          |   Decisions
              |                      |
              v                      v
         +--------------------------------+
         |         STATE STORE            |
         |  (Positions, History, Cache)   |
         +---------------+----------------+
                         |
                         | Context
                         v
         +--------------------------------+
         |           CLAUDE               |
         |    (Decision Engine Only)      |
         |  - Analyze tokens              |
         |  - Make trade decisions        |
         |  - Generate commentary         |
         +---------------+----------------+
                         |
                         | Decisions + Commentary
                         v
         +--------------------------------+
         |         ORCHESTRATOR           |
         |  - Validate decisions          |
         |  - Coordinate execution        |
         |  - Manage loops                |
         +---------------+----------------+
                         |
    +--------------------+--------------------+
    |                    |                    |
    v                    v                    v
+--------+         +-----------+        +----------+
|Execute |         |  Claim    |        | Stream   |
|Trades  |         |  Fees     |        | Chat     |
+--------+         +-----------+        +----------+
    |                    |                    |
    v                    v                    v
PumpPortal          PumpPortal          pump.fun
Trade API           Fee API             WebSocket
```

---

## Wallet & Key Management

### Security Architecture

**CRITICAL: Never store private keys in code or environment variables directly**

**Recommended Approach: Encrypted Keystore**

```typescript
interface KeyManager {
  // Load wallet from encrypted file
  loadWallet(password: string): Promise<Keypair>;

  // Sign transaction without exposing key
  signTransaction(tx: Transaction): Promise<SignedTransaction>;

  // Derive child wallets for separation
  deriveWallet(purpose: 'trading' | 'fees' | 'reserve'): Keypair;
}
```

**Multi-Wallet Strategy:**
1. **Hot Wallet (Trading):** Small balance, high frequency
2. **Fee Collection Wallet:** Receives pump.fun fees
3. **Reserve Wallet:** Larger holdings, cold storage

**Security Measures:**
- Encrypted keystore file (AES-256)
- Password required at startup (not stored)
- Transaction simulation before execution
- Maximum transaction size limits
- Daily/hourly spending limits
- Circuit breakers on unusual activity

**PumpPortal API Key Considerations:**
- PumpPortal generates linked wallet + API key
- Can use their managed wallet OR your own via Local API
- For maximum control: Use Local Transaction API with own wallet

---

## Claude Integration Points

### 1. Analysis Reasoning

```typescript
const analysisPrompt = `
You are $SCHIZO, a paranoid AI trading agent analyzing Solana memecoins.

Analyze this token and its holders:
${JSON.stringify(tokenData)}

Top holder wallet histories:
${JSON.stringify(holderAnalysis)}

Provide your analysis in this format:
- VERDICT: INTERESTING / SUSPICIOUS / SKIP
- CONFIDENCE: 0-100
- REASONING: Your paranoid forensic analysis
- KEY_FINDINGS: Bullet points
- RED_FLAGS: Any concerns
- SMART_MONEY_PRESENT: true/false
`;
```

### 2. Trading Decisions

```typescript
const tradingPrompt = `
You are $SCHIZO making trading decisions.

Current portfolio:
${JSON.stringify(portfolio)}

Watchlist with analysis:
${JSON.stringify(watchlist)}

Recent market activity:
${JSON.stringify(recentActivity)}

Decide what to do. Format:
- ACTION: BUY / SELL / HOLD
- TOKEN: (if action is BUY/SELL)
- AMOUNT: SOL amount or percentage
- REASONING: Why (paranoid style)
- CONFIDENCE: 0-100
- URGENCY: LOW / MEDIUM / HIGH
`;
```

### 3. Commentary Generation

```typescript
const commentaryPrompt = `
You are $SCHIZO streaming your thoughts to pump.fun chat.

Event: ${eventType}
Details: ${JSON.stringify(eventData)}

Generate a short, paranoid, entertaining comment (max 280 chars).
Stay in character: suspicious, forensic, degen, but insightful.
`;
```

---

## Build Order (Dependency-Aware)

### Phase 1: Foundation
1. **State Store** - Everything depends on persistent state
2. **Wallet/Key Manager** - Required for any on-chain action
3. **Basic Orchestrator** - Coordinate even simple loops

### Phase 2: Core Loops
4. **Fee Claiming Loop** - Simplest loop, immediate value
5. **Basic Trading Loop** - Manual trades, no AI yet

### Phase 3: Intelligence
6. **Helius Integration** - Required for analysis
7. **Analysis Loop** - Build watchlist
8. **Claude Integration** - Add AI decision making

### Phase 4: Automation
9. **AI-Driven Trading** - Connect Claude to trading loop
10. **Buyback Loop** - Profit management

### Phase 5: Public Interface
11. **Streaming Loop** - pump.fun chat integration
12. **Commentary System** - Personality layer

### Build Order Rationale:
- State Store first: Every component reads/writes state
- Wallet second: Can't do anything on-chain without it
- Fee claiming before trading: Lower risk, proves integrations work
- Analysis before AI trading: Need data to make decisions
- Streaming last: Nice-to-have, not critical path

---

## Anti-Patterns to Avoid

### 1. Claude as Direct Executor
**BAD:** Claude generates and sends transactions
**GOOD:** Claude decides, orchestrator validates and executes

### 2. Monolithic Loop
**BAD:** Single loop handling fees, analysis, trading, streaming
**GOOD:** Separate loops with clear responsibilities

### 3. Synchronous Everything
**BAD:** Each loop blocks waiting for the previous
**GOOD:** Independent loops with event-driven coordination

### 4. State in Memory Only
**BAD:** Lose all state on restart
**GOOD:** Persistent state store, resume from last known state

### 5. Hardcoded Intervals
**BAD:** Fixed timing regardless of conditions
**GOOD:** Configurable intervals, event-driven triggers

### 6. No Circuit Breakers
**BAD:** Keep trading during errors/anomalies
**GOOD:** Pause on repeated failures, unusual market conditions

---

## Scalability Considerations

| Scale | Approach |
|-------|----------|
| Single agent | SQLite, in-process loops, single wallet |
| Multiple tokens | Same architecture, parallel analysis |
| High frequency | Consider Redis for state, dedicated RPC |
| Multi-agent | Separate instances, shared observation layer |

---

## Technology Stack Alignment

| Component | Recommended Tech |
|-----------|------------------|
| Runtime | Node.js 20+ / TypeScript |
| State Store | SQLite via better-sqlite3 |
| Scheduling | setInterval + event emitter |
| HTTP Client | axios or fetch |
| WebSocket | ws library |
| Solana | @solana/web3.js |
| Claude | Anthropic SDK |
| Helius | @helius-labs/helius-sdk |
| PumpPortal | REST API (no SDK, use fetch) |

---

## Sources

### Trading System Architecture
- [Trading System Architecture: From Microservices to Agentic Mesh](https://www.tuvoc.com/blog/trading-system-architecture-microservices-agentic-mesh/)
- [Building an Agentic AI Trading System from End to End](https://medium.com/predict/building-an-agentic-ai-trading-system-from-end-to-end-0fbc0a95b2e2)
- [The canonical agent architecture: A while loop with tools](https://www.braintrust.dev/blog/agent-while-loop)

### Solana Trading Bots
- [Solana Trading Bots Guide (2026 Edition)](https://rpcfast.com/blog/solana-trading-bot-guide)
- [How to Build a Secure AI Agent on Solana](https://www.helius.dev/blog/how-to-build-a-secure-ai-agent-on-solana)
- [Top 10 Solana Sniper Bots in 2026](https://www.quicknode.com/builders-guide/best/top-10-solana-sniper-bots)

### PumpPortal Integration
- [PumpPortal Trading API Docs](https://pumpportal.fun/trading-api/)
- [Claiming Token Creator Fees](https://pumpportal.fun/creator-fee/)
- [PumpPortal Lightning Transaction API](https://pumpportal.fun/trading-api/)

### Helius API
- [Solana Enhanced Transactions API](https://www.helius.dev/docs/enhanced-transactions)
- [Helius SDK on GitHub](https://github.com/helius-labs/helius-sdk)

### State Management
- [Crypto Trading Bot Architecture and Roadmap](https://vitalii-honchar.medium.com/crypto-trading-bot-architecture-and-roadmap-f3e26cf9956a)
- [High-frequency crypto trading bot architecture](https://medium.com/@kb.pcre/high-frequency-crypto-trading-bot-architecture-part-1-48b880bfc85f)

### Claude/LLM Integration
- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Deep Agents - LangChain](https://www.blog.langchain.com/deep-agents/)
- [Letta Agent Loop Architecture](https://www.letta.com/blog/letta-v1-agent)
