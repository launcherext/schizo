import { createChildLogger } from '../utils/logger';
import { priceFeed } from '../data/price-feed';
import { PriceData, HolderInfo, TokenInfo, LiquidityPool } from '../data/types';
import { StateVector, FeatureHistory } from './types';
import { tokenWatchlist } from './token-watchlist';
import { velocityTracker } from './velocity-tracker';

const logger = createChildLogger('feature-extractor');

export class FeatureExtractor {
  private featureHistories: Map<string, FeatureHistory> = new Map();
  private maxHistoryLength = 300; // 5 minutes at 1-second intervals
  private tradeCountCache: Map<string, { count: number; timestamp: Date }> = new Map();

  constructor() {}

  async extractFeatures(
    mint: string,
    priceData: PriceData,
    holderInfo: HolderInfo | null,
    tokenInfo: TokenInfo | null,
    lpInfo?: LiquidityPool | null
  ): Promise<StateVector> {
    const priceHistory = priceFeed.getPriceHistory(mint, 300);

    // Calculate price changes
    const priceChange1m = this.calculatePriceChange(priceHistory, 60);
    const priceChange5m = this.calculatePriceChange(priceHistory, 300);

    // Calculate volume z-score (uses real trade count when available)
    const volumeZScore = this.calculateVolumeZScore(priceHistory, mint);

    // Calculate buy/sell ratio from real transactions when available
    const buySellRatio = this.calculateBuySellRatio(priceHistory, mint);

    // Holder metrics
    const holderCount = holderInfo
      ? this.normalizeHolderCount(holderInfo.totalHolders)
      : 0.5;
    const top10Concentration = holderInfo?.top10Concentration || 0.5;

    // Token safety flags
    const mintRevoked = tokenInfo?.mintAuthorityRevoked ? 1 : 0;
    const freezeRevoked = tokenInfo?.freezeAuthorityRevoked ? 1 : 0;

    // LP locked - use actual lpInfo if available
    const lpLocked = lpInfo?.lpLocked ? 1 : 0;

    // Token age
    const ageMinutes = tokenInfo
      ? this.normalizeAge((Date.now() - tokenInfo.createdAt.getTime()) / 60000)
      : 0.5;

    // Trade intensity (uses real trade count when available)
    const tradeIntensity = this.calculateTradeIntensity(priceHistory, mint);

    // Market cap normalized
    const marketCapSol = this.normalizeMarketCap(priceData.marketCapSol);

    // NEW: Calculate drawdown from peak
    const drawdownFromPeak = this.calculateDrawdownFromPeak(mint, priceHistory, priceData.priceSol);

    // NEW: Calculate volatility (standard deviation of recent price changes)
    const volatility = this.calculateVolatility(priceHistory);

    // NEW: Calculate unique traders (normalized)
    const uniqueTraders = this.calculateUniqueTraders(mint);

    // NEW: Calculate volume trend (acceleration/deceleration)
    const volumeTrend = this.calculateVolumeTrend(mint, priceHistory);

    const state: StateVector = {
      priceChange1m: this.clamp(priceChange1m / 100, -1, 1), // Normalize to [-1, 1]
      priceChange5m: this.clamp(priceChange5m / 100, -1, 1),
      volumeZScore: this.clamp(volumeZScore / 5, -1, 1), // Normalize z-score
      buySellRatio: this.clamp(buySellRatio, 0, 1),
      holderCount,
      top10Concentration,
      mintRevoked,
      freezeRevoked,
      lpLocked,
      ageMinutes,
      tradeIntensity,
      marketCapSol,
      // NEW: Additional features
      drawdownFromPeak: this.clamp(drawdownFromPeak, 0, 1),
      volatility: this.clamp(volatility, 0, 1),
      uniqueTraders: this.clamp(uniqueTraders, 0, 1),
      volumeTrend: this.clamp(volumeTrend, -1, 1),
    };

    // Store in history
    this.updateHistory(mint, state);

    return state;
  }

  getFeatureHistory(mint: string): StateVector[] {
    return this.featureHistories.get(mint)?.features || [];
  }

  private calculatePriceChange(history: PriceData[], seconds: number): number {
    if (history.length < 2) return 0;

    const targetTime = Date.now() - seconds * 1000;
    const currentPrice = history[history.length - 1].priceSol;

    // Find price closest to target time
    let pastPrice = currentPrice;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].timestamp.getTime() <= targetTime) {
        pastPrice = history[i].priceSol;
        break;
      }
    }

    if (pastPrice === 0) return 0;
    return ((currentPrice - pastPrice) / pastPrice) * 100;
  }

  private calculateVolumeZScore(history: PriceData[], mint?: string): number {
    // PREFER real trade count from velocity tracker
    if (mint) {
      const velocityMetrics = velocityTracker.getMetrics(mint);
      if (velocityMetrics && velocityMetrics.txCount >= 3) {
        // Normalize trade count: 10 trades = 0 (neutral), 20+ = +2, 5 = -1
        // This gives a z-score-like value based on activity level
        const expectedTradesPerMin = 10;
        const zScore = (velocityMetrics.txPerMinute - expectedTradesPerMin) / 5;
        return zScore;
      }
    }

    // FALLBACK: Use liquidity changes as volume proxy
    if (history.length < 10) return 0;

    const volumes = history.map((h) => h.volume24h || 0);
    const recentVolume = volumes[volumes.length - 1];

    const mean = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const stdDev = Math.sqrt(
      volumes.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / volumes.length
    );

    if (stdDev === 0) return 0;
    return (recentVolume - mean) / stdDev;
  }

  private calculateBuySellRatio(history: PriceData[], mint?: string): number {
    // PREFER real buy/sell ratio from velocity tracker
    if (mint) {
      const velocityMetrics = velocityTracker.getMetrics(mint);
      if (velocityMetrics && velocityMetrics.txCount >= 5) {
        // Use actual buy pressure from real trades
        return velocityMetrics.buyPressure;
      }
    }

    // FALLBACK: Infer buy/sell from price movements
    if (history.length < 2) return 0.5;

    let buys = 0;
    let sells = 0;

    for (let i = 1; i < history.length; i++) {
      const change = history[i].priceSol - history[i - 1].priceSol;
      if (change > 0) buys++;
      else if (change < 0) sells++;
    }

    const total = buys + sells;
    if (total === 0) return 0.5;

    return buys / total;
  }

  private calculateTradeIntensity(history: PriceData[], mint?: string): number {
    // PREFER real trade count from velocity tracker
    if (mint) {
      const velocityMetrics = velocityTracker.getMetrics(mint);
      if (velocityMetrics && velocityMetrics.txCount >= 3) {
        // Normalize trade intensity: 0 trades/min = 0, 10+ trades/min = 1
        const intensity = Math.min(velocityMetrics.txPerMinute / 10, 1);
        return intensity;
      }
    }

    // FALLBACK: Count significant price changes as proxy for trade activity
    if (history.length < 10) return 0.5;

    let significantChanges = 0;
    const threshold = 0.001; // 0.1% change threshold

    for (let i = 1; i < history.length; i++) {
      const change = Math.abs(
        (history[i].priceSol - history[i - 1].priceSol) / history[i - 1].priceSol
      );
      if (change > threshold) significantChanges++;
    }

    // Normalize: 0 = no activity, 1 = constant activity
    return Math.min(significantChanges / history.length, 1);
  }

  private normalizeHolderCount(count: number): number {
    // Log scale normalization
    // 10 holders -> ~0.3, 100 holders -> ~0.5, 1000 holders -> ~0.75, 10000 -> ~1.0
    if (count <= 0) return 0;
    return Math.min(Math.log10(count) / 4, 1);
  }

  private normalizeAge(minutes: number): number {
    // Sigmoid normalization
    // 0 min -> 0, 30 min -> ~0.5, 60 min -> ~0.75, 240 min -> ~0.95
    return 1 - 1 / (1 + minutes / 30);
  }

  private normalizeMarketCap(marketCapSol: number): number {
    // Log scale: 10 SOL -> ~0.25, 100 SOL -> ~0.5, 1000 SOL -> ~0.75, 10000 SOL -> 1.0
    if (marketCapSol <= 0) return 0;
    return Math.min(Math.log10(marketCapSol) / 4, 1);
  }

  /**
   * NEW: Calculate drawdown from peak price
   * Returns 0-1 where 0 = at peak, 1 = 100% below peak
   */
  private calculateDrawdownFromPeak(mint: string, priceHistory: PriceData[], currentPrice: number): number {
    // Try to get peak price from watchlist first (most accurate)
    const watchedToken = tokenWatchlist.getToken(mint);
    if (watchedToken && watchedToken.peakPrice > 0) {
      const drawdown = (watchedToken.peakPrice - currentPrice) / watchedToken.peakPrice;
      return Math.max(0, drawdown);
    }

    // Fallback: calculate from price history
    if (priceHistory.length < 2) return 0;

    const prices = priceHistory.map(p => p.priceSol);
    const peakPrice = Math.max(...prices);

    if (peakPrice <= 0) return 0;
    const drawdown = (peakPrice - currentPrice) / peakPrice;
    return Math.max(0, drawdown);
  }

  /**
   * NEW: Calculate volatility as standard deviation of recent price changes
   * Returns 0-1 where higher = more volatile
   */
  private calculateVolatility(priceHistory: PriceData[]): number {
    if (priceHistory.length < 5) return 0.5; // Default to medium volatility

    const prices = priceHistory.map(p => p.priceSol);

    // Calculate returns (percentage changes)
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) {
        returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
      }
    }

    if (returns.length === 0) return 0.5;

    // Calculate standard deviation of returns
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    // Normalize: 0% stdDev = 0, 10% stdDev = 0.5, 20%+ stdDev = 1
    return Math.min(stdDev / 0.2, 1);
  }

  /**
   * NEW: Calculate unique traders (normalized)
   * Uses watchlist data if available, returns 0-1
   */
  private calculateUniqueTraders(mint: string): number {
    const watchedToken = tokenWatchlist.getToken(mint);
    if (!watchedToken || watchedToken.trades.length === 0) {
      return 0.5; // Default to medium
    }

    // Count unique traders
    const uniqueTraderSet = new Set(watchedToken.trades.map(t => t.traderPublicKey));
    const count = uniqueTraderSet.size;

    // Normalize: 0 traders = 0, 25 traders = 0.5, 50+ traders = 1
    return Math.min(count / 50, 1);
  }

  /**
   * NEW: Calculate volume trend (acceleration/deceleration)
   * Returns -1 to 1 where:
   *  - Positive = volume accelerating (more recent volume)
   *  - Negative = volume decelerating (less recent volume)
   *  - 0 = stable volume
   */
  private calculateVolumeTrend(mint: string, priceHistory: PriceData[]): number {
    // Try watchlist for trade-based volume trend first
    const watchedToken = tokenWatchlist.getToken(mint);
    if (watchedToken && watchedToken.volumeHistory.length >= 2) {
      const recent = watchedToken.volumeHistory[watchedToken.volumeHistory.length - 1]?.count || 0;
      const previous = watchedToken.volumeHistory[watchedToken.volumeHistory.length - 2]?.count || 1;

      if (previous > 0) {
        const ratio = recent / previous;
        // Convert ratio to -1 to 1 scale: 0.5x = -0.5, 1x = 0, 2x = 0.5, 3x+ = 1
        return Math.max(-1, Math.min(1, (ratio - 1) * 0.5));
      }
    }

    // Fallback: use price history volume
    if (priceHistory.length < 10) return 0;

    const midpoint = Math.floor(priceHistory.length / 2);
    const firstHalf = priceHistory.slice(0, midpoint);
    const secondHalf = priceHistory.slice(midpoint);

    const firstVolume = firstHalf.reduce((sum, p) => sum + (p.volume24h || 0), 0) / firstHalf.length;
    const secondVolume = secondHalf.reduce((sum, p) => sum + (p.volume24h || 0), 0) / secondHalf.length;

    if (firstVolume <= 0) return 0;

    const ratio = secondVolume / firstVolume;
    // Convert ratio to -1 to 1 scale
    return Math.max(-1, Math.min(1, (ratio - 1) * 0.5));
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private updateHistory(mint: string, state: StateVector): void {
    let history = this.featureHistories.get(mint);

    if (!history) {
      history = {
        mint,
        features: [],
        timestamps: [],
        maxHistory: this.maxHistoryLength,
      };
      this.featureHistories.set(mint, history);
    }

    history.features.push(state);
    history.timestamps.push(new Date());

    // Trim old entries
    if (history.features.length > history.maxHistory) {
      history.features = history.features.slice(-history.maxHistory);
      history.timestamps = history.timestamps.slice(-history.maxHistory);
    }
  }

  toArray(state: StateVector): number[] {
    return [
      state.priceChange1m,
      state.priceChange5m,
      state.volumeZScore,
      state.buySellRatio,
      state.holderCount,
      state.top10Concentration,
      state.mintRevoked,
      state.freezeRevoked,
      state.lpLocked,
      state.ageMinutes,
      state.tradeIntensity,
      state.marketCapSol,
      // NEW: 4 additional features
      state.drawdownFromPeak,
      state.volatility,
      state.uniqueTraders,
      state.volumeTrend,
    ];
  }

  fromArray(arr: number[]): StateVector {
    return {
      priceChange1m: arr[0],
      priceChange5m: arr[1],
      volumeZScore: arr[2],
      buySellRatio: arr[3],
      holderCount: arr[4],
      top10Concentration: arr[5],
      mintRevoked: arr[6],
      freezeRevoked: arr[7],
      lpLocked: arr[8],
      ageMinutes: arr[9],
      tradeIntensity: arr[10],
      marketCapSol: arr[11],
      // NEW: 4 additional features
      drawdownFromPeak: arr[12] ?? 0,
      volatility: arr[13] ?? 0.5,
      uniqueTraders: arr[14] ?? 0.5,
      volumeTrend: arr[15] ?? 0,
    };
  }

  clearHistory(mint: string): void {
    this.featureHistories.delete(mint);
  }
}

export const featureExtractor = new FeatureExtractor();
