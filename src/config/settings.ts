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
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '5'),

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

  stopLossPercent: 0.12,      // -12% stop loss (was 50%)

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

  // Velocity-based entry for new tokens (no price history)
  // Balance: fast enough to catch pumps, but filter out wash trading
  velocityEntry: {
    enabled: false,          // DISABLED: AI decides entry, not velocity
    minTxCount: 5,           // Lowered from 10 - tokens evaluated quickly after creation
    minUniqueBuyers: 3,      // Lowered from 5 - need at least 3 different wallets
    minBuyPressure: 0.70,    // 70% buys - slightly more permissive
    maxMarketCapSol: 60,     // Increased - tokens with traction often hit 40-50 SOL quickly
  },

  // Token Watchlist - AI-driven entry (NEW)
  watchlist: {
    minDataPoints: 10,       // Need 10+ price updates before AI can analyze
    minAgeSeconds: 60,       // NEW: Token must be at least 60 seconds old
    minConfidence: 0.55,     // LOWERED: Base confidence (dynamic scaling adds more)
    maxConfidence: 0.70,     // NEW: Max confidence threshold for older tokens
    maxDrawdown: 0.30,       // Hard reject if crashed >30% from peak
  },

  // Momentum Override - bypass lower confidence if signals are strong
  momentumOverride: {
    enabled: true,
    minBuyPressure: 0.75,           // 75%+ buys
    minVolumeAcceleration: 1.2,     // Volume 20%+ higher than previous window
    minUniqueTraderGrowth: 3,       // At least 3 new unique traders
    confidenceFloor: 0.45,          // Allow entries at 45% confidence if momentum strong
  },

  // Dev Sold Tracking - percentage-based instead of binary
  devSoldConfig: {
    maxSellPercent: 0.05,           // 5% max dev sell allowed
    earlyWindowSeconds: 180,        // First 3 minutes are critical
    earlyMaxSellPercent: 0.02,      // Only 2% allowed in early window
  },
};

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const LAMPORTS_PER_SOL = 1_000_000_000;
