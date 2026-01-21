/**
 * Momentum Scanner - Detects early pump signals
 *
 * Based on memecoin.watch methodology:
 * - Heat metric: (1min_volume / 5min_volume) * 100
 * - Consecutive buy sequences
 * - Buy/Sell ratio
 * - Price stepping patterns
 *
 * Distinguishes genuine retail buying waves from bot manipulation.
 */

import { createLogger } from '../lib/logger.js';

const logger = createLogger('momentum-scanner');

/**
 * Trade event for momentum analysis
 */
export interface TradeEvent {
  timestamp: number;
  type: 'buy' | 'sell';
  solAmount: number;
  tokenAmount: number;
  pricePerToken: number;
  walletAge?: number; // Age in hours, if known
  signature: string;
}

/**
 * Momentum analysis result
 */
export interface MomentumAnalysis {
  score: number;              // 0-100 overall momentum score
  heatMetric: number;         // (1min_vol / 5min_vol) * 100
  buyPressure: number;        // Buy/sell ratio
  consecutiveBuys: number;    // Current streak of buys
  priceSteps: number;         // Number of price step-ups
  alerts: MomentumAlert[];
  phase: 'cold' | 'building' | 'hot' | 'peak' | 'cooling';
  recommendation: 'buy' | 'wait' | 'avoid';
}

/**
 * Momentum alert
 */
export interface MomentumAlert {
  type: 'heat' | 'buy_streak' | 'price_step' | 'volume_spike' | 'whale' | 'warning';
  message: string;
  severity: 'info' | 'medium' | 'high';
}

/**
 * Configuration for momentum scanner
 */
export interface MomentumConfig {
  /** Heat thresholds */
  heatBuilding: number;      // Start of building phase (default: 33)
  heatHot: number;           // Hot phase (default: 48)
  heatPeak: number;          // Peak/caution phase (default: 100)

  /** Minimum consecutive buys to trigger alert */
  minConsecutiveBuys: number;

  /** Minimum price step % to count */
  minPriceStepPercent: number;

  /** Minimum buy/sell ratio for bullish signal */
  minBuySellRatio: number;

  /** Volume spike threshold (multiple of average) */
  volumeSpikeMultiple: number;

  /** Whale threshold in SOL */
  whaleThresholdSol: number;

  /** Maximum wallet age (hours) for "new wallet" flag */
  newWalletMaxHours: number;
}

const DEFAULT_CONFIG: MomentumConfig = {
  heatBuilding: 33,
  heatHot: 48,
  heatPeak: 100,
  minConsecutiveBuys: 5,
  minPriceStepPercent: 0.2,
  minBuySellRatio: 1.2,
  volumeSpikeMultiple: 3,
  whaleThresholdSol: 5,
  newWalletMaxHours: 24,
};

/**
 * Momentum Scanner
 *
 * Analyzes trade flow to detect momentum and early pump signals.
 */
export class MomentumScanner {
  private config: MomentumConfig;
  private tradeHistory: Map<string, TradeEvent[]> = new Map(); // token -> trades

  constructor(config?: Partial<MomentumConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info({ config: this.config }, 'MomentumScanner initialized');
  }

  /**
   * Add a trade event to the history.
   */
  addTrade(tokenMint: string, trade: TradeEvent): void {
    const trades = this.tradeHistory.get(tokenMint) || [];
    trades.push(trade);

    // Keep only last 15 minutes of trades
    const cutoff = Date.now() - 15 * 60 * 1000;
    const filtered = trades.filter(t => t.timestamp > cutoff);

    this.tradeHistory.set(tokenMint, filtered);
  }

  /**
   * Analyze momentum for a token.
   */
  analyze(tokenMint: string): MomentumAnalysis {
    const trades = this.tradeHistory.get(tokenMint) || [];

    if (trades.length < 3) {
      return this.createColdResult();
    }

    const now = Date.now();
    const oneMinAgo = now - 60 * 1000;
    const fiveMinAgo = now - 5 * 60 * 1000;

    // Split trades by timeframe
    const trades1m = trades.filter(t => t.timestamp > oneMinAgo);
    const trades5m = trades.filter(t => t.timestamp > fiveMinAgo);

    // Calculate metrics
    const heatMetric = this.calculateHeat(trades1m, trades5m);
    const buyPressure = this.calculateBuyPressure(trades5m);
    const consecutiveBuys = this.countConsecutiveBuys(trades);
    const priceSteps = this.countPriceSteps(trades5m);

    // Generate alerts
    const alerts = this.generateAlerts(trades5m, heatMetric, buyPressure, consecutiveBuys);

    // Determine phase
    const phase = this.determinePhase(heatMetric);

    // Calculate overall score
    const score = this.calculateScore(heatMetric, buyPressure, consecutiveBuys, priceSteps);

    // Generate recommendation
    const recommendation = this.generateRecommendation(score, phase, alerts);

    logger.debug({
      tokenMint: tokenMint.slice(0, 8),
      score,
      heatMetric,
      phase,
      recommendation,
    }, 'Momentum analysis complete');

    return {
      score,
      heatMetric,
      buyPressure,
      consecutiveBuys,
      priceSteps,
      alerts,
      phase,
      recommendation,
    };
  }

  /**
   * Calculate heat metric: (1min_volume / 5min_volume) * 100
   */
  private calculateHeat(trades1m: TradeEvent[], trades5m: TradeEvent[]): number {
    const vol1m = trades1m.reduce((sum, t) => sum + t.solAmount, 0);
    const vol5m = trades5m.reduce((sum, t) => sum + t.solAmount, 0);

    if (vol5m === 0) return 0;

    // Heat = what % of 5min volume happened in last 1min
    // High heat = acceleration
    return (vol1m / vol5m) * 100;
  }

  /**
   * Calculate buy/sell pressure ratio.
   */
  private calculateBuyPressure(trades: TradeEvent[]): number {
    const buys = trades.filter(t => t.type === 'buy');
    const sells = trades.filter(t => t.type === 'sell');

    const buyVol = buys.reduce((sum, t) => sum + t.solAmount, 0);
    const sellVol = sells.reduce((sum, t) => sum + t.solAmount, 0);

    if (sellVol === 0) return buyVol > 0 ? 10 : 1; // Cap at 10x

    return Math.min(10, buyVol / sellVol);
  }

  /**
   * Count consecutive buys at the end of the trade list.
   */
  private countConsecutiveBuys(trades: TradeEvent[]): number {
    if (trades.length === 0) return 0;

    let count = 0;
    // Count from most recent backwards
    for (let i = trades.length - 1; i >= 0; i--) {
      if (trades[i].type === 'buy') {
        count++;
      } else {
        break;
      }
    }

    return count;
  }

  /**
   * Count price step-ups (minimum 0.2% increase).
   */
  private countPriceSteps(trades: TradeEvent[]): number {
    if (trades.length < 2) return 0;

    let steps = 0;
    let lastPrice = trades[0].pricePerToken;

    for (let i = 1; i < trades.length; i++) {
      const price = trades[i].pricePerToken;
      const change = (price - lastPrice) / lastPrice;

      if (change >= this.config.minPriceStepPercent / 100) {
        steps++;
      }

      lastPrice = price;
    }

    return steps;
  }

  /**
   * Generate alerts based on analysis.
   */
  private generateAlerts(
    trades: TradeEvent[],
    heatMetric: number,
    buyPressure: number,
    consecutiveBuys: number
  ): MomentumAlert[] {
    const alerts: MomentumAlert[] = [];

    // Heat alerts
    if (heatMetric >= this.config.heatPeak) {
      alerts.push({
        type: 'heat',
        message: `PEAK HEAT: ${heatMetric.toFixed(0)}% - Exercise caution`,
        severity: 'high',
      });
    } else if (heatMetric >= this.config.heatHot) {
      alerts.push({
        type: 'heat',
        message: `HOT: Heat at ${heatMetric.toFixed(0)}%`,
        severity: 'medium',
      });
    } else if (heatMetric >= this.config.heatBuilding) {
      alerts.push({
        type: 'heat',
        message: `BUILDING: Heat at ${heatMetric.toFixed(0)}%`,
        severity: 'info',
      });
    }

    // Consecutive buys alert
    if (consecutiveBuys >= this.config.minConsecutiveBuys) {
      alerts.push({
        type: 'buy_streak',
        message: `${consecutiveBuys} consecutive buys`,
        severity: consecutiveBuys >= 10 ? 'high' : 'medium',
      });
    }

    // Buy pressure alert
    if (buyPressure >= this.config.minBuySellRatio) {
      alerts.push({
        type: 'volume_spike',
        message: `Buy pressure ${buyPressure.toFixed(1)}x sells`,
        severity: buyPressure >= 3 ? 'high' : 'medium',
      });
    }

    // Whale detection
    const whales = trades.filter(t =>
      t.type === 'buy' && t.solAmount >= this.config.whaleThresholdSol
    );
    if (whales.length > 0) {
      const totalWhaleVol = whales.reduce((sum, t) => sum + t.solAmount, 0);
      alerts.push({
        type: 'whale',
        message: `${whales.length} whale buy(s): ${totalWhaleVol.toFixed(1)} SOL`,
        severity: 'high',
      });
    }

    // New wallet warning
    const newWallets = trades.filter(t =>
      t.walletAge !== undefined && t.walletAge < this.config.newWalletMaxHours
    );
    if (newWallets.length >= 3) {
      alerts.push({
        type: 'warning',
        message: `${newWallets.length} new wallets buying (<24h old)`,
        severity: 'medium',
      });
    }

    return alerts;
  }

  /**
   * Determine momentum phase based on heat.
   */
  private determinePhase(heatMetric: number): 'cold' | 'building' | 'hot' | 'peak' | 'cooling' {
    if (heatMetric >= this.config.heatPeak) return 'peak';
    if (heatMetric >= this.config.heatHot) return 'hot';
    if (heatMetric >= this.config.heatBuilding) return 'building';
    return 'cold';
  }

  /**
   * Calculate overall momentum score (0-100).
   */
  private calculateScore(
    heatMetric: number,
    buyPressure: number,
    consecutiveBuys: number,
    priceSteps: number
  ): number {
    let score = 0;

    // Heat contribution (0-40 points)
    score += Math.min(40, heatMetric * 0.4);

    // Buy pressure contribution (0-25 points)
    score += Math.min(25, (buyPressure - 1) * 12.5);

    // Consecutive buys contribution (0-20 points)
    score += Math.min(20, consecutiveBuys * 2);

    // Price steps contribution (0-15 points)
    score += Math.min(15, priceSteps * 3);

    return Math.min(100, Math.round(score));
  }

  /**
   * Generate trading recommendation.
   */
  private generateRecommendation(
    score: number,
    phase: string,
    alerts: MomentumAlert[]
  ): 'buy' | 'wait' | 'avoid' {
    // Check for warnings
    const hasWarnings = alerts.some(a => a.type === 'warning');

    // Peak phase = risky, might dump
    if (phase === 'peak') {
      return 'avoid';
    }

    // Hot phase with good score = buy opportunity
    if (phase === 'hot' && score >= 60 && !hasWarnings) {
      return 'buy';
    }

    // Building phase with very high score = early opportunity
    if (phase === 'building' && score >= 70 && !hasWarnings) {
      return 'buy';
    }

    // Cold or low score = wait
    if (score < 40 || phase === 'cold') {
      return 'wait';
    }

    return 'wait';
  }

  /**
   * Create empty/cold result.
   */
  private createColdResult(): MomentumAnalysis {
    return {
      score: 0,
      heatMetric: 0,
      buyPressure: 1,
      consecutiveBuys: 0,
      priceSteps: 0,
      alerts: [],
      phase: 'cold',
      recommendation: 'wait',
    };
  }

  /**
   * Clear trade history for a token.
   */
  clearToken(tokenMint: string): void {
    this.tradeHistory.delete(tokenMint);
  }

  /**
   * Clear all trade history.
   */
  clearAll(): void {
    this.tradeHistory.clear();
  }

  /**
   * Get scanner statistics.
   */
  getStats(): {
    tokensTracked: number;
    totalTrades: number;
  } {
    let totalTrades = 0;
    for (const trades of this.tradeHistory.values()) {
      totalTrades += trades.length;
    }

    return {
      tokensTracked: this.tradeHistory.size,
      totalTrades,
    };
  }
}
