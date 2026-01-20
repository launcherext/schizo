# Project Research Summary

**Project:** $SCHIZO - Paranoid AI Trading Agent
**Domain:** Solana AI memecoin trading agent with personality streaming
**Researched:** 2026-01-20
**Confidence:** HIGH

## Executive Summary

$SCHIZO is a Solana-based autonomous trading agent that combines deep wallet forensics (via Helius), automated trade execution (via PumpPortal), and a distinctive paranoid degen personality (via Claude). The research confirms this is a well-defined niche: no existing product combines forensic analysis + live reasoning streams + aligned tokenomics (buyback loop). The stack is anchored on three proven APIs (Helius, PumpPortal, Anthropic) with TypeScript/Node.js providing the runtime foundation.

The recommended approach follows a multi-loop autonomous agent architecture: separate loops for fee claiming, wallet analysis, trading decisions, buybacks, and streaming commentary, all coordinated by a central orchestrator with persistent state. This separation is critical because memecoin trading requires both speed (sub-second execution) and depth (forensic analysis that takes longer). Claude serves as the decision engine only - it suggests trades but code validates and executes. This guardrail prevents hallucination-driven catastrophic losses.

The critical risks are: (1) private key exposure through malicious dependencies or code leaks, (2) MEV sandwich attacks draining trade profits, and (3) AI hallucination leading to bad trades. Mitigation requires secure wallet architecture from day one, Jito bundles for MEV protection, and a verification layer between Claude's decisions and actual execution. The memecoin reality is stark: 98.6% of pump.fun tokens collapse into pump-and-dumps, so the default posture must be NOT trading, with high conviction required to enter any position.

## Key Findings

### Recommended Stack

The stack optimizes for TypeScript-first development (type safety for financial operations), real-time streaming (WebSocket for market data and reasoning output), and minimal dependencies (security-critical for wallet operations).

**Core technologies:**
- **Node.js 22 LTS + TypeScript 5.5+:** Native .env support, async/await for agent loops, type safety for trading amounts
- **helius-sdk 2.0:** Rewritten for @solana/kit, provides getTransactionsForAddress (100 credits/call) and DAS API for forensic analysis
- **PumpPortal Local API:** Full signing control, 0.5% fees (vs 1% Lightning), required for "trust no one with my keys" paranoid approach
- **@anthropic-ai/sdk:** Official Claude SDK with streaming support for live reasoning
- **SQLite via better-sqlite3:** File-based persistent state, ACID compliant for financial data
- **Zod 4:** Required by Anthropic SDK for tool definitions, TypeScript-native validation

### Expected Features

**Must have (table stakes):**
- Fast trade execution (sub-second, not public RPCs)
- Jupiter/Raydium DEX integration
- Basic token safety checks (honeypot, LP lock, authorities)
- Position tracking with P&L
- Stop-loss / take-profit
- Transaction history via Helius

**Should have (differentiators - core competitive advantage):**
- Deep forensic wallet analysis (the paranoid personality IS this)
- Live reasoning stream to pump.fun chat
- Auto-claim pump.fun creator fees via PumpPortal
- Token buyback & burn loop (profits reinvested)
- Trust scores for tokens

**Defer (v2+):**
- Smart money pattern recognition (needs data collection first)
- Cross-chain support
- Social sentiment integration
- Community-verified intel features

### Architecture Approach

Multi-loop autonomous agent with event-driven coordination. Five primary loops: (1) Fee Claiming (every 3-5 min), (2) Analysis (every 15-30 min), (3) Trading (every 1-5 min or event-driven), (4) Buyback (every 30-60 min), (5) Streaming (event-driven). Central orchestrator manages shared state via SQLite. Claude is decision engine only - never direct executor.

**Major components:**
1. **Orchestrator** - Coordinates loops, manages state transitions, handles scheduling
2. **State Store (SQLite)** - Persists wallet state, positions, trade history, analysis cache
3. **Fee Claiming Loop** - Auto-claims pump.fun creator fees via PumpPortal
4. **Analysis Loop** - Forensic wallet analysis via Helius getTransactionsForAddress
5. **Trading Loop** - Claude suggests, code validates, PumpPortal executes
6. **Buyback Loop** - Takes profits, buys back $SCHIZO token
7. **Streaming Loop** - Pipes paranoid commentary to pump.fun chat

### Critical Pitfalls

1. **Private Key Exposure** - Use encrypted keystore, dedicated trading wallet with minimal funds, audit ALL dependencies. Never raw keys in code/env. Address in Phase 1.

2. **MEV Sandwich Attacks** - Use Jito bundles for atomic transactions, dynamic slippage (not fixed tolerance), route through MEV-protected endpoints. $370-500M extracted from Solana users over 16 months. Address in Phase 2.

3. **AI Hallucination** - Never let AI directly execute trades. Require on-chain data verification for every AI claim. Implement confidence thresholds and sanity check rules that override AI. Address in Phase 3.

4. **Helius Rate Limit Exhaustion** - Developer tier: 50 RPC req/s, 10 DAS/Enhanced API req/s. Cache aggressively (transactions are immutable), use webhooks instead of polling, implement exponential backoff. Address in Phase 1.

5. **Rug Pull Speed** - 98.6% of pump.fun tokens are rugs. Implement tiered analysis (fast checks first), set hard time limits (5s max), default to NOT trading. Address in Phase 2.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Foundation & Security
**Rationale:** Every component depends on secure wallet management and persistent state. Security must come before any trading logic. Helius rate limiting must be built into the API client from day one.
**Delivers:** Encrypted keystore, wallet manager, SQLite state store, rate-limited Helius client, structured logging
**Addresses:** Table stakes (wallet connection, transaction history)
**Avoids:** Private key exposure, rate limit exhaustion, state loss on restart

### Phase 2: Analysis & Token Safety
**Rationale:** Before trading anything, the agent needs forensic analysis capability. This IS the core differentiator (paranoid detective work).
**Delivers:** Forensic wallet analysis pipeline, token safety checks, trust score generation, PumpPortal WebSocket integration for market data
**Uses:** helius-sdk 2.0 (getTransactionsForAddress, getAssetsByOwner), Zod for validation
**Implements:** Analysis Loop with caching
**Avoids:** False positives from uncalibrated detection, missing rug signals

### Phase 3: Trading Execution
**Rationale:** With analysis in place, can now execute trades. Must include MEV protection and risk management rules from the start.
**Delivers:** PumpPortal Local API integration, trade execution with Jito bundles, position sizing limits, stop-loss/take-profit, overtrading prevention
**Uses:** PumpPortal Local Transaction API, Jupiter/Raydium routing
**Implements:** Trading Loop with validation layer
**Avoids:** MEV sandwich attacks, overtrading, catastrophic position losses

### Phase 4: AI Integration
**Rationale:** Claude integration comes after trading works manually. This ensures the verification layer is tested before AI makes decisions.
**Delivers:** Claude decision engine, paranoid personality prompts, structured output parsing, confidence thresholds
**Uses:** @anthropic-ai/sdk with streaming
**Implements:** Claude as advisor (not executor), verification layer
**Avoids:** AI hallucination leading to bad trades, personality inconsistency

### Phase 5: Economic Loop
**Rationale:** Tokenomics features (fee claiming, buybacks) can be added once core trading works.
**Delivers:** Auto-claim pump.fun creator fees, profit tracking, automated $SCHIZO buybacks, on-chain burn verification
**Uses:** PumpPortal fee claiming endpoint, Jupiter aggregator for buybacks
**Implements:** Fee Claiming Loop, Buyback Loop
**Avoids:** Pump.fun fee model changes breaking automation (abstract behind interface)

### Phase 6: Live Streaming
**Rationale:** Public interface is the final layer once everything else works reliably.
**Delivers:** pump.fun chat integration, live reasoning stream, paranoid commentary generation
**Uses:** pump.fun WebSocket (pump-chat-client)
**Implements:** Streaming Loop with reconnection logic
**Avoids:** WebSocket disconnections causing broken UX, rate limiting from spam

### Phase Ordering Rationale

- **Security before features:** Phase 1 establishes secure foundations. Trading without secure wallet architecture is catastrophic.
- **Analysis before trading:** Phase 2 before Phase 3 because the paranoid analysis IS the differentiation. Trading without analysis is just another bot.
- **Manual before AI:** Phase 3 before Phase 4 ensures trading execution works before AI makes decisions. AI amplifies both good and bad patterns.
- **Core before tokenomics:** Phases 1-4 before Phase 5 because fee claiming and buybacks are enhancement, not core functionality.
- **Streaming last:** Phase 6 is nice-to-have. Agent should work silently before going public.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 4 (AI Integration):** Prompt engineering for paranoid personality requires iteration. Verification layer patterns need validation.
- **Phase 6 (Streaming):** pump.fun chat API not fully documented. May need reverse engineering or community resources.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Foundation):** Well-documented. SQLite, encrypted keystores, rate limiting are established patterns.
- **Phase 3 (Trading):** PumpPortal documentation is comprehensive. Jupiter integration is standard.
- **Phase 5 (Economic Loop):** PumpPortal fee claiming is documented. Buyback execution is standard swap.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All technologies verified via official docs, npm, recent releases |
| Features | HIGH | Multiple sources confirm table stakes vs differentiators |
| Architecture | HIGH | Multi-loop agent pattern documented in multiple 2026 sources |
| Pitfalls | HIGH | Cross-verified with security reports, MEV studies, real incident analysis |

**Overall confidence:** HIGH

### Gaps to Address

- **pump.fun chat API specifics:** Limited public documentation. May need to inspect existing bots or contact PumpPortal.
- **Helius webhook setup for real-time analysis:** Documented but needs hands-on validation during Phase 2.
- **Personality consistency testing:** No established pattern for measuring Claude personality drift. Build feedback loop during Phase 4.
- **Fee model stability:** Pump.fun admitted Dynamic Fees V1 "failed." Monitor for changes during Phase 5.

## Sources

### Primary (HIGH confidence)
- [Helius SDK GitHub](https://github.com/helius-labs/helius-sdk) - SDK version, API methods
- [Helius getTransactionsForAddress Docs](https://www.helius.dev/docs/rpc/gettransactionsforaddress) - Rate limits, parameters
- [PumpPortal Trading API](https://pumpportal.fun/trading-api/) - Local vs Lightning API, fee claiming
- [PumpPortal WebSocket](https://pumpportal.fun/data-api/real-time/) - Real-time market data
- [Anthropic Client SDKs](https://docs.claude.com/en/api/client-sdks) - Streaming, tool use
- [Helius Rate Limits](https://www.helius.dev/docs/billing/rate-limits) - Request limits per tier

### Secondary (MEDIUM confidence)
- [Helius: Solana MEV Report](https://www.helius.dev/blog/solana-mev-report) - MEV statistics, Jito recommendations
- [SlowMist: Malicious Solana Trading Bot](https://slowmist.medium.com/threat-intelligence-an-analysis-of-a-malicious-solana-open-source-trading-bot-ab580fd3cc89) - Security threats
- [Solidus Labs: Solana Rug Pulls Report](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance) - 98.6% rug rate statistic
- [Anthropic: Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system) - Agent architecture patterns

### Tertiary (LOW confidence - needs validation)
- [DL News: AI Agents Trading](https://www.dlnews.com/articles/defi/ai-agents-are-terrible-at-trading-crypto-but-that-could-change/) - AI hallucination examples
- [CryptoNews: Pump.fun Fee Model Revamp](https://cryptonews.com/news/pump-fun-co-founder-says-fee-model-failed-announces-system-revamp/) - Fee model instability

---
*Research completed: 2026-01-20*
*Ready for roadmap: yes*
