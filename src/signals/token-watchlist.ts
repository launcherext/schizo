import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';
import { config } from '../config/settings';

const logger = createChildLogger('token-watchlist');

export interface TradeData {
  txType: 'buy' | 'sell';
  traderPublicKey: string;
  tokenAmount: number;
  marketCapSol: number;
  priceSol: number;
  timestamp: number;
}

export interface WatchedToken {
  mint: string;
  creator: string;
  firstSeen: number;
  priceHistory: Array<{
    price: number;
    marketCap: number;
    timestamp: number;
  }>;
  trades: TradeData[];
  devSold: boolean;
  devSoldPercent: number;           // NEW: Track percentage of dev holdings sold
  devInitialHolding: number;        // NEW: Track initial dev holding for percentage calc
  devSoldTimestamp: number | null;  // NEW: When dev first sold
  peakPrice: number;
  lowestPrice: number;
  volumeHistory: Array<{            // NEW: Track volume windows for acceleration
    count: number;
    timestamp: number;
  }>;
  uniqueTraderHistory: number[];    // NEW: Track unique trader growth
}

export interface WatchlistFeatures {
  priceChange: number;
  volatility: number;
  drawdown: number;
  buyPressure: number;
  volumeTrend: number;
  ageMinutes: number;
  ageSeconds: number;               // NEW: Raw age in seconds
  uniqueTraders: number;
  devHolding: number;
  devSoldPercent: number;           // NEW: Percentage of dev holdings sold
  volumeAcceleration: number;       // NEW: Volume acceleration (recent vs previous window)
  uniqueTraderGrowth: number;       // NEW: Growth in unique traders over time
  hasMomentum: boolean;             // NEW: Whether momentum override conditions met
}

export interface MomentumSignal {
  hasMomentum: boolean;
  buyPressure: number;
  volumeAcceleration: number;
  uniqueTraderGrowth: number;
  reason: string;
}

export interface HardFilterResult {
  passes: boolean;
  reason: string;
}

export class TokenWatchlist extends EventEmitter {
  private watchlist: Map<string, WatchedToken> = new Map();
  private readonly minDataPoints = config.watchlist?.minDataPoints || 10;

  constructor() {
    super();
  }

  addToken(mint: string, creator: string): void {
    if (this.watchlist.has(mint)) {
      logger.debug({ mint }, 'Token already in watchlist');
      return;
    }

    this.watchlist.set(mint, {
      mint,
      creator,
      firstSeen: Date.now(),
      priceHistory: [],
      trades: [],
      devSold: false,
      devSoldPercent: 0,
      devInitialHolding: 0,
      devSoldTimestamp: null,
      peakPrice: 0,
      lowestPrice: Infinity,
      volumeHistory: [],
      uniqueTraderHistory: [],
    });

    logger.info({ mint: mint.substring(0, 15), creator: creator.substring(0, 10) }, 'Added token to watchlist');
    this.emit('tokenAdded', { mint, creator });
  }

  removeToken(mint: string): void {
    if (this.watchlist.delete(mint)) {
      logger.debug({ mint }, 'Removed token from watchlist');
      this.emit('tokenRemoved', { mint });
    }
  }

  recordPrice(mint: string, price: number, marketCap: number): void {
    const token = this.watchlist.get(mint);
    if (!token) return;

    token.priceHistory.push({ price, marketCap, timestamp: Date.now() });

    // Keep last 5 minutes of data (at ~1 update/sec = 300 entries)
    if (token.priceHistory.length > 300) {
      token.priceHistory = token.priceHistory.slice(-300);
    }

    // Track peak and lowest
    if (price > token.peakPrice) token.peakPrice = price;
    if (price < token.lowestPrice) token.lowestPrice = price;

    // Emit event when we have enough data points for AI analysis
    if (token.priceHistory.length === this.minDataPoints) {
      this.emit('tokenReady', { mint, token });
    }
  }

  recordTrade(mint: string, trade: Omit<TradeData, 'timestamp'>): void {
    const token = this.watchlist.get(mint);
    if (!token) return;

    const tradeWithTimestamp: TradeData = {
      ...trade,
      timestamp: Date.now(),
    };

    token.trades.push(tradeWithTimestamp);

    // Keep last 500 trades
    if (token.trades.length > 500) {
      token.trades = token.trades.slice(-500);
    }

    // Track volume windows for acceleration calculation (every 30 seconds)
    const now = Date.now();
    const lastVolumeEntry = token.volumeHistory[token.volumeHistory.length - 1];
    if (!lastVolumeEntry || now - lastVolumeEntry.timestamp >= 30000) {
      // Count trades in last 30 seconds
      const recentTrades = token.trades.filter(t => now - t.timestamp < 30000).length;
      token.volumeHistory.push({ count: recentTrades, timestamp: now });
      // Keep last 10 entries (5 minutes of 30-second windows)
      if (token.volumeHistory.length > 10) {
        token.volumeHistory = token.volumeHistory.slice(-10);
      }
    }

    // Track unique traders growth
    const uniqueTraders = new Set(token.trades.map(t => t.traderPublicKey)).size;
    token.uniqueTraderHistory.push(uniqueTraders);
    if (token.uniqueTraderHistory.length > 60) {
      token.uniqueTraderHistory = token.uniqueTraderHistory.slice(-60);
    }

    // Track dev behavior - percentage-based instead of binary
    if (trade.traderPublicKey === token.creator) {
      if (trade.txType === 'buy' && token.devInitialHolding === 0) {
        // Track initial dev holding
        token.devInitialHolding = trade.tokenAmount;
      } else if (trade.txType === 'sell') {
        // Calculate percentage sold
        if (token.devInitialHolding > 0) {
          token.devSoldPercent += trade.tokenAmount / token.devInitialHolding;
        } else {
          // If we don't know initial holding, estimate from this sell
          token.devSoldPercent = Math.min(token.devSoldPercent + 0.1, 1.0);
        }

        if (token.devSoldTimestamp === null) {
          token.devSoldTimestamp = now;
        }

        const ageSeconds = (now - token.firstSeen) / 1000;
        const earlyWindow = config.devSoldConfig?.earlyWindowSeconds || 180;
        const earlyMaxSell = config.devSoldConfig?.earlyMaxSellPercent || 0.02;
        const maxSell = config.devSoldConfig?.maxSellPercent || 0.05;

        // Check if dev sold too much (percentage-based)
        const threshold = ageSeconds < earlyWindow ? earlyMaxSell : maxSell;
        if (token.devSoldPercent > threshold) {
          token.devSold = true;
          logger.warn({
            mint: mint.substring(0, 15),
            devSoldPercent: (token.devSoldPercent * 100).toFixed(1) + '%',
            threshold: (threshold * 100).toFixed(1) + '%',
            ageSeconds: ageSeconds.toFixed(0),
          }, 'DEV SOLD TOO MUCH - Token flagged');
          this.emit('devSold', { mint, trade: tradeWithTimestamp, percent: token.devSoldPercent });
        } else {
          logger.debug({
            mint: mint.substring(0, 15),
            devSoldPercent: (token.devSoldPercent * 100).toFixed(1) + '%',
            threshold: (threshold * 100).toFixed(1) + '%',
          }, 'Dev sold (within threshold)');
        }
      }
    }

    // Update price if trade has price info
    if (trade.priceSol > 0) {
      this.recordPrice(mint, trade.priceSol, trade.marketCapSol);
    }
  }

  // HARD FILTERS: Instant rejection (don't waste AI on these)
  passesHardFilters(mint: string): HardFilterResult {
    const token = this.watchlist.get(mint);
    if (!token) {
      return { passes: false, reason: 'Token not in watchlist' };
    }

    // INSTANT REJECT: Dev already sold too much
    if (token.devSold) {
      return { passes: false, reason: `Dev sold ${(token.devSoldPercent * 100).toFixed(1)}%` };
    }

    // INSTANT REJECT: Not enough data for AI analysis
    if (token.priceHistory.length < this.minDataPoints) {
      return {
        passes: false,
        reason: `Only ${token.priceHistory.length}/${this.minDataPoints} data points`
      };
    }

    // INSTANT REJECT: Token too young (need time-based validity)
    const minAgeSeconds = config.watchlist?.minAgeSeconds || 300;
    const ageSeconds = (Date.now() - token.firstSeen) / 1000;
    if (ageSeconds < minAgeSeconds) {
      return {
        passes: false,
        reason: `Token only ${ageSeconds.toFixed(0)}s old (min ${minAgeSeconds}s)`
      };
    }

    // INSTANT REJECT: Crashed more than maxDrawdown from peak
    const maxDrawdown = config.watchlist?.maxDrawdown || 0.15;
    if (token.peakPrice > 0) {
      const currentPrice = token.priceHistory[token.priceHistory.length - 1]?.price || 0;
      const drawdown = (token.peakPrice - currentPrice) / token.peakPrice;
      if (drawdown > maxDrawdown) {
        return {
          passes: false,
          reason: `Crashed ${(drawdown * 100).toFixed(0)}% from peak (max ${(maxDrawdown * 100).toFixed(0)}%)`
        };
      }
    }

    // NEW: INSTANT REJECT: Market cap too low
    const minMarketCapSol = (config.watchlist as any)?.minMarketCapSol || 50;
    const latestPrice = token.priceHistory[token.priceHistory.length - 1];
    if (latestPrice && latestPrice.marketCap < minMarketCapSol) {
      return {
        passes: false,
        reason: `Market cap ${latestPrice.marketCap.toFixed(1)} SOL (min ${minMarketCapSol} SOL)`
      };
    }

    // NEW: INSTANT REJECT: Not enough unique traders (filter wash trading)
    const minUniqueTraders = (config.watchlist as any)?.minUniqueTraders || 10;
    const uniqueTraders = new Set(token.trades.map(t => t.traderPublicKey)).size;
    if (uniqueTraders < minUniqueTraders) {
      return {
        passes: false,
        reason: `Only ${uniqueTraders} unique traders (min ${minUniqueTraders})`
      };
    }

    // NEW: INSTANT REJECT: Price not in uptrend (comparing to 1 minute ago)
    const requireUptrend = (config.watchlist as any)?.requireUptrend !== false;
    if (requireUptrend && token.priceHistory.length >= 60) {
      const currentPrice = token.priceHistory[token.priceHistory.length - 1]?.price || 0;
      const priceOneMinAgo = token.priceHistory[token.priceHistory.length - 60]?.price || currentPrice;
      // Require at least flat or positive (allow -2% tolerance)
      if (priceOneMinAgo > 0 && currentPrice < priceOneMinAgo * 0.98) {
        const trend = ((currentPrice - priceOneMinAgo) / priceOneMinAgo * 100).toFixed(1);
        return {
          passes: false,
          reason: `Price in downtrend (${trend}% in last 60s)`
        };
      }
    }

    return { passes: true, reason: 'Ready for AI analysis' };
  }

  // Extract features for DDQN agent
  extractFeatures(mint: string): WatchlistFeatures | null {
    const token = this.watchlist.get(mint);
    if (!token || token.priceHistory.length < this.minDataPoints) {
      return null;
    }

    const prices = token.priceHistory.map(p => p.price);
    const currentPrice = prices[prices.length - 1];
    const firstPrice = prices[0];

    // Recent trades (last 60 seconds)
    const recentTrades = token.trades.filter(t => Date.now() - t.timestamp < 60000);
    const recentBuys = recentTrades.filter(t => t.txType === 'buy').length;

    // Calculate features
    const priceChange = firstPrice > 0 ? (currentPrice - firstPrice) / firstPrice : 0;
    const volatility = this.calculateVolatility(prices);
    const drawdown = token.peakPrice > 0 ? (token.peakPrice - currentPrice) / token.peakPrice : 0;
    const buyPressure = recentTrades.length > 0 ? recentBuys / recentTrades.length : 0.5;
    const volumeTrend = this.calculateVolumeTrend(token.trades);
    const ageMinutes = (Date.now() - token.firstSeen) / 60000;
    const ageSeconds = (Date.now() - token.firstSeen) / 1000;
    const uniqueTraders = new Set(token.trades.map(t => t.traderPublicKey)).size;
    const devHolding = token.devSold ? 0 : 1 - token.devSoldPercent;
    const devSoldPercent = token.devSoldPercent;

    // Calculate volume acceleration (compare last 30s window to previous 30s)
    const volumeAcceleration = this.calculateVolumeAcceleration(token);

    // Calculate unique trader growth (compare current to 30 seconds ago)
    const uniqueTraderGrowth = this.calculateUniqueTraderGrowth(token);

    // Check momentum conditions
    const momentumSignal = this.checkMomentum(token, buyPressure, volumeAcceleration, uniqueTraderGrowth);

    return {
      priceChange,
      volatility,
      drawdown,
      buyPressure,
      volumeTrend,
      ageMinutes,
      ageSeconds,
      uniqueTraders,
      devHolding,
      devSoldPercent,
      volumeAcceleration,
      uniqueTraderGrowth,
      hasMomentum: momentumSignal.hasMomentum,
    };
  }

  // Calculate volume acceleration (recent window vs previous window)
  private calculateVolumeAcceleration(token: WatchedToken): number {
    if (token.volumeHistory.length < 2) return 1.0;

    const recent = token.volumeHistory[token.volumeHistory.length - 1]?.count || 0;
    const previous = token.volumeHistory[token.volumeHistory.length - 2]?.count || 1;

    return previous > 0 ? recent / previous : 1.0;
  }

  // Calculate unique trader growth
  private calculateUniqueTraderGrowth(token: WatchedToken): number {
    if (token.uniqueTraderHistory.length < 10) return 0;

    const current = token.uniqueTraderHistory[token.uniqueTraderHistory.length - 1];
    const previous = token.uniqueTraderHistory[Math.max(0, token.uniqueTraderHistory.length - 10)];

    return current - previous;
  }

  // Check if token has momentum override conditions
  checkMomentum(
    token: WatchedToken,
    buyPressure: number,
    volumeAcceleration: number,
    uniqueTraderGrowth: number
  ): MomentumSignal {
    const cfg = config.momentumOverride || {
      enabled: true,
      minBuyPressure: 0.75,
      minVolumeAcceleration: 1.2,
      minUniqueTraderGrowth: 3,
    };

    if (!cfg.enabled) {
      return {
        hasMomentum: false,
        buyPressure,
        volumeAcceleration,
        uniqueTraderGrowth,
        reason: 'Momentum override disabled',
      };
    }

    const meetsAll =
      buyPressure >= cfg.minBuyPressure &&
      volumeAcceleration >= cfg.minVolumeAcceleration &&
      uniqueTraderGrowth >= cfg.minUniqueTraderGrowth;

    const reasons: string[] = [];
    if (buyPressure >= cfg.minBuyPressure) {
      reasons.push(`buyPressure ${(buyPressure * 100).toFixed(0)}%`);
    }
    if (volumeAcceleration >= cfg.minVolumeAcceleration) {
      reasons.push(`volume accel ${volumeAcceleration.toFixed(2)}x`);
    }
    if (uniqueTraderGrowth >= cfg.minUniqueTraderGrowth) {
      reasons.push(`+${uniqueTraderGrowth} traders`);
    }

    return {
      hasMomentum: meetsAll,
      buyPressure,
      volumeAcceleration,
      uniqueTraderGrowth,
      reason: meetsAll ? `MOMENTUM: ${reasons.join(', ')}` : 'Conditions not met',
    };
  }

  // Get momentum signal for a token
  getMomentumSignal(mint: string): MomentumSignal | null {
    const token = this.watchlist.get(mint);
    if (!token) return null;

    const recentTrades = token.trades.filter(t => Date.now() - t.timestamp < 60000);
    const recentBuys = recentTrades.filter(t => t.txType === 'buy').length;
    const buyPressure = recentTrades.length > 0 ? recentBuys / recentTrades.length : 0.5;
    const volumeAcceleration = this.calculateVolumeAcceleration(token);
    const uniqueTraderGrowth = this.calculateUniqueTraderGrowth(token);

    return this.checkMomentum(token, buyPressure, volumeAcceleration, uniqueTraderGrowth);
  }

  // Calculate dynamic confidence threshold based on token age
  getDynamicConfidenceThreshold(mint: string): number {
    const token = this.watchlist.get(mint);
    if (!token) return config.watchlist?.maxConfidence || 0.70;

    const ageSeconds = (Date.now() - token.firstSeen) / 1000;
    const minConf = config.watchlist?.minConfidence || 0.55;
    const maxConf = config.watchlist?.maxConfidence || 0.70;

    // Scale confidence from minConf to maxConf over 180 seconds (3 minutes)
    // Formula: requiredConfidence = clamp(0.55 + (tokenAgeSeconds / 180) * 0.15, 0.55, 0.70)
    const scaleFactor = Math.min(ageSeconds / 180, 1.0);
    const threshold = minConf + scaleFactor * (maxConf - minConf);

    return Math.max(minConf, Math.min(maxConf, threshold));
  }

  // Convert features to array for AI model
  featuresToArray(features: WatchlistFeatures): number[] {
    return [
      features.priceChange,                                // Price momentum
      features.volatility,                                 // Risk indicator
      features.drawdown,                                   // How far from peak
      features.buyPressure,                                // Demand indicator
      features.volumeTrend,                                // Increasing or decreasing volume
      Math.min(features.ageMinutes / 10, 1),               // Normalized age (0-1 for first 10 min)
      Math.min(features.uniqueTraders / 50, 1),            // Normalized unique traders
      features.devHolding,                                 // Dev hasn't sold = 1 (scaled by sold percent)
      features.devSoldPercent,                             // NEW: How much dev sold
      Math.min(features.volumeAcceleration / 2, 1),        // NEW: Volume acceleration (capped at 2x)
      Math.min(features.uniqueTraderGrowth / 10, 1),       // NEW: Unique trader growth (capped at 10)
      features.hasMomentum ? 1 : 0,                        // NEW: Momentum override flag
    ];
  }

  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;

    const returns = prices.slice(1).map((p, i) =>
      prices[i] > 0 ? (p - prices[i]) / prices[i] : 0
    );

    if (returns.length === 0) return 0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;

    return Math.sqrt(variance);
  }

  private calculateVolumeTrend(trades: TradeData[]): number {
    if (trades.length < 10) return 0;

    const midpoint = Math.floor(trades.length / 2);
    const firstHalfCount = midpoint;
    const secondHalfCount = trades.length - midpoint;

    if (firstHalfCount === 0) return 0;

    return (secondHalfCount - firstHalfCount) / firstHalfCount;
  }

  // Get all tokens ready for AI analysis
  getReadyTokens(): string[] {
    const ready: string[] = [];

    for (const [mint, token] of this.watchlist.entries()) {
      const filterResult = this.passesHardFilters(mint);
      if (filterResult.passes) {
        ready.push(mint);
      }
    }

    return ready;
  }

  // Get all watched tokens (for frontend display)
  getAllTokens(): string[] {
    return Array.from(this.watchlist.keys());
  }

  // Get token info
  getToken(mint: string): WatchedToken | undefined {
    return this.watchlist.get(mint);
  }

  // Check if token is being watched
  isWatched(mint: string): boolean {
    return this.watchlist.has(mint);
  }

  // Get stats
  getStats(): { total: number; ready: number; devSold: number } {
    let ready = 0;
    let devSold = 0;

    for (const token of this.watchlist.values()) {
      if (this.passesHardFilters(token.mint).passes) ready++;
      if (token.devSold) devSold++;
    }

    return {
      total: this.watchlist.size,
      ready,
      devSold,
    };
  }

  // Cleanup old tokens (not seen for >10 minutes with no activity)
  cleanup(maxAge: number = 600000): void {
    const now = Date.now();

    for (const [mint, token] of this.watchlist.entries()) {
      const age = now - token.firstSeen;
      const lastActivity = token.trades.length > 0
        ? token.trades[token.trades.length - 1].timestamp
        : token.firstSeen;
      const timeSinceActivity = now - lastActivity;

      // Remove if old and inactive
      if (age > maxAge && timeSinceActivity > 60000) {
        this.watchlist.delete(mint);
        logger.debug({ mint }, 'Cleaned up inactive token');
      }
    }
  }
}

export const tokenWatchlist = new TokenWatchlist();
