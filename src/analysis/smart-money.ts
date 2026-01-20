import { WalletAnalyzer } from './wallet-analyzer.js';
import { AnalysisCacheRepository } from '../db/repositories/analysis-cache.js';
import { WalletAnalysis, SmartMoneyThresholds, DEFAULT_THRESHOLDS, CACHE_TTL } from './types.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('smart-money');

/**
 * Smart money classification result.
 */
interface SmartMoneyClassification {
  address: string;
  isSmartMoney: boolean;
  score: number;
  reasons: string[];
  analysis: WalletAnalysis;
  classifiedAt: number;
}

/**
 * Tracker for identifying "smart money" wallets worth following.
 * 
 * Uses threshold-based classification:
 * - Minimum trade count (avoid false positives)
 * - Win rate >= 65%
 * - Realized P&L >= 50 SOL
 * - ROI >= 100%
 * 
 * Results are cached for 24 hours.
 * 
 * @example
 * const tracker = new SmartMoneyTracker(walletAnalyzer, cache);
 * const classification = await tracker.classify('wallet-address');
 * if (classification.isSmartMoney) {
 *   console.log('Smart money detected!', classification.reasons);
 * }
 */
class SmartMoneyTracker {
  private thresholds: SmartMoneyThresholds;

  constructor(
    private walletAnalyzer: WalletAnalyzer,
    private cache: AnalysisCacheRepository,
    thresholds?: SmartMoneyThresholds
  ) {
    this.thresholds = thresholds || DEFAULT_THRESHOLDS;
  }

  /**
   * Classify a wallet as smart money or not.
   * 
   * Uses wallet analysis to score against thresholds.
   * 
   * @param address - Wallet address (base58)
   * @returns Smart money classification with score and reasons
   */
  async classify(address: string): Promise<SmartMoneyClassification> {
    // Check cache first
    const cached = this.cache.get<SmartMoneyClassification>(address, 'smart_money');
    if (cached) {
      logger.debug({ address }, 'Cache hit for smart money classification');
      return cached;
    }

    // Get wallet analysis
    const analysis = await this.walletAnalyzer.analyze(address);

    // Classify from analysis
    const classification = this.classifyFromAnalysis(address, analysis);

    // Cache result
    this.cache.set(address, 'smart_money', classification, CACHE_TTL.smartMoney);

    logger.info(
      {
        address,
        isSmartMoney: classification.isSmartMoney,
        score: classification.score,
      },
      'Smart money classification complete'
    );

    return classification;
  }

  /**
   * Classify wallet from existing analysis.
   * 
   * Follows Nansen methodology with threshold-based scoring.
   * 
   * @param address - Wallet address
   * @param analysis - Wallet analysis result
   * @returns Smart money classification
   */
  private classifyFromAnalysis(
    address: string,
    analysis: WalletAnalysis
  ): SmartMoneyClassification {
    const reasons: string[] = [];
    let score = 0;

    // Check minimum trade count (avoid false positives)
    if (analysis.metrics.totalTrades < this.thresholds.minTrades) {
      return {
        address,
        isSmartMoney: false,
        score: 0,
        reasons: ['Insufficient trades'],
        analysis,
        classifiedAt: Date.now(),
      };
    }

    // Score each metric (25 points each, max 100)
    
    // Win rate
    if (analysis.metrics.winRate >= this.thresholds.minWinRate) {
      score += 25;
      reasons.push(`Win rate: ${(analysis.metrics.winRate * 100).toFixed(1)}%`);
    }

    // Realized P&L
    if (analysis.metrics.totalRealizedPnL >= this.thresholds.minRealizedPnL) {
      score += 25;
      reasons.push(`P&L: ${analysis.metrics.totalRealizedPnL.toFixed(2)} SOL`);
    }

    // ROI
    if (analysis.metrics.totalROI >= this.thresholds.minROI) {
      score += 25;
      reasons.push(`ROI: ${analysis.metrics.totalROI.toFixed(1)}%`);
    }

    // High volume bonus
    if (analysis.metrics.totalTrades >= 50 && score >= 50) {
      score += 25;
      reasons.push('High volume trader');
    }

    // Qualify as smart money if score >= 75 (need 3 of 4 criteria)
    const isSmartMoney = score >= 75;

    return {
      address,
      isSmartMoney,
      score,
      reasons,
      analysis,
      classifiedAt: Date.now(),
    };
  }

  /**
   * Convenience method to check if a wallet is smart money.
   * 
   * @param address - Wallet address
   * @returns True if wallet qualifies as smart money
   */
  async isSmartMoney(address: string): Promise<boolean> {
    const classification = await this.classify(address);
    return classification.isSmartMoney;
  }

  /**
   * Get top smart money wallets from a list.
   * 
   * Classifies all addresses and returns top N by score.
   * 
   * @param addresses - List of wallet addresses
   * @param limit - Maximum number to return (default 10)
   * @returns Top smart money wallets sorted by score
   */
  async getTopWallets(
    addresses: string[],
    limit: number = 10
  ): Promise<SmartMoneyClassification[]> {
    // Classify in batches of 5 to avoid overwhelming API
    const batchSize = 5;
    const allClassifications: SmartMoneyClassification[] = [];

    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(address => this.classify(address))
      );
      allClassifications.push(...batchResults);

      // Small delay between batches
      if (i + batchSize < addresses.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // Filter to smart money only and sort by score
    return allClassifications
      .filter(c => c.isSmartMoney)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

export { SmartMoneyTracker, SmartMoneyClassification };
