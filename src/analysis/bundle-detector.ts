/**
 * Bundle Detector - Identifies coordinated/bundled transactions
 *
 * Detects manipulation patterns:
 * - Timing clusters (multiple buys within seconds)
 * - Similar transaction amounts (preset bot parameters)
 * - New wallet clusters (wallets created same time)
 * - Same-block transactions (Jito bundles)
 *
 * Based on methodology from solana-bundler-detector
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('bundle-detector');

/**
 * Transaction for bundle analysis
 */
interface BundleTransaction {
  signature: string;
  timestamp: number;
  slot: number;
  wallet: string;
  amount: number; // SOL amount
  type: 'buy' | 'sell';
}

/**
 * Bundle detection result
 */
export interface BundleAnalysis {
  isBundled: boolean;
  bundleScore: number; // 0-100
  flags: string[];
  clusters: TransactionCluster[];
  metrics: {
    timingScore: number;      // Transactions within suspicious windows
    amountScore: number;      // Similar amounts suggest bots
    walletAgeScore: number;   // New wallets = suspicious
    concentrationScore: number; // Few wallets buying a lot
  };
}

/**
 * A cluster of related transactions
 */
interface TransactionCluster {
  transactions: BundleTransaction[];
  timeSpanMs: number;
  avgAmount: number;
  amountVariance: number;
}

/**
 * Bundle detection thresholds
 */
interface BundleThresholds {
  timeWindowMs: number;        // Max time between txs to be considered cluster (default: 30s)
  minClusterSize: number;      // Minimum txs to form cluster (default: 3)
  maxAmountVariance: number;   // Max variance in amounts to be suspicious (default: 0.2 = 20%)
  maxWalletAgeHours: number;   // Wallets younger than this are suspicious (default: 24)
  sameBlockWeight: number;     // Extra weight for same-block txs (default: 2.0)
}

const DEFAULT_THRESHOLDS: BundleThresholds = {
  timeWindowMs: 30000,        // 30 seconds
  minClusterSize: 3,          // 3+ transactions
  maxAmountVariance: 0.2,     // 20% variance
  maxWalletAgeHours: 24,      // 24 hours
  sameBlockWeight: 2.0,       // Double weight for same-block
};

/**
 * Bundle Detector
 *
 * Analyzes transactions for a token to detect coordinated buying patterns.
 */
export class BundleDetector {
  private thresholds: BundleThresholds;

  constructor(thresholds?: Partial<BundleThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Analyze transactions for bundle patterns.
   *
   * @param transactions - List of transactions to analyze
   * @returns Bundle analysis with score and flags
   */
  analyze(transactions: BundleTransaction[]): BundleAnalysis {
    if (transactions.length < this.thresholds.minClusterSize) {
      return this.createEmptyResult();
    }

    // Sort by timestamp
    const sorted = [...transactions].sort((a, b) => a.timestamp - b.timestamp);

    // Find timing clusters
    const clusters = this.findTimingClusters(sorted);

    // Calculate individual scores
    const timingScore = this.calculateTimingScore(clusters, sorted.length);
    const amountScore = this.calculateAmountScore(clusters);
    const walletAgeScore = 0; // Would need wallet creation data
    const concentrationScore = this.calculateConcentrationScore(sorted);

    // Weighted composite score
    // Based on solana-bundler-detector weights
    const bundleScore = Math.min(100, Math.round(
      timingScore * 0.4 +      // 40% timing
      amountScore * 0.3 +      // 30% amount similarity
      walletAgeScore * 0.2 +   // 20% wallet age
      concentrationScore * 0.1  // 10% concentration
    ));

    // Generate flags
    const flags = this.generateFlags(timingScore, amountScore, concentrationScore, clusters);

    const isBundled = bundleScore >= 50 || flags.length >= 2;

    logger.debug({
      txCount: transactions.length,
      clusterCount: clusters.length,
      bundleScore,
      isBundled,
    }, 'Bundle analysis complete');

    return {
      isBundled,
      bundleScore,
      flags,
      clusters,
      metrics: {
        timingScore,
        amountScore,
        walletAgeScore,
        concentrationScore,
      },
    };
  }

  /**
   * Quick check for same-block transactions (Jito bundles).
   */
  detectSameBlockBundle(transactions: BundleTransaction[]): boolean {
    if (transactions.length < 2) return false;

    // Group by slot
    const bySlot = new Map<number, BundleTransaction[]>();
    for (const tx of transactions) {
      const existing = bySlot.get(tx.slot) || [];
      existing.push(tx);
      bySlot.set(tx.slot, existing);
    }

    // Check if any slot has 3+ transactions
    for (const [slot, txs] of bySlot) {
      if (txs.length >= 3) {
        logger.warn({
          slot,
          txCount: txs.length,
          wallets: txs.map(t => t.wallet.slice(0, 8)),
        }, 'Same-block bundle detected (likely Jito)');
        return true;
      }
    }

    return false;
  }

  /**
   * Find clusters of transactions within time windows.
   */
  private findTimingClusters(sorted: BundleTransaction[]): TransactionCluster[] {
    const clusters: TransactionCluster[] = [];
    let currentCluster: BundleTransaction[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const tx = sorted[i];

      if (currentCluster.length === 0) {
        currentCluster.push(tx);
        continue;
      }

      const lastTx = currentCluster[currentCluster.length - 1];
      const timeDiff = tx.timestamp - lastTx.timestamp;

      if (timeDiff <= this.thresholds.timeWindowMs) {
        currentCluster.push(tx);
      } else {
        // Save current cluster if large enough
        if (currentCluster.length >= this.thresholds.minClusterSize) {
          clusters.push(this.createCluster(currentCluster));
        }
        currentCluster = [tx];
      }
    }

    // Don't forget last cluster
    if (currentCluster.length >= this.thresholds.minClusterSize) {
      clusters.push(this.createCluster(currentCluster));
    }

    return clusters;
  }

  /**
   * Create a cluster object with statistics.
   */
  private createCluster(transactions: BundleTransaction[]): TransactionCluster {
    const amounts = transactions.map(t => t.amount);
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;

    // Calculate variance
    const variance = amounts.reduce((sum, a) => sum + Math.pow(a - avgAmount, 2), 0) / amounts.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = avgAmount > 0 ? stdDev / avgAmount : 0;

    const timeSpanMs = transactions[transactions.length - 1].timestamp - transactions[0].timestamp;

    return {
      transactions,
      timeSpanMs,
      avgAmount,
      amountVariance: coefficientOfVariation,
    };
  }

  /**
   * Score based on timing patterns.
   * High score = many transactions in tight windows.
   */
  private calculateTimingScore(clusters: TransactionCluster[], totalTxs: number): number {
    if (clusters.length === 0 || totalTxs === 0) return 0;

    // What percentage of txs are in clusters?
    const clusteredTxs = clusters.reduce((sum, c) => sum + c.transactions.length, 0);
    const clusterRatio = clusteredTxs / totalTxs;

    // Bonus for very tight clusters (< 5 seconds)
    const tightClusters = clusters.filter(c => c.timeSpanMs < 5000);
    const tightBonus = tightClusters.length * 10;

    return Math.min(100, Math.round(clusterRatio * 80 + tightBonus));
  }

  /**
   * Score based on amount similarity.
   * Low variance = bot-like behavior.
   */
  private calculateAmountScore(clusters: TransactionCluster[]): number {
    if (clusters.length === 0) return 0;

    // Average variance across clusters
    const avgVariance = clusters.reduce((sum, c) => sum + c.amountVariance, 0) / clusters.length;

    // Low variance = high score (suspicious)
    if (avgVariance < 0.05) return 100;  // < 5% variance = very suspicious
    if (avgVariance < 0.1) return 80;    // < 10% variance
    if (avgVariance < 0.2) return 50;    // < 20% variance
    if (avgVariance < 0.3) return 25;    // < 30% variance

    return 0;
  }

  /**
   * Score based on concentration of buying.
   * Few wallets buying a lot = suspicious.
   */
  private calculateConcentrationScore(transactions: BundleTransaction[]): number {
    if (transactions.length < 5) return 0;

    // Count transactions per wallet
    const walletCounts = new Map<string, number>();
    for (const tx of transactions) {
      walletCounts.set(tx.wallet, (walletCounts.get(tx.wallet) || 0) + 1);
    }

    const uniqueWallets = walletCounts.size;
    const totalTxs = transactions.length;

    // Ratio of unique wallets to transactions
    // Low ratio = few wallets doing many txs = suspicious
    const ratio = uniqueWallets / totalTxs;

    if (ratio < 0.3) return 100;  // < 30% unique = very concentrated
    if (ratio < 0.5) return 70;
    if (ratio < 0.7) return 40;

    return 0;
  }

  /**
   * Generate human-readable flags.
   */
  private generateFlags(
    timingScore: number,
    amountScore: number,
    concentrationScore: number,
    clusters: TransactionCluster[]
  ): string[] {
    const flags: string[] = [];

    if (timingScore >= 70) {
      flags.push('TIMING_CLUSTER: Multiple buys within seconds');
    }

    if (amountScore >= 70) {
      flags.push('SIMILAR_AMOUNTS: Transaction sizes nearly identical');
    }

    if (concentrationScore >= 70) {
      flags.push('CONCENTRATED: Few wallets, many transactions');
    }

    // Check for same-slot transactions
    for (const cluster of clusters) {
      const slots = new Set(cluster.transactions.map(t => t.slot));
      if (slots.size === 1 && cluster.transactions.length >= 3) {
        flags.push('SAME_BLOCK: Likely Jito bundle');
        break;
      }
    }

    return flags;
  }

  /**
   * Create empty result for insufficient data.
   */
  private createEmptyResult(): BundleAnalysis {
    return {
      isBundled: false,
      bundleScore: 0,
      flags: [],
      clusters: [],
      metrics: {
        timingScore: 0,
        amountScore: 0,
        walletAgeScore: 0,
        concentrationScore: 0,
      },
    };
  }
}

export { BundleTransaction, BundleThresholds };
