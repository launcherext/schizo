import dotenv from 'dotenv';
dotenv.config();

const heliusApiKey = process.env.HELIUS_API_KEY || '';

export const config = {
  // Solana RPC
  solanaRpcUrl: process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`,
  heliusApiKey,
  heliusWsUrl: process.env.HELIUS_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`,
  privateKey: process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',

  // Database
  databaseUrl: process.env.DATABASE_URL || '',
  sqlitePath: process.env.SQLITE_PATH || './data/cache.db',

  // Trading Parameters
  initialCapitalSol: parseFloat(process.env.INITIAL_CAPITAL_SOL || '1.0'),
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '0.25'),  // 25% of capital max (allows 0.07 SOL trades with smaller balances)
  dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT || '0.15'),
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '2'),  // Reduced to 2 - focus on quality over quantity

  // Jito MEV Protection
  jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf',
  jitoTipLamports: parseInt(process.env.JITO_TIP_LAMPORTS || '10000'),

  // Feature Flags
  paperTrading: false,  // DISABLED: Live trading mode
  enableJito: process.env.ENABLE_JITO === 'true',

  // API Endpoints (using public Jupiter API - no auth required)
  jupiterQuoteApi: 'https://public.jupiterapi.com/quote',
  jupiterSwapApi: 'https://public.jupiterapi.com/swap',
  // Note: Price data comes from DexScreener (free) instead of Jupiter price API (paid)
  dexScreenerApi: 'https://api.dexscreener.com/latest/dex/tokens',
  jitoBundleApi: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',

  // Program IDs
  pumpFunProgram: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

  // Risk Parameters
  // UPDATED: Reduced reserve to allow more capital for trading
  capitalAllocation: {
    reserve: 0.20,    // 20% never trade (was 40% - too conservative)
    active: 0.50,     // 50% normal trades
    highRisk: 0.30,   // 30% meme plays
  },

  stopLossPercent: 0.12,      // -12% stop loss for established tokens

  // Age-based stop loss for new tokens - tightened back up
  ageBasedStopLoss: {
    enabled: true,
    // For tokens < 60 seconds old: wider stop but not too wide
    newTokenThresholdSeconds: 60,
    newTokenStopLossPercent: 0.20,  // -20% for brand new tokens (tightened from 35%)
    // For tokens 60-180 seconds: gradual tightening
    youngTokenThresholdSeconds: 180,
    youngTokenStopLossPercent: 0.15, // -15% for young tokens (tightened from 25%)
    // After 180 seconds: use standard stop loss (0.12)
  },

  // Grace period: don't trigger stop loss for first X seconds
  // CRITICAL FIX: Reduced from 10 to 2 - analysis showed 10 seconds allows too much damage
  stopLossGracePeriodSeconds: 2,

  // MAX HOLD TIME: Force exit positions after this many minutes
  // Analysis showed positions held 4+ hours were almost all -90% losses (dead tokens)
  // Meme tokens either pump in the first 30 minutes or they're dead
  maxHoldTimeMinutes: 30,

  // CRITICAL FIX: Minimum token age before ANY entry (including snipe mode)
  // 15 seconds minimum - rugs need time to reveal, 3 seconds was suicide
  minTokenAgeSeconds: 15,  // 15 seconds minimum - allows rugs to reveal themselves

  // NEW: Rapid drop detection - exit immediately if price crashes
  // TIGHTENED: These tokens are rugging, get out fast
  rapidDropExit: {
    enabled: true,
    dropPercent: 0.20,       // TIGHTENED: 20% drop triggers exit (was 30%)
    windowSeconds: 90,       // Extended: Check for first 90 seconds for early rug detection
    useHighSlippage: true,   // Use stopLossSlippageBps for panic sell
  },

  // Take Profit Strategy - BALANCED: Take early profits, protect capital
  // First TP at +40% to recover cost, then scale out
  takeProfitStrategy: {
    // At +40% gain, sell enough to recover initial investment
    initialRecovery: {
      triggerPercent: 0.40,  // +40% gain - recover cost early, don't wait for 2x
      action: 'recover_initial' as const,
    },
    // After initial recovery, sell 33% of remainder every +70%
    scaledExits: {
      intervalPercent: 0.70,  // Every +70% gain after initial recovery
      sellPercent: 0.33,      // Sell 33% of remaining (was 25%)
    },
    // Trailing stop - tighter to protect profits
    // 20% trailing catches reversals before too much profit is lost
    trailingStopPercent: 0.20,  // 20% trailing stop (was 30% - too wide)
  },

  // LEGACY: Keep for backwards compatibility but unused
  takeProfitLevels: [
    { multiplier: 2.0, sellPercent: 0.25 },
    { multiplier: 3.0, sellPercent: 0.25 },
  ],
  trailingStopPercent: 0.20,  // 20% trailing stop - tighter to protect profits

  // AI Parameters
  ddqnConfig: {
    stateSize: 16,         // Updated from 12 to 16 (added: drawdownFromPeak, volatility, uniqueTraders, volumeTrend)
    actionSize: 3,         // HOLD, BUY, SELL
    hiddenSize: 128,
    learningRate: 0.001,
    gamma: 0.99,           // discount factor
    epsilon: 1.0,          // exploration rate
    epsilonMin: 0.01,
    epsilonDecay: 0.995,
    replayBufferSize: 100000,
    batchSize: 64,
    targetUpdateTau: 0.005,
  },

  // Timing
  priceCheckIntervalMs: 1000,
  featureUpdateIntervalMs: 5000,
  modelRetrainIntervalMs: 7 * 24 * 60 * 60 * 1000, // 1 week

  // Thresholds
  // NOTE: minRugScore raised to 55 - with LP check now working, max score is 100
  // 55/100 = 55% minimum safety score required
  // NOTE: minLiquiditySol lowered from 5 to 1 for testing
  minLiquiditySol: 1,
  minHolderCount: 50,
  maxTop10Concentration: 0.30,
  minRugScore: 55,           // RAISED: 55% min safety score (was 45% - allowed too many rugs)
  minPumpHeat: 25,           // RAISED: 25+ heat required (cold phase < 25)
  requireNonColdPhase: true, // ENABLED: Stop buying tokens with zero momentum

  // Trade execution settings
  tradeAmountSol: parseFloat(process.env.BASE_POSITION_SOL || '0.01'),  // TEST MODE: 0.01 SOL for testing
  minPositionSol: 0.005,     // TEST MODE: Lower minimum for testing
  defaultSlippageBps: 1500,  // 15% slippage for normal trades
  stopLossSlippageBps: 2000, // 20% slippage for stop loss (was 30% - too much lost to slippage)
  priorityFeeSol: 0.0001,    // Priority fee in SOL
  jitoBribeSol: 0.00001,     // Jito bribe (if enabled)

  // Whale copy trading
  whaleMinBuySol: parseFloat(process.env.WHALE_MIN_BUY_SOL || '5'), // 5 SOL min whale buy to copy

  // Velocity-based entry for new tokens (no price history)
  // Balanced thresholds - not too strict (no trades) or too loose (rugs)
  velocityEntry: {
    enabled: false,          // DISABLED: AI decides entry, not velocity
    minTxCount: 8,           // LOWERED: 8 txs in 60s window is achievable
    minUniqueBuyers: 4,      // LOWERED: 4 unique wallets filters wash trading
    minBuyPressure: 0.55,    // LOWERED: 55% buys still bullish, but more achievable
    maxMarketCapSol: 100,    // Allow slightly larger caps for tokens with real traction
  },

  // Token Watchlist - AI-driven entry (TWO TIERS: snipe fast OR wait for data)
  watchlist: {
    minDataPoints: 10,       // Reduced: 10 price points for safe mode (was 20 - too slow)
    minAgeSeconds: 15,       // Aligned with minTokenAgeSeconds - rugs need time to reveal
    minConfidence: 0.60,     // Slightly higher bar
    maxConfidence: 0.80,     // Higher bar for older tokens
    maxDrawdown: 0.15,       // Don't buy tokens already dumping
    minMarketCapSol: 25,     // Floor for market cap
    minUniqueTraders: 6,     // More real traders = less likely rug
    requireUptrend: false,   // Disabled: allow dip buys (snipe mode has its own check)
  },

  // SNIPE MODE: Fast entries for promising tokens
  // TIGHTENED: Previous settings allowed too many rugs with no real activity
  snipeMode: {
    enabled: true,
    maxAgeSeconds: 60,        // Snipe tokens 15-60 seconds old (aligned with minTokenAgeSeconds)
    minTxCount: 10,           // TIGHTENED: 10+ transactions (was 5 - too few)
    minUniqueBuyers: 12,      // RAISED: 12+ unique wallets (5 is trivially faked)
    minBuyPressure: 0.68,     // RAISED: 68%+ buys (60% still has resistance)
    maxMarketCapSol: 80,      // Under 80 SOL mcap
    minBuyPressureStreak: 1,  // 1+ buy-heavy window
  },

  // ESTABLISHED MODE: For DexScreener trending & whale copies (already have proven data)
  establishedMode: {
    enabled: true,
    minBuyPressure: 0.55,     // LOWERED: 55%+ buy pressure (was 60%)
    minPriceChange5m: 0,      // LOWERED: Any positive or flat is OK (was 2% - too strict)
    maxPriceChange5m: 50,     // RAISED: Allow up to 50% (was 40%)
    minLiquidityUsd: 3000,    // LOWERED: $3k min liquidity (was $5k)
    maxMarketCapUsd: 10_000_000, // RAISED: Under $10M mcap (was $5M)
  },

  // Momentum Override - bypass lower confidence if signals are strong
  momentumOverride: {
    enabled: true,
    minBuyPressure: 0.70,           // LOWERED: 70%+ buys (more achievable)
    minVolumeAcceleration: 1.3,     // LOWERED: 30%+ volume acceleration
    minUniqueTraderGrowth: 3,       // LOWERED: 3 new unique traders
    confidenceFloor: 0.50,          // LOWERED: Allow momentum to override at 50%
  },

  // Dev Sold Tracking - percentage-based instead of binary
  devSoldConfig: {
    maxSellPercent: 0.05,           // 5% max dev sell allowed
    earlyWindowSeconds: 180,        // First 3 minutes are critical
    earlyMaxSellPercent: 0.02,      // Only 2% allowed in early window
  },

  // C100 Token Configuration
  c100: {
    tokenMint: process.env.C100_TOKEN_MINT || '',
    enabled: !!process.env.C100_TOKEN_MINT,
    autoClaim: {
      enabled: true,
      intervalMs: 5 * 60 * 1000,    // 5 minutes
      claimPumpCreator: true,
    },
    buyback: {
      enabled: true,
      profitSharePercent: 0.10,     // 10% of profits
      minBuybackSol: 0.01,          // Minimum buyback amount
    },
  },
};

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const LAMPORTS_PER_SOL = 1_000_000_000;
