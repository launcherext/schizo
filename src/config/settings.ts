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
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '3'),  // Default to 3

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
  ageBasedStopLoss: {
    enabled: true,
    // For tokens < 60 seconds old: use wider stop
    newTokenThresholdSeconds: 60,
    newTokenStopLossPercent: 0.25,  // -25% for brand new tokens
    // For tokens 60-180 seconds: gradual tightening
    youngTokenThresholdSeconds: 180,
    youngTokenStopLossPercent: 0.18, // -18% for young tokens
    // After 180 seconds: use standard stop loss (0.12)
  },

  // Grace period: don't trigger stop loss for first X seconds
  stopLossGracePeriodSeconds: 15,  // 15 second grace period

  // NEW Take Profit Strategy: recover initial at +50%, then scale out
  takeProfitStrategy: {
    // At +50% gain, sell enough to recover initial investment
    initialRecovery: {
      triggerPercent: 0.50,  // +50% gain
      action: 'recover_initial' as const,
    },
    // After initial recovery, sell 20% of remainder every +50%
    scaledExits: {
      intervalPercent: 0.50,  // Every +50% gain
      sellPercent: 0.20,      // Sell 20% of remaining
    },
    // Trailing stop on final portion
    trailingStopPercent: 0.15,  // 15% trailing stop
  },

  // LEGACY: Keep for backwards compatibility but unused
  takeProfitLevels: [
    { multiplier: 2.0, sellPercent: 0.25 },
    { multiplier: 3.0, sellPercent: 0.25 },
  ],
  trailingStopPercent: 0.15,  // 15% trailing stop (updated from 20%)

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
  minPumpHeat: 0,  // Lowered from 33 to 0 for testing live trades

  // Trade execution settings
  tradeAmountSol: parseFloat(process.env.BASE_POSITION_SOL || '0.01'),
  defaultSlippageBps: 1500,  // 15% slippage
  priorityFeeSol: 0.0001,    // Priority fee in SOL
  jitoBribeSol: 0.00001,     // Jito bribe (if enabled)

  // Whale copy trading
  whaleMinBuySol: parseFloat(process.env.WHALE_MIN_BUY_SOL || '5'), // 5 SOL min whale buy to copy

  // Velocity-based entry for new tokens (no price history)
  // Tightened thresholds to avoid rugs and garbage tokens
  velocityEntry: {
    enabled: false,          // DISABLED: AI decides entry, not velocity
    minTxCount: 15,          // Increased: need real activity, not just a few buys
    minUniqueBuyers: 7,      // Increased: need 7+ unique wallets to filter wash trading
    minBuyPressure: 0.60,    // 60% buys - higher threshold for quality
    maxMarketCapSol: 100,    // Allow slightly larger caps for tokens with real traction
  },

  // Token Watchlist - AI-driven entry (TIGHTENED to reduce losses)
  watchlist: {
    minDataPoints: 15,       // Need 15+ price updates before AI can analyze
    minAgeSeconds: 300,      // 5 MINUTES: token must survive initial pump/dump cycle
    minConfidence: 0.65,     // RAISED: Require stronger AI confidence
    maxConfidence: 0.80,     // RAISED: Higher bar for older tokens
    maxDrawdown: 0.15,       // TIGHTENED: Hard reject if crashed >15% from peak (avoid dead tokens)
    minMarketCapSol: 50,     // NEW: Minimum 50 SOL market cap (skip ultra micro tokens)
    minUniqueTraders: 10,    // NEW: Minimum 10 unique traders (real activity filter)
    requireUptrend: true,    // NEW: Price must be above entry compared to 1 minute ago
  },

  // Momentum Override - bypass lower confidence if signals are VERY strong
  momentumOverride: {
    enabled: true,
    minBuyPressure: 0.80,           // RAISED: 80%+ buys required
    minVolumeAcceleration: 1.5,     // RAISED: Volume 50%+ higher than previous window
    minUniqueTraderGrowth: 5,       // RAISED: At least 5 new unique traders
    confidenceFloor: 0.55,          // RAISED: Even with momentum, need 55% confidence
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
