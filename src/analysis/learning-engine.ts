/**
 * Learning Engine - Tracks trade outcomes and learns what works
 *
 * After each trade closes:
 * 1. Extract features that were present at entry
 * 2. Record outcome (win/loss, PnL %)
 * 3. Update feature weights based on correlation with wins
 * 4. Adjust future scoring based on learned patterns
 *
 * Inspired by FreqAI's adaptive learning and LLM_Trader's self-improvement.
 */

import { createLogger } from '../lib/logger.js';
import type { DatabaseWithRepositories } from '../db/database-with-repos.js';

const logger = createLogger('learning-engine');

/**
 * Features extracted at trade entry time
 */
export interface TradeFeatures {
  // Market structure
  bondingCurveProgress: number;    // 0-100%
  marketCapSol: number;
  liquidity: number;
  tokenAgeMins: number;

  // Volume/momentum
  buyCount5m: number;
  sellCount5m: number;
  buyVolume5m: number;
  sellVolume5m: number;
  heatMetric: number;              // (1min_vol / 5min_vol) * 100

  // Holder analysis
  holderCount: number;
  topHolderPercent: number;        // Top holder's %
  top10HoldersPercent: number;

  // Smart money
  smartMoneyCount: number;
  smartMoneyBuying: boolean;

  // Safety
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  isBundled: boolean;
  bundleScore: number;

  // Social (if available)
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
}

/**
 * A completed trade with features and outcome
 */
export interface TradeLesson {
  id: string;
  tokenMint: string;
  tokenSymbol?: string;
  entryTimestamp: number;
  exitTimestamp: number;
  features: TradeFeatures;
  outcome: 'win' | 'loss';
  pnlPercent: number;
  pnlSol: number;
  holdTimeMs: number;
  entryPrice: number;
  exitPrice: number;
  confidenceAtEntry: number;
}

/**
 * Feature weight for scoring
 */
interface FeatureWeight {
  name: keyof TradeFeatures;
  weight: number;           // -1 to 1 (negative = avoid, positive = favor)
  winCorrelation: number;   // How correlated with wins
  sampleSize: number;       // How many trades informed this
  lastUpdated: number;
}

/**
 * Confidence calibration data
 */
interface ConfidenceCalibration {
  bucket: string;           // "high" | "medium" | "low"
  minConfidence: number;
  maxConfidence: number;
  totalTrades: number;
  wins: number;
  actualWinRate: number;
  expectedWinRate: number;  // Based on confidence
}

/**
 * Learning engine statistics
 */
export interface LearningStats {
  totalLessons: number;
  wins: number;
  losses: number;
  overallWinRate: number;
  avgWinPnl: number;
  avgLossPnl: number;
  expectancy: number;       // Expected value per trade
  topPositiveFeatures: string[];
  topNegativeFeatures: string[];
  confidenceCalibration: ConfidenceCalibration[];
}

/**
 * Learning Engine
 *
 * Tracks trade outcomes and learns which features predict success.
 */
export class LearningEngine {
  private lessons: TradeLesson[] = [];
  private featureWeights: Map<keyof TradeFeatures, FeatureWeight> = new Map();
  private confidenceBuckets: ConfidenceCalibration[] = [];
  private decayRate = 0.95; // Weight decay per week (older lessons matter less)

  constructor(private db?: DatabaseWithRepositories) {
    this.initializeWeights();
    this.initializeConfidenceBuckets();

    logger.info('LearningEngine initialized');
  }

  /**
   * Initialize feature weights with neutral values.
   */
  private initializeWeights(): void {
    const features: (keyof TradeFeatures)[] = [
      'bondingCurveProgress', 'marketCapSol', 'liquidity', 'tokenAgeMins',
      'buyCount5m', 'sellCount5m', 'buyVolume5m', 'sellVolume5m', 'heatMetric',
      'holderCount', 'topHolderPercent', 'top10HoldersPercent',
      'smartMoneyCount', 'smartMoneyBuying',
      'mintAuthorityRevoked', 'freezeAuthorityRevoked', 'isBundled', 'bundleScore',
      'hasTwitter', 'hasTelegram', 'hasWebsite',
    ];

    for (const feature of features) {
      this.featureWeights.set(feature, {
        name: feature,
        weight: 0,
        winCorrelation: 0,
        sampleSize: 0,
        lastUpdated: Date.now(),
      });
    }
  }

  /**
   * Initialize confidence calibration buckets.
   */
  private initializeConfidenceBuckets(): void {
    this.confidenceBuckets = [
      { bucket: 'low', minConfidence: 0, maxConfidence: 40, totalTrades: 0, wins: 0, actualWinRate: 0, expectedWinRate: 0.25 },
      { bucket: 'medium', minConfidence: 40, maxConfidence: 70, totalTrades: 0, wins: 0, actualWinRate: 0, expectedWinRate: 0.50 },
      { bucket: 'high', minConfidence: 70, maxConfidence: 100, totalTrades: 0, wins: 0, actualWinRate: 0, expectedWinRate: 0.75 },
    ];
  }

  /**
   * Record a completed trade lesson.
   */
  async recordLesson(lesson: TradeLesson): Promise<void> {
    this.lessons.push(lesson);

    // Update feature weights based on outcome
    this.updateWeights(lesson);

    // Update confidence calibration
    this.updateConfidenceCalibration(lesson);

    // Persist to database if available
    if (this.db) {
      try {
        await this.db.analysisCache.set(
          `lesson:${lesson.id}`,
          'learning',
          lesson,
          7 * 24 * 60 * 60 * 1000 // 7 days
        );
      } catch (error) {
        logger.warn({ error }, 'Failed to persist lesson to DB');
      }
    }

    logger.info({
      token: lesson.tokenMint,
      outcome: lesson.outcome,
      pnlPercent: lesson.pnlPercent.toFixed(1),
      totalLessons: this.lessons.length,
    }, 'Trade lesson recorded');
  }

  /**
   * Update feature weights based on a lesson.
   */
  private updateWeights(lesson: TradeLesson): void {
    const isWin = lesson.outcome === 'win';
    const features = lesson.features;

    // For each feature, update its correlation with wins
    for (const [featureName, weight] of this.featureWeights) {
      const featureValue = features[featureName];

      // Skip undefined features
      if (featureValue === undefined) continue;

      // Normalize feature to boolean-ish for correlation
      // (true/high values should correlate with wins for positive features)
      const featureActive = this.isFeatureActive(featureName, featureValue);

      // Update correlation
      // Simple approach: track if feature was present in wins vs losses
      const contribution = isWin ? (featureActive ? 1 : -0.5) : (featureActive ? -1 : 0.5);

      // Apply decay to old weight, then add new contribution
      const decayedWeight = weight.weight * this.decayRate;
      const newWeight = decayedWeight + (contribution * 0.1); // 0.1 learning rate

      // Clamp to [-1, 1]
      weight.weight = Math.max(-1, Math.min(1, newWeight));
      weight.sampleSize++;
      weight.lastUpdated = Date.now();

      // Update win correlation (simple running average)
      const oldCorr = weight.winCorrelation;
      const n = weight.sampleSize;
      const winVal = isWin && featureActive ? 1 : 0;
      weight.winCorrelation = oldCorr + (winVal - oldCorr) / n;

      this.featureWeights.set(featureName, weight);
    }
  }

  /**
   * Determine if a feature is "active" (high/true).
   */
  private isFeatureActive(name: keyof TradeFeatures, value: number | boolean): boolean {
    if (typeof value === 'boolean') return value;

    // Define thresholds for numeric features
    const thresholds: Partial<Record<keyof TradeFeatures, number>> = {
      bondingCurveProgress: 30,    // > 30% progress
      marketCapSol: 50,            // > 50 SOL mcap
      liquidity: 10,               // > 10 SOL liquidity
      tokenAgeMins: 10,            // > 10 mins old
      buyCount5m: 20,              // > 20 buys
      heatMetric: 25,              // > 25% heat
      holderCount: 50,             // > 50 holders
      smartMoneyCount: 1,          // Any smart money
      bundleScore: 50,             // > 50 bundle score (bad)
    };

    const threshold = thresholds[name];
    if (threshold !== undefined) {
      return value > threshold;
    }

    return value > 0;
  }

  /**
   * Update confidence calibration with new outcome.
   */
  private updateConfidenceCalibration(lesson: TradeLesson): void {
    const confidence = lesson.confidenceAtEntry;
    const isWin = lesson.outcome === 'win';

    for (const bucket of this.confidenceBuckets) {
      if (confidence >= bucket.minConfidence && confidence < bucket.maxConfidence) {
        bucket.totalTrades++;
        if (isWin) bucket.wins++;
        bucket.actualWinRate = bucket.totalTrades > 0
          ? bucket.wins / bucket.totalTrades
          : 0;
        break;
      }
    }
  }

  /**
   * Score a set of features based on learned weights.
   * Returns adjustment to base confidence.
   */
  scoreFeatures(features: TradeFeatures): {
    adjustment: number;
    reasons: string[];
    warnings: string[];
  } {
    let adjustment = 0;
    const reasons: string[] = [];
    const warnings: string[] = [];

    for (const [featureName, weight] of this.featureWeights) {
      if (weight.sampleSize < 5) continue; // Need minimum samples

      const featureValue = features[featureName];
      if (featureValue === undefined) continue;

      const isActive = this.isFeatureActive(featureName, featureValue);

      if (isActive && weight.weight > 0.3) {
        adjustment += weight.weight * 10;
        reasons.push(`${featureName}: positive signal (w=${weight.weight.toFixed(2)})`);
      } else if (isActive && weight.weight < -0.3) {
        adjustment += weight.weight * 10;
        warnings.push(`${featureName}: negative signal (w=${weight.weight.toFixed(2)})`);
      }
    }

    return {
      adjustment: Math.max(-30, Math.min(30, adjustment)), // Cap at ±30
      reasons,
      warnings,
    };
  }

  /**
   * Get insights about what's working and what's not.
   */
  getInsights(): {
    bestFeatures: { name: string; weight: number; correlation: number }[];
    worstFeatures: { name: string; weight: number; correlation: number }[];
    calibrationIssues: string[];
  } {
    const features = Array.from(this.featureWeights.values())
      .filter(w => w.sampleSize >= 5)
      .sort((a, b) => b.weight - a.weight);

    const bestFeatures = features.slice(0, 5).map(f => ({
      name: f.name,
      weight: f.weight,
      correlation: f.winCorrelation,
    }));

    const worstFeatures = features.slice(-5).reverse().map(f => ({
      name: f.name,
      weight: f.weight,
      correlation: f.winCorrelation,
    }));

    const calibrationIssues: string[] = [];
    for (const bucket of this.confidenceBuckets) {
      if (bucket.totalTrades >= 10) {
        const diff = bucket.actualWinRate - bucket.expectedWinRate;
        if (Math.abs(diff) > 0.2) {
          calibrationIssues.push(
            `${bucket.bucket} confidence: expected ${(bucket.expectedWinRate * 100).toFixed(0)}% ` +
            `win rate, actual ${(bucket.actualWinRate * 100).toFixed(0)}%`
          );
        }
      }
    }

    return { bestFeatures, worstFeatures, calibrationIssues };
  }

  /**
   * Get comprehensive learning statistics.
   */
  getStats(): LearningStats {
    const wins = this.lessons.filter(l => l.outcome === 'win');
    const losses = this.lessons.filter(l => l.outcome === 'loss');

    const avgWinPnl = wins.length > 0
      ? wins.reduce((sum, l) => sum + l.pnlPercent, 0) / wins.length
      : 0;

    const avgLossPnl = losses.length > 0
      ? losses.reduce((sum, l) => sum + l.pnlPercent, 0) / losses.length
      : 0;

    const winRate = this.lessons.length > 0
      ? wins.length / this.lessons.length
      : 0;

    // Expectancy = (WinRate * AvgWin) + ((1 - WinRate) * AvgLoss)
    const expectancy = (winRate * avgWinPnl) + ((1 - winRate) * avgLossPnl);

    const sortedWeights = Array.from(this.featureWeights.values())
      .filter(w => w.sampleSize >= 5)
      .sort((a, b) => b.weight - a.weight);

    const topPositive = sortedWeights.slice(0, 3).map(w => w.name);
    const topNegative = sortedWeights.slice(-3).reverse().map(w => w.name);

    return {
      totalLessons: this.lessons.length,
      wins: wins.length,
      losses: losses.length,
      overallWinRate: winRate,
      avgWinPnl,
      avgLossPnl,
      expectancy,
      topPositiveFeatures: topPositive,
      topNegativeFeatures: topNegative,
      confidenceCalibration: this.confidenceBuckets,
    };
  }

  /**
   * Export lessons for analysis.
   */
  exportLessons(): TradeLesson[] {
    return [...this.lessons];
  }

  /**
   * Import lessons (e.g., from database on startup).
   */
  importLessons(lessons: TradeLesson[]): void {
    for (const lesson of lessons) {
      this.lessons.push(lesson);
      this.updateWeights(lesson);
      this.updateConfidenceCalibration(lesson);
    }

    logger.info({ imported: lessons.length }, 'Imported historical lessons');
  }

  /**
   * Clear all learned data (reset).
   */
  reset(): void {
    this.lessons = [];
    this.initializeWeights();
    this.initializeConfidenceBuckets();
    logger.info('LearningEngine reset');
  }
}
