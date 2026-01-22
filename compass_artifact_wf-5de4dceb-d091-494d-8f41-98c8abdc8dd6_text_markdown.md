# Building an AI Trading Bot on Solana: APIs, Repos, and Strategy

**Only 0.4% of Pump.fun traders profit over $10,000**—that sobering statistic from on-chain analysis sets the context for this guide. The Solana meme coin ecosystem generates extraordinary stories (2 SOL to $1 million in 3 hours has happened), but 60-90% of traders lose money. This comprehensive guide provides the technical infrastructure to build an AI trading bot while acknowledging the brutal statistical reality. If you proceed, you'll do so with working code, real APIs, and proven risk management—not false hope.

---

## Part 1: Free Solana APIs and endpoints

The Solana ecosystem offers surprisingly robust free API access. These endpoints form the data and execution backbone for any trading bot.

### RPC providers with free tiers

| Provider | Free Tier | Rate Limit | Endpoint Format |
|----------|-----------|------------|-----------------|
| **Helius** | 1M credits/month | 10 RPS | `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY` |
| **QuickNode** | 10M credits | 15 RPS | Custom endpoint after signup |
| **dRPC** | Unlimited basic | No strict limit | `https://solana.drpc.org` |
| **Chainstack** | Free tier | Geo-balanced | Custom after signup |
| **Alchemy** | Limited free | Rate-limited | `https://solana-mainnet.g.alchemy.com/v2/:apiKey` |

The official Solana public RPC (`https://api.mainnet.solana.com`) exists but **should never be used for production trading**—it's rate-limited to 100 requests per 10 seconds and can block your IP without notice. Helius offers the best free balance of speed and reliability, with WebSocket support at `wss://atlas-mainnet.helius-rpc.com/?api-key=YOUR_KEY`.

### DEX and swap APIs (all free, no authentication required)

**Jupiter Aggregator** dominates Solana DeFi with >90% of aggregator volume. Their API requires no authentication and provides optimal swap routing:

```javascript
// Jupiter Quote API (FREE)
const quote = await fetch(
  'https://api.jup.ag/v6/quote?' + 
  'inputMint=So11111111111111111111111111111111111111112&' +  // SOL
  'outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&' + // USDC
  'amount=1000000'  // 0.001 SOL in lamports
);

// Jupiter Swap Execution
const swap = await fetch('https://api.jup.ag/v6/swap', {
  method: 'POST',
  body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet })
});
```

**Raydium V3 API** provides direct pool access without aggregation overhead:
- Base URL: `https://api-v3.raydium.io/`
- Pool list: `/pools/info/list`
- Token data: `https://api.raydium.io/v2/sdk/token/solana.mainnet.json`
- Full documentation at `https://api-v3.raydium.io/docs/`

**Orca Whirlpools** concentrated liquidity pools use their TypeScript SDK (`@orca-so/whirlpools`) rather than REST endpoints—install via npm for programmatic access.

### Token data and price APIs

**DexScreener** offers the most generous free tier with no API key required:
- Search pairs: `GET https://api.dexscreener.com/latest/dex/search?q={query}`
- Token pairs: `GET https://api.dexscreener.com/token-pairs/v1/solana/{tokenAddress}`
- Boosted/trending: `GET https://api.dexscreener.com/token-boosts/top/v1`
- Rate limit: **300 requests/minute**

**Birdeye** requires a free API key but limits free tier to token price and token list endpoints only (30,000 credits/month). Premium features (OHLCV, trade data, WebSocket streaming) require paid plans starting at $49/month.

**GeckoTerminal** (CoinGecko's on-chain arm) provides free OHLCV data across 250+ networks without authentication: `https://api.geckoterminal.com/api/v2/`

### Specialized infrastructure APIs

**Jito Bundles** for MEV protection is technically free—you only pay tips (minimum **1,000 lamports** or 0.000001 SOL) for atomic transaction execution. This protects against sandwich attacks and ensures transaction ordering:

```python
# Jito bundle submission pattern
from jito_sdk import JitoClient

client = JitoClient()
bundle = [swap_transaction, take_profit_transaction]
result = await client.send_bundle(bundle, tip_lamports=10000)
```

**Pump.fun** has no official API, but community documentation exists at `github.com/BankkRoll/pumpfun-apis`. Most bots monitor launches via Solana's `logsSubscribe` WebSocket rather than HTTP endpoints. Bitquery offers GraphQL subscriptions for Pump.fun events if you need structured data.

---

## Part 2: GitHub repositories worth using

After reviewing dozens of repositories, these represent the most actively maintained, functional codebases as of January 2025.

### The essential starting point: chainstacklabs/pumpfun-bonkfun-bot

This Python-based bot (**874 stars, actively maintained**) represents the most production-ready open-source implementation for meme coin trading:

```
GitHub: github.com/chainstacklabs/pumpfun-bonkfun-bot
Language: Python 100%
License: Apache-2.0
Features:
- New token sniping via logsSubscribe and blockSubscribe
- Bonding curve tracking and PumpSwap migration listening
- Take profit/stop loss automation
- Dynamic priority fees
- Geyser gRPC integration for low-latency data
```

The repository includes excellent documentation with full walkthrough tutorials at docs.chainstack.com.

### Trading infrastructure repositories

| Repository | Purpose | Language | Best For |
|------------|---------|----------|----------|
| **warp-id/solana-trading-bot** | Automated trading with pool burn detection, mint checks | TypeScript | Full trading automation |
| **outsmartchad/solana-trading-cli** | High-performance library supporting Raydium, Orca, Meteora, Pump.fun | TypeScript | Building custom strategies |
| **ARBProtocol/solana-jupiter-bot** | Arbitrage with config wizard and CLI dashboard | JavaScript | Cross-DEX arbitrage |
| **fdundjer/solana-sniper-bot** | Raydium pool sniping with Jito executors | TypeScript | New pool sniping |
| **DracoR22/handi-cat_wallet-tracker** | Telegram bot for real-time wallet tracking | TypeScript | Copy trading infrastructure |

### AI/ML integration toolkit

**sendaifun/solana-agent-kit** stands out as the most comprehensive AI integration framework, connecting any AI agent to 60+ Solana actions with LangChain/LangGraph integration. The Python version (`solana-agent-kit-py`) is available for those preferring Python over TypeScript.

For reinforcement learning specifically, **sadighian/crypto-rl** provides a complete toolkit including data recording, Gym environments, and DDQN training pipelines designed for limit order book data.

### Essential SDKs you'll need

```bash
# JavaScript/TypeScript
npm install @solana/web3.js @raydium-io/raydium-sdk-v2 @orca-so/whirlpools

# Python
pip install solana solders
```

The official **raydium-io/raydium-sdk-V2** and **jup-ag/jupiter-swap-api-client** repositories provide the canonical implementations for DEX interactions.

---

## Part 3: Strategy framework for 1 SOL to 100 SOL

The math requires a **100x return**—achievable in theory but statistically improbable. Only 293 wallets (0.00217% of 13.55 million) have made over $1 million on Pump.fun. Your strategy must acknowledge this reality while optimizing for the slim possibility of success.

### Realistic pathways and their odds

**Meme coin sniping** offers the highest potential returns but worst odds. The bonding curve mechanics of Pump.fun mean earliest buyers get exponentially better prices—but **98.6% of tokens collapse** into pump-and-dump schemes, and only **1.29% graduate to Raydium**.

Successful snipers use three detection methods:
1. **Twitter/X scraping** for contract addresses dropped by non-crypto influencers
2. **On-chain monitoring** of developer wallets with successful launch histories
3. **Volume/social velocity tracking** for narrative breaks (AI themes, political events)

**Copy trading** successful wallets provides learning opportunities but faces structural problems: by the time you execute, price has moved; "farmer wallets" deliberately exploit copiers by making initial buys, waiting for copy volume, then dumping.

**DEX arbitrage** with 1 SOL is **not viable**—the technical infrastructure costs and competition from professional MEV bots eliminate any edge small capital might have.

### Position sizing that survives losing streaks

With 1 SOL (~$150-250 at recent prices), the Kelly Criterion suggests risking **1-5% per trade** (0.01-0.05 SOL) to survive the inevitable losing streaks. A practical framework:

```
Core reserve (40%): 0.4 SOL - Never trade, provides recovery capital
Active trading (40%): 0.4 SOL - Split across 3-5 positions max
High-risk allocation (20%): 0.2 SOL - Meme coin/speculative plays
```

This structure allows approximately **20-40 learning trades** before depletion, assuming average losses of 50% per failed trade.

### Entry and exit discipline

**Entry signals worth acting on:**
- Volume spike >200% in short timeframe with price confirmation
- Whale accumulation visible on Solscan (large wallets buying)
- Locked liquidity + revoked mint authority (verifiable via RugCheck.xyz)
- Top 10 holders controlling <30% of supply

**Exit strategy that captures gains:**
Most meme coins die within 30 seconds to 24 hours. The staged exit approach protects profits:
- At **2x**: Sell 25% (recover partial initial)
- At **3x**: Sell 25% (guarantee profit)
- Remaining **50%**: Trail with 15-20% stop loss

### Pre-trade rug pull checklist

Before every entry, verify:
- [ ] Liquidity locked (check GeckoTerminal, RugCheck.xyz)
- [ ] Mint authority revoked (prevents infinite token creation)
- [ ] Freeze authority revoked (prevents wallet freezing)
- [ ] No bundled buys at launch (coordinated manipulation)
- [ ] Developer wallet has no rug pull history
- [ ] Top 10 holders <30% of supply

---

## Part 4: AI/ML component architecture

Machine learning adds value primarily through **risk management and pattern recognition**—not price prediction. Markets are too efficient for simple ML models to consistently predict direction.

### Reinforcement learning implementation

The RL paradigm fits trading naturally: the agent receives market state, takes actions (buy/sell/hold), and receives rewards (PnL). Research shows **DDQN with Sharpe ratio as reward function** outperforms other Q-learning variants.

```python
import gym
import numpy as np
from stable_baselines3 import DQN

# State representation
state = np.array([
    unrealized_pnl,
    available_cash / initial_capital,  # Normalized
    current_position,
    rsi_14,
    volume_relative_to_average,
    price_relative_to_ema_20
])

# Action space: Discrete (0=hold, 1=buy, 2=sell)
env = TradingEnv(state_shape=(6,), action_space=3)
model = DQN('MlpPolicy', env, verbose=1)
model.learn(total_timesteps=100000)
```

The critical insight from research: **even with limited prediction ability, RL agents can react to market changes** rather than predict them—a more tractable problem.

### Sentiment analysis that provides signal

Twitter sentiment correlates with trading volume and short-term volatility. A practical implementation using VADER:

```python
from nltk.sentiment.vader import SentimentIntensityAnalyzer

sia = SentimentIntensityAnalyzer()

def get_sentiment_signal(tweets: list) -> str:
    scores = [sia.polarity_scores(t)['compound'] for t in tweets]
    avg = sum(scores) / len(scores) if scores else 0
    
    if avg > 0.05: return 'bullish'
    elif avg < -0.05: return 'bearish'
    return 'neutral'
```

For crypto-specific accuracy, fine-tuned models like **CryptoBERT** achieve 83.5% classification accuracy versus VADER's ~70%. However, sentiment works best as an **additional signal**, not primary—combining it with price/volume data improves forecasts by approximately 20%.

### Pump detection algorithm

Z-score based anomaly detection correctly identifies pump-and-dump targets **55.81% of the time** (top 5 ranking). The key features:

```python
def calculate_pump_score(token_data):
    return {
        'price_z': (current_price - rolling_mean) / rolling_std,
        'volume_z': (volume - avg_volume) / volume_std,
        'order_imbalance': bid_volume / ask_volume,
        'trade_intensity': trades_per_minute / avg_trades
    }
    
# Alert threshold: combined z-score > 3
```

For real-time implementation, Random Forest achieves **94.5% F1-score** detecting pump-and-dump events within 25 seconds of start—potentially actionable for exit timing.

### Market regime detection

Hidden Markov Models effectively identify volatility regimes (high/low/crash), enabling dynamic position sizing:

```python
from hmmlearn import hmm

model = hmm.GaussianHMM(n_components=3, covariance_type='full')
model.fit(returns.reshape(-1, 1))

# Regime interpretation
# 0: Low volatility → Trade normally
# 1: High volatility → Reduce position sizes 50%
# 2: Crash regime → Exit positions or short
```

---

## Part 5: What real traders experienced

On-chain data reveals the uncomfortable truth about meme coin trading outcomes.

### The statistical reality

From **13.55 million wallet addresses** that traded on Pump.fun:
- **60% lost money** (Dune Analytics, May 2025)
- **88% either lost money or made less than $100**
- Only **55,296 wallets (0.4%)** profited over $10,000
- Only **293 wallets (0.00217%)** made over $1 million
- **1,700 wallets** lost more than $100,000

The Solana meme coin market follows severe power law distribution—a tiny fraction captures nearly all profits while the majority provides exit liquidity.

### Patterns from successful traders

The rare winners share common characteristics:
1. **Extreme speed**: Using sniping bots (Trojan, BONKbot) for sub-second entry after launch
2. **Early profit-taking**: Selling 50% at 2x to guarantee return of initial capital
3. **Smart money following**: Identifying and tracking profitable wallets via KOLSCAN and Dune Analytics
4. **Small, frequent bets**: Risking 0.5-2 SOL per trade across many opportunities

One documented case: a trader turned **2 SOL into $1 million in 3 hours** during the Gen Z Quant controversy—a 2,141x return representing the extreme right tail of outcomes.

### Common failure patterns

Trader losses cluster around predictable mistakes:
- **FOMO entry after pump**: By the time retail notices, insiders have already bought
- **Holding through reversal**: "Diamond hands" mentality turning gains into losses
- **Copying compromised wallets**: "Farmer wallets" deliberately exploit copy traders
- **Ignoring rug pull signals**: Anonymous teams, unlocked liquidity, concentrated holdings

A crypto influencer publicly shared losing **nearly $1 million** to meme coins after "greed kicked in and I used only max leverage. Left with 460 bucks."

---

## Complete implementation roadmap

### Week 1-2: Infrastructure setup

```bash
# 1. Create dedicated trading wallet (never use main wallet)
# 2. Fund with test amount (0.1 SOL to start)
# 3. Set up development environment

pip install solana solders pandas numpy scikit-learn
npm install @solana/web3.js @raydium-io/raydium-sdk-v2

# 4. Get free API keys
# - Helius: helius.dev
# - Birdeye: birdeye.so (limited free tier)

# 5. Clone reference implementation
git clone https://github.com/chainstacklabs/pumpfun-bonkfun-bot
```

### Week 3-4: Data collection and backtesting

Build your training dataset before deploying capital:
- Collect 3+ months of OHLCV data via GeckoTerminal API
- Scrape Twitter for token mentions (sentiment baseline)
- Record Pump.fun launches and outcomes (graduation rate, price action)
- Implement basic backtesting with `backtesting.py` library

### Month 2: Paper trading and validation

Run the bot in simulation mode:
- Execute 50+ paper trades across different market conditions
- Track win rate, average gain, average loss, maximum drawdown
- Validate that the strategy survives walk-forward testing (not just in-sample)

### Month 3+: Gradual live deployment

Begin with minimal capital (0.1-0.2 SOL):
- Execute real trades with 0.01 SOL position sizes
- Compare live results to backtest expectations
- Scale position sizes only after 30+ profitable trades demonstrate edge

---

## Risk acknowledgment and realistic expectations

**The expected value of meme coin trading is negative for most participants.** The data is unambiguous: 60-90% lose money, and the 0.4% who profit significantly possess advantages in speed, information, and capital that this guide cannot fully replicate.

If you proceed, do so with these principles:

1. **Use only capital you can lose entirely**—100% loss is the modal outcome
2. **Treat early attempts as paid education**, not investment
3. **The bot is a tool, not a money printer**—no code compensates for unfavorable odds
4. **Take profits aggressively**—most tokens die within hours
5. **Study the statistics regularly** to avoid survivorship bias from social media success stories

The APIs work. The code executes. The strategies have internal logic. Whether the mathematics of risk/reward ultimately favors you remains a function of skill, timing, and significant luck. Build the system, run the experiments, and let the data—not hope—guide your decisions.