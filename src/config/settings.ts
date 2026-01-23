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
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '0.10'),  // 10% of capital max (allows small balances to trade)
  dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT || '0.15'),
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '2'),  // Reduced to 2 - focus on quality over quantity

  // Jito MEV Protection
  jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf',
  jitoTipLamports: parseInt(process.env.JITO_TIP_LAMPORTS || '10000'),

  // Feature Flags
  paperTrading: process.env.PAPER_TRADING === 'true',
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
  capitalAllocation: {
    reserve: 0.40,    // 40% never trade
    active: 0.40,     // 40% normal trades
    highRisk: 0.20,   // 20% meme plays
  },

  stopLossPercent: 0.12,      // -12% stop loss for established tokens

  // Age-based stop loss for new tokens (wider stop during initial volatility)
  // UPDATED: Even wider stops for snipe mode tokens - they're very volatile
  ageBasedStopLoss: {
    enabled: true,
    // For tokens < 60 seconds old: use widest stop
    newTokenThresholdSeconds: 60,
    newTokenStopLossPercent: 0.35,  // -35% for brand new tokens (was 25% - too tight)
    // For tokens 60-180 seconds: gradual tightening
    youngTokenThresholdSeconds: 180,
    youngTokenStopLossPercent: 0.25, // -25% for young tokens (was 18%)
    // After 180 seconds: use standard stop loss (0.12)
  },

  // Grace period: don't trigger stop loss for first X seconds
  // CRITICAL FIX: Reduced from 10 to 2 - analysis showed 10 seconds allows too much damage
  stopLossGracePeriodSeconds: 2,

  // CRITICAL FIX: Minimum token age before ANY entry (including snipe mode)
  // Analysis showed trades under 3 seconds are catastrophic losers (-77% to -87%)
  minTokenAgeSeconds: 3,  // Reduced from 15 to allow faster sniping

  // NEW: Rapid drop detection - exit immediately if price crashes
  // UPDATED: More lenient for snipe tokens - they're volatile early
  rapidDropExit: {
    enabled: true,
    dropPercent: 0.30,       // 30% drop triggers immediate exit (was 20% - too tight for snipe)
    windowSeconds: 20,       // Within first 20 seconds only (was 30 - too long)
    useHighSlippage: true,   // Use stopLossSlippageBps for panic sell
  },

  // NEW Take Profit Strategy: recover initial at +100%, then scale out
  // UPDATED: More lenient for volatile snipe tokens - let winners run longer
  takeProfitStrategy: {
    // At +100% gain (2x), sell enough to recover initial investment
    initialRecovery: {
      triggerPercent: 1.00,  // +100% gain (was 50% - too early for snipe tokens)
      action: 'recover_initial' as const,
    },
    // After initial recovery, sell 20% of remainder every +100%
    scaledExits: {
      intervalPercent: 1.00,  // Every +100% gain (was 50% - too aggressive)
      sellPercent: 0.20,      // Sell 20% of remaining
    },
    // Trailing stop on final portion - wider for volatile tokens
    trailingStopPercent: 0.25,  // 25% trailing stop (was 15% - too tight)
  },

  // LEGACY: Keep for backwards compatibility but unused
  takeProfitLevels: [
    { multiplier: 2.0, sellPercent: 0.25 },
    { multiplier: 3.0, sellPercent: 0.25 },
  ],
  trailingStopPercent: 0.25,  // 25% trailing stop (widened for volatile snipe tokens)

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
  // NOTE: minRugScore lowered from 70 to 45 because LP info is not available
  // (passed as null to rug detector), so max possible score is ~75 instead of 100
  // NOTE: minLiquiditySol lowered from 5 to 1 for testing
  minLiquiditySol: 1,
  minHolderCount: 50,
  maxTop10Concentration: 0.30,
  minRugScore: 45,
  minPumpHeat: 10,           // LOWERED: Allow tokens with some activity (was 20)
  requireNonColdPhase: false, // DISABLED: Allow cold phase entries if other signals are strong

  // Trade execution settings
  tradeAmountSol: parseFloat(process.env.BASE_POSITION_SOL || '0.02'),  // INCREASED from 0.01 - tiny positions get destroyed by slippage
  minPositionSol: 0.015,     // NEW: Minimum position size (below this, slippage destroys profits)
  defaultSlippageBps: 1500,  // 15% slippage for normal trades
  stopLossSlippageBps: 3000, // NEW: 30% slippage for stop loss (ensure execution on fast drops)
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
    minDataPoints: 20,       // Reduced: 20 price points for safe mode
    minAgeSeconds: 3,        // Aligned with minTokenAgeSeconds
    minConfidence: 0.60,     // Slightly higher bar
    maxConfidence: 0.80,     // Higher bar for older tokens
    maxDrawdown: 0.15,       // Don't buy tokens already dumping
    minMarketCapSol: 25,     // Floor for market cap
    minUniqueTraders: 6,     // More real traders = less likely rug
    requireUptrend: false,   // Disabled: allow dip buys (snipe mode has its own check)
  },

  // SNIPE MODE: Allow early entry with good velocity (loosened for more trades)
  snipeMode: {
    enabled: true,
    maxAgeSeconds: 90,        // Only snipe tokens < 90 seconds old
    minTxCount: 8,            // LOWERED: 8+ transactions (was 12)
    minUniqueBuyers: 5,       // LOWERED: 5+ unique wallets (was 8)
    minBuyPressure: 0.65,     // LOWERED: 65%+ buys (was 75%)
    maxMarketCapSol: 80,      // RAISED: Allow up to 80 SOL mcap (was 60)
    minBuyPressureStreak: 2,  // LOWERED: 2+ consecutive buy-heavy windows (was 3)
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
