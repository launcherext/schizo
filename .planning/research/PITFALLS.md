# Domain Pitfalls: $SCHIZO AI Trading Agent

**Domain:** Solana AI trading agent (memecoin analysis, pump.fun integration, live streaming)
**Researched:** 2026-01-20
**Confidence:** HIGH (multiple authoritative sources cross-verified)

---

## Critical Pitfalls

Mistakes that cause catastrophic loss, security breaches, or complete rewrites.

---

### Pitfall 1: Private Key Exposure via Malicious Dependencies or Code Leaks

**What goes wrong:**
Private keys get exposed through malicious npm packages, compromised GitHub repos, or accidental commits. In July 2025, SlowMist documented a [malicious Solana trading bot](https://slowmist.medium.com/threat-intelligence-an-analysis-of-a-malicious-solana-open-source-trading-bot-ab580fd3cc89) that encoded private keys and POSTed them to attacker servers disguised as "Helius proxy" calls.

**Why it happens:**
- Copying code from untrusted GitHub repos
- Storing keys in `.env` files that get committed
- Using dependencies that phone home with secrets
- AI assistants (like ChatGPT) providing [poisoned API endpoints](https://cryptorank.io/news/feed/b57d8-solana-wallet-exploit-ai-poisoning-attack) that steal keys

**Consequences:**
- Complete wallet drain (one signature = full drain on Solana's SPL model)
- $87M+ drained from Solana wallets in Q2 2025 alone via user-approved malicious transactions
- No recovery possible once keys are compromised

**Prevention:**
1. NEVER use raw private keys in code - use policy-controlled wallets (e.g., Turnkey)
2. Create dedicated trading wallet with minimal funds (not main wallet)
3. Audit ALL dependencies before installation - especially anything touching wallets
4. Never trust AI-generated API endpoints without verification
5. Use `.gitignore` and secrets scanning in CI/CD
6. Consider multi-sig for any transaction above threshold

**Detection (Warning Signs):**
- Unexpected outbound network calls in bot code
- Dependencies with encoded strings that decode to URLs
- Any code that converts private keys to strings before network calls
- GitHub repos with suspiciously high stars but few real contributors

**Phase:** Address in Phase 1 (Foundation) - wallet architecture must be secure before any trading logic

---

### Pitfall 2: MEV Sandwich Attacks Draining Trade Profits

**What goes wrong:**
Your trades get front-run and back-run by MEV bots, extracting value on every swap. [Research shows](https://www.helius.dev/blog/solana-mev-report) $370-500M was extracted from Solana users over 16 months via sandwich attacks, with ~0.72% of all blocks containing sandwich activity.

**Why it happens:**
- Using public mempools without MEV protection
- Setting slippage tolerance too high (MEV bots exploit the full tolerance)
- Not using Jito bundles for atomic transactions
- Trading during high-congestion periods when MEV is most profitable

**Consequences:**
- 1% slippage tolerance becomes guaranteed 1% loss per trade
- Consistent profit leak that makes bot unprofitable
- "Wide sandwiching" increased from 1% to 30% of all sandwich attacks recently

**Prevention:**
1. Use [Jito bundles](https://www.helius.dev/blog/solana-mev-report) for atomic transaction submission
2. Route through MEV-protected endpoints (Jito block engines)
3. Implement dynamic slippage (Jupiter's approach) rather than fixed tolerance
4. Consider private transaction submission for large trades
5. Time trades to avoid peak MEV activity windows

**Detection (Warning Signs):**
- Consistently worse execution prices than quoted
- Transactions appearing in blocks with suspicious surrounding transactions
- Higher-than-expected slippage on every trade

**Phase:** Address in Phase 2 (Trade Execution) - MEV protection must be built into trade flow

---

### Pitfall 3: Helius Rate Limit Exhaustion During Critical Analysis

**What goes wrong:**
Rate limits hit during wallet forensics, causing incomplete analysis that leads to bad trading decisions. Helius Developer tier has [strict limits](https://www.helius.dev/docs/billing/rate-limits): 50 RPC req/s, 10 DAS/Enhanced API req/s, and crucially `getTransactionsForAddress` requires ONE request per address (no batching).

**Why it happens:**
- Analyzing multiple wallets simultaneously without throttling
- Not caching transaction history
- Polling too frequently for new transactions
- No backoff strategy when 429s occur

**Consequences:**
- HTTP 429 responses during critical analysis windows
- Missing real-time signals while rate-limited
- Incomplete wallet clustering (partial data = wrong conclusions)
- Paying for failed requests

**Prevention:**
1. Implement exponential backoff with jitter on 429s
2. Cache transaction history aggressively (transactions are immutable)
3. Use webhooks for real-time events instead of polling
4. Queue and throttle `getTransactionsForAddress` calls (max 10/s for DAS)
5. Prioritize analysis requests (active trades > background research)
6. Consider Business tier if hitting limits frequently

**Detection (Warning Signs):**
- Increasing 429 response rates in logs
- Analysis taking longer than expected
- Gaps in transaction history data

**Phase:** Address in Phase 1 (Foundation) - API client with rate limiting before any analysis code

---

### Pitfall 4: AI Hallucination Leading to Catastrophic Trades

**What goes wrong:**
Claude (or any LLM) hallucinates wallet analysis, fabricates token metadata, or makes confident but wrong trading decisions. [Documented cases](https://www.dlnews.com/articles/defi/ai-agents-are-terrible-at-trading-crypto-but-that-could-change/) show AI agents "completely gone off the rails" trading wrong assets, and "LLMs hallucinate pretty egregiously" in quantitative settings.

**Why it happens:**
- LLMs generate plausible-sounding but invented analysis
- No ground-truth verification of AI outputs before execution
- Overconfidence in AI "reasoning" without hard data
- Prompts that encourage speculation rather than data-driven decisions

**Consequences:**
- Trading based on fabricated wallet patterns
- Missing real rug pull signals while seeing phantom ones
- Catastrophic position sizing from hallucinated risk assessments
- A May 2025 flash crash saw AI bots sell $2B in 3 minutes due to inability to adapt

**Prevention:**
1. NEVER let AI directly execute trades - AI suggests, code verifies, then executes
2. Require on-chain data verification for every AI claim before acting
3. Implement "confidence thresholds" - low confidence = no trade
4. Log all AI reasoning for post-mortem analysis
5. Use structured output formats that force specific data citations
6. Create "sanity check" rules that override AI (max position size, max trades/hour)

**Detection (Warning Signs):**
- AI making claims about wallets without citing specific transactions
- Inconsistent analysis of the same wallet over time
- AI suggesting trades that violate basic rules (size limits, etc.)
- "Confident" analysis that contradicts on-chain data

**Phase:** Address in Phase 3 (AI Integration) - verification layer between AI and execution

---

### Pitfall 5: Rug Pull Detection Too Slow for Memecoin Speed

**What goes wrong:**
Analysis completes after the rug is already pulled. [98.6% of pump.fun tokens](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance) collapse into pump-and-dumps. By the time you've cross-referenced RugCheck, DEXScreener, and Bubblemaps, the price is already vertical-dropping.

**Why it happens:**
- Serial API calls instead of parallel analysis
- Waiting for "complete" analysis before acting
- Detection methods that sophisticated scammers evade (volume bots, wallet clustering obfuscation)
- Discord/Telegram alerts are minutes late

**Consequences:**
- Buying into tokens that rug within seconds of purchase
- Holding worthless tokens after "soft rug" (creator abandonment)
- Only 200 of 27,000+ daily pump.fun tokens graduate (<1% rate)

**Prevention:**
1. Implement tiered analysis: fast checks first, deeper analysis while position is small
2. Set hard time limits on analysis (if not confident in 5s, pass)
3. Watch for bundled buys, split wallets, hidden authority keys
4. Check for volume bot patterns (fake activity, wash trading)
5. Default to NOT trading - require high conviction to enter
6. Small position sizes that assume most trades are rugs

**Detection (Warning Signs):**
- New token with instant high volume but low unique wallets
- Creator wallet with history of abandoned tokens
- Bubblemaps showing wallet clusters despite appearing "clean"
- Social channels with bot-like engagement

**Phase:** Address in Phase 2 (Token Analysis) - speed-optimized pipeline with tiered checks

---

## Moderate Pitfalls

Mistakes that cause significant losses, technical debt, or major delays.

---

### Pitfall 6: Overtrading Eroding All Profits

**What goes wrong:**
Bot executes too many trades, with transaction costs and poor timing eroding gains. [Studies show](https://www.fortraders.com/blog/trading-bots-lose-money) most trading bots lose money, and overtrading in choppy markets is a primary cause.

**Why it happens:**
- No limits on trades per hour/day
- Treating every signal as actionable
- FOMO-driven entries on every new token
- Not accounting for transaction fees in P&L calculations

**Consequences:**
- Transaction costs eating profits (even 0.5% per trade adds up fast)
- Compounding mistakes - bots repeat the same error dozens of times
- Emotional/FOMO trading coded into the bot's behavior
- 35% portfolio loss in 24 hours from missing stop-loss (documented case)

**Prevention:**
1. Set hard limits: max trades per hour, max trades per day
2. Require minimum conviction threshold to enter
3. Track and display transaction costs in P&L
4. Implement "cooldown" periods after losses
5. Paper trade new strategies before real capital
6. Monthly bot audits: review trade logs, identify overtrading patterns

**Detection (Warning Signs):**
- High trade count but low/negative P&L
- Frequent small losses that sum to large drawdowns
- Trading activity doesn't correlate with actual opportunities

**Phase:** Address in Phase 2 (Trade Execution) - rate limiting and position management

---

### Pitfall 7: WebSocket Disconnections Causing Missed Signals or Duplicate Actions

**What goes wrong:**
Streaming connections drop, leading to missed real-time data or duplicate actions on reconnect. [Hume AI notes](https://dev.hume.ai/docs/expression-measurement/websocket) WebSocket streams disconnect every minute to release unused connections.

**Why it happens:**
- No reconnection logic
- Network instability not handled
- Serverless architectures (stateless, short timeouts = dropped connections)
- Not buffering messages during reconnection

**Consequences:**
- Missing critical price movements during disconnect
- Duplicate trades on reconnect if state isn't tracked
- Incomplete streaming to pump.fun (broken user experience)
- Lost context requiring full state rebuild

**Prevention:**
1. Implement automatic reconnection with exponential backoff
2. Buffer undelivered messages server-side
3. Use connection heartbeats (ping/pong) to detect dead connections
4. Track message sequence numbers to detect gaps
5. Use serverful architecture for WebSocket handlers (not serverless)
6. Consider SSE as simpler alternative for one-way streams

**Detection (Warning Signs):**
- Gaps in streaming data timestamps
- Duplicate entries in trade/action logs
- Users reporting choppy or broken streams

**Phase:** Address in Phase 4 (Streaming) - resilient connection handling

---

### Pitfall 8: Pump.fun Creator Fee Model Changes Breaking Revenue

**What goes wrong:**
Pump.fun's creator fee system has undergone [major overhauls](https://cryptonews.com/news/pump-fun-co-founder-says-fee-model-failed-announces-system-revamp/). The co-founder admitted Dynamic Fees V1 "failed to produce sustainable results." Automation built for old model breaks.

**Why it happens:**
- Hard-coding fee claiming logic to current API
- Not monitoring pump.fun announcements
- Assuming fee structure is stable

**Consequences:**
- Failed fee claims
- Missed revenue (fees remain claimable forever but might miss windows)
- Broken automation requiring rewrites

**Prevention:**
1. Abstract fee claiming behind interface that can be updated
2. Monitor pump.fun announcements and Discord
3. Handle API errors gracefully with fallback/retry
4. Don't depend on specific fee percentages in business logic
5. Use PumpPortal's API which abstracts some complexity

**Detection (Warning Signs):**
- Fee claiming transactions failing
- Lower-than-expected fee revenue
- New fee-related endpoints appearing in API

**Phase:** Address in Phase 2 (PumpPortal Integration) - flexible fee claiming module

---

### Pitfall 9: Wallet Analysis False Positives Causing Bad Trades

**What goes wrong:**
Wallet clustering is probabilistic. [False positives in detection](https://apopkachildacademy.com/tracking-wallets-on-solana-a-practical-guide-for-builders-and-power-users/) lead to bad trading decisions - flagging legitimate wallets as suspicious or missing actual bad actors.

**Why it happens:**
- Conflating PDAs (Program Derived Addresses) with wallets
- Overfitting on rare events (one action != pattern)
- Ignoring rent dynamics (account creation/closure fakes activity)
- Different explorers reporting different token decimals/balances

**Consequences:**
- Missing good trades due to false positive rug detection
- Entering bad trades due to false negative (missed rug signals)
- Incorrect wallet clustering leading to wrong conclusions

**Prevention:**
1. Treat automation as filter, not verdict - human-in-the-loop for major decisions
2. Filter out system program operations that create noise
3. Verify mint account directly for token decimals (don't trust explorers)
4. Require multiple signals before flagging wallet as suspicious
5. Build feedback loops to tune detection over time

**Detection (Warning Signs):**
- High rate of "suspicious" flags that don't result in actual rugs
- Missing rugs that had warning signs in retrospect
- Inconsistent analysis results for same wallet

**Phase:** Address in Phase 2 (Token Analysis) - calibrated detection with confidence scores

---

### Pitfall 10: No Position Sizing Limits Leading to Catastrophic Losses

**What goes wrong:**
Single trade wipes out significant capital. [Case studies show](https://coinbureau.com/guides/crypto-trading-bot-mistakes-to-avoid/) traders losing 35% of portfolio in 24 hours from single positions without stop-losses.

**Why it happens:**
- No max position size as percentage of portfolio
- No stop-loss protection
- No daily loss caps
- "Going all in" on high-conviction plays

**Consequences:**
- Single rug wipes out trading capital
- No capital left to recover
- Emotional decisions after big losses

**Prevention:**
1. Never risk more than 1-2% of capital per trade
2. Implement automatic stop-losses
3. Set daily loss caps that halt trading
4. Diversify across multiple positions
5. Keep majority of capital in separate "reserve" wallet

**Detection (Warning Signs):**
- Large percentage swings in portfolio value
- Single positions representing >10% of capital
- No stop-loss orders in place

**Phase:** Address in Phase 2 (Trade Execution) - risk management rules

---

## Minor Pitfalls

Mistakes that cause friction, delays, or suboptimal performance.

---

### Pitfall 11: Using Public RPCs for Trading

**What goes wrong:**
Public RPCs are rate-limited, deprioritized during congestion, and show stale data. [RPC Fast notes](https://rpcfast.com/blog/solana-trading-bot-guide) "if your bot is reading pool changes from a public RPC, you're already late."

**Prevention:**
- Use Helius (already planned) or other premium RPC
- Consider dedicated nodes for lowest latency
- Have fallback RPCs configured

**Phase:** Already addressed (Helius in stack)

---

### Pitfall 12: Streaming Personality Inconsistency

**What goes wrong:**
Claude's "paranoid degen" personality varies between responses, breaking character or being inconsistent.

**Prevention:**
- Strong system prompts with personality anchors
- Few-shot examples of desired tone
- Structured output format that constrains responses
- Test personality consistency before launch

**Phase:** Address in Phase 3 (AI Integration) - personality prompt engineering

---

### Pitfall 13: Not Logging Everything for Post-Mortems

**What goes wrong:**
When something goes wrong (and it will), you can't figure out why because there are no logs.

**Prevention:**
- Log every API call, response, and latency
- Log every AI decision with full reasoning
- Log every trade with entry rationale
- Structure logs for easy querying (JSON, indexed)
- Set up alerting on error rates

**Phase:** Address in Phase 1 (Foundation) - logging infrastructure

---

## Phase-Specific Warnings

| Phase | Likely Pitfall | Mitigation |
|-------|---------------|------------|
| Phase 1: Foundation | Private key exposure, rate limit mishandling | Secure wallet architecture (Turnkey-style), rate-limited API client with caching |
| Phase 2: Analysis & Trading | MEV attacks, overtrading, false positives, position sizing | Jito bundles, trade limits, calibrated detection, risk rules |
| Phase 3: AI Integration | Hallucination, personality inconsistency | Verification layer, strong prompts, structured outputs |
| Phase 4: Streaming | WebSocket disconnections, incomplete streams | Reconnection logic, message buffering, heartbeats |
| Phase 5: Fee Automation | API changes, failed claims | Abstracted interface, error handling, monitoring |

---

## SCHIZO-Specific Risk Summary

Given the project constraints:

| Constraint | Elevated Risk | Mitigation Priority |
|------------|--------------|---------------------|
| Helius Developer tier | Rate limits will be hit during active analysis | HIGH - cache aggressively, prioritize requests |
| Bootstrapped budget | Can't afford losses to MEV or bad trades | HIGH - MEV protection, strict position limits |
| Memecoin focus | 98%+ tokens are rugs | HIGH - default to NOT trading, fast detection |
| Ship fast | Temptation to skip security | CRITICAL - security first, ship second |
| Live streaming | Connection reliability | MEDIUM - resilient WebSocket handling |

---

## Sources

### Security & Wallet
- [SlowMist: Malicious Solana Trading Bot Analysis](https://slowmist.medium.com/threat-intelligence-an-analysis-of-a-malicious-solana-open-source-trading-bot-ab580fd3cc89)
- [Helius: How to Build a Secure AI Agent on Solana](https://www.helius.dev/blog/how-to-build-a-secure-ai-agent-on-solana)
- [CryptoRank: AI Poisoning Attack](https://cryptorank.io/news/feed/b57d8-solana-wallet-exploit-ai-poisoning-attack)
- [Web3IsGoingGreat: Solareum Drain Attacks](https://www.web3isgoinggreat.com/?id=solana-drain-attacks)

### MEV & Trade Execution
- [Helius: Solana MEV Report](https://www.helius.dev/blog/solana-mev-report)
- [Solana Compass: MEV Analysis](https://solanacompass.com/learn/accelerate-25/scale-or-die-at-accelerate-2025-the-state-of-solana-mev)
- [CryptoNinjas: Solana Slashes Sandwich Attacks](https://www.cryptoninjas.net/news/solana-slashes-500m-sandwich-attacks-as-75-of-sol-gets-staked-in-2025-security-overhaul/)

### API & Rate Limits
- [Helius: Rate Limits Documentation](https://www.helius.dev/docs/billing/rate-limits)
- [Chainstack: Helius RPC Overview](https://chainstack.com/helius-rpc-provider-a-practical-overview-2025/)

### AI Trading Risks
- [DL News: AI Agents Terrible at Trading](https://www.dlnews.com/articles/defi/ai-agents-are-terrible-at-trading-crypto-but-that-could-change/)
- [CFTC: AI Trading Bot Advisory](https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/AITradingBots.html)
- [CCN: Hidden Dangers of AI Crypto Trading](https://www.ccn.com/education/crypto/hidden-dangers-of-ai-crypto-trading/)

### Rug Pull Detection
- [Solidus Labs: Solana Rug Pulls Report](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance)
- [Flintr: Anatomy of a Rug Pull](https://www.flintr.io/articles/anatomy-of-a-rug-pull-identify-scams-on-pumpfun)
- [CoinDesk: Pump.fun Token Statistics](https://www.coindesk.com/business/2025/05/07/98-of-tokens-on-pump-fun-have-been-rug-pulls-or-an-act-of-fraud-new-report-says)

### Pump.fun & Creator Fees
- [CryptoNews: Pump.fun Fee Model Revamp](https://cryptonews.com/news/pump-fun-co-founder-says-fee-model-failed-announces-system-revamp/)
- [PumpPortal: Creator Fee Documentation](https://pumpportal.fun/creator-fee/)

### Trading Bot Best Practices
- [CoinCodeCap: Common Mistakes with Solana Bots](https://coincodecap.com/common-mistakes-to-avoid-with-solana-telegram-trading-bots)
- [CoinBureau: Trading Bot Mistakes to Avoid](https://coinbureau.com/guides/crypto-trading-bot-mistakes-to-avoid/)
- [3Commas: AI Trading Bot Risk Management](https://3commas.io/blog/ai-trading-bot-risk-management-guide-2025)

### Streaming & WebSockets
- [Liveblocks: AI Agents on WebSockets](https://liveblocks.io/blog/why-we-built-our-ai-agents-on-websockets-instead-of-http)
- [Ably: Resumable Token Streaming](https://ably.com/blog/token-streaming-for-ai-ux)
- [VideoSDK: WebSocket Troubleshooting](https://www.videosdk.live/developer-hub/websocket/websocket-connection-failed)
