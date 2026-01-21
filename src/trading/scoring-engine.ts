/**
 * Scoring Engine - Centralized token scoring logic
 * Decouples gating decisions from TradingEngine
 */

import { TokenSafetyAnalyzer } from '../analysis/token-safety.js';
import type { TokenSafetyResult } from '../analysis/types.js';
import { SmartMoneyTracker } from '../analysis/smart-money.js';
import { HeliusClient } from '../api/helius.js';
import { logger } from '../lib/logger.js';

/**
 * Known LP pool program addresses to exclude from holder concentration
 */
const LP_PROGRAM_ADDRESSES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium V4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  '6EF8rrecthR5Dkzon8Nwu2RMhZvZP9vhU8uLxWv2fCmY', // Pump.fun Bonding Curve
  'TSWAPaqyCSx2KABk68Shruf4rp7CZccht1XmZaMdY', // Tensor TSWAP
]);

/**
 * Token score breakdown
 */
export interface TokenScore {
  total: number;        // 0-100 overall score
  safety: number;       // 0-40 pts - Token safety (no mint/freeze auth)
  smartMoney: number;   // 0-30 pts - Smart money presence
  liquidity: number;    // 0-20 pts - Liquidity depth
  momentum: number;     // 0-10 pts - Price/volume momentum
  flags: string[];      // Human-readable scoring breakdown
  details: {
    isSafe: boolean;
    smartMoneyCount: number;
    liquidityUsd: number;
    topHolderPercent: number;
    isConcentrated: boolean;
  };
}

export interface ScoringConfig {
  minScoreToTrade: number;  // Minimum score to approve trade (default: 50)
  safetyWeight: number;     // Max points for safety (default: 40)
  smartMoneyWeight: number; // Max points for smart money (default: 30)
  liquidityWeight: number;  // Max points for liquidity (default: 20)
  momentumWeight: number;   // Max points for momentum (default: 10)
}

const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  minScoreToTrade: 50,
  safetyWeight: 40,
  smartMoneyWeight: 30,
  liquidityWeight: 20,
  momentumWeight: 10,
};

/**
 * Scoring Engine
 * Calculates a 0-100 score for any token to determine tradability
 */
export class ScoringEngine {
  private config: ScoringConfig;
  private tokenSafety: TokenSafetyAnalyzer;
  private smartMoney: SmartMoneyTracker;
  private helius: HeliusClient;

  constructor(
    tokenSafety: TokenSafetyAnalyzer,
    smartMoney: SmartMoneyTracker,
    helius: HeliusClient,
    config?: Partial<ScoringConfig>
  ) {
    this.config = { ...DEFAULT_SCORING_CONFIG, ...config };
    this.tokenSafety = tokenSafety;
    this.smartMoney = smartMoney;
    this.helius = helius;
  }

  /**
   * Calculate comprehensive score for a token
   */
  async calculateScore(
    mint: string,
    metadata?: { liquidity?: number; marketCapSol?: number; priceChange1h?: number }
  ): Promise<TokenScore> {
    const flags: string[] = [];
    let safetyScore = 0;
    let smartMoneyScore = 0;
    let liquidityScore = 0;
    let momentumScore = 0;

    // 1. Safety Analysis (0-40 pts)
    const safetyResult = await this.tokenSafety.analyze(mint);
    if (safetyResult.isSafe) {
      safetyScore = this.config.safetyWeight;
      flags.push(`✅ Safe token (+${safetyScore})`);
    } else {
      // Partial credit if only minor risks
      const criticalRisks = safetyResult.risks.filter(r => 
        r === 'MINT_AUTHORITY_ACTIVE' || r === 'FREEZE_AUTHORITY_ACTIVE'
      );
      if (criticalRisks.length === 0) {
        safetyScore = Math.floor(this.config.safetyWeight * 0.5);
        flags.push(`⚠️ Minor risks (+${safetyScore}): ${safetyResult.risks.join(', ')}`);
      } else {
        flags.push(`❌ Critical risks: ${criticalRisks.join(', ')}`);
      }
    }

    // 2. Smart Money Detection (0-30 pts)
    const smartMoneyResult = await this.countSmartMoney(mint);
    const smCount = smartMoneyResult.count;
    if (smCount >= 5) {
      smartMoneyScore = this.config.smartMoneyWeight;
      flags.push(`🐋 Strong smart money (${smCount} wallets) (+${smartMoneyScore})`);
    } else if (smCount >= 3) {
      smartMoneyScore = Math.floor(this.config.smartMoneyWeight * 0.75);
      flags.push(`🐋 Good smart money (${smCount} wallets) (+${smartMoneyScore})`);
    } else if (smCount >= 1) {
      smartMoneyScore = Math.floor(this.config.smartMoneyWeight * 0.5);
      flags.push(`🐋 Some smart money (${smCount} wallets) (+${smartMoneyScore})`);
    } else {
      // No smart money - still allow trade if other signals are strong
      flags.push(`⚠️ No smart money detected`);
    }

    // 3. Liquidity Score (0-20 pts)
    const liquidityUsd = metadata?.liquidity || 0;
    if (liquidityUsd >= 50000) {
      liquidityScore = this.config.liquidityWeight;
      flags.push(`💧 Excellent liquidity ($${(liquidityUsd / 1000).toFixed(0)}k) (+${liquidityScore})`);
    } else if (liquidityUsd >= 20000) {
      liquidityScore = Math.floor(this.config.liquidityWeight * 0.75);
      flags.push(`💧 Good liquidity ($${(liquidityUsd / 1000).toFixed(0)}k) (+${liquidityScore})`);
    } else if (liquidityUsd >= 10000) {
      liquidityScore = Math.floor(this.config.liquidityWeight * 0.5);
      flags.push(`💧 Moderate liquidity ($${(liquidityUsd / 1000).toFixed(0)}k) (+${liquidityScore})`);
    } else if (liquidityUsd >= 5000) {
      liquidityScore = Math.floor(this.config.liquidityWeight * 0.25);
      flags.push(`⚠️ Low liquidity ($${(liquidityUsd / 1000).toFixed(0)}k) (+${liquidityScore})`);
    } else {
      flags.push(`❌ Insufficient liquidity ($${liquidityUsd.toFixed(0)})`);
    }

    // 4. Momentum Score (0-10 pts)
    const priceChange = metadata?.priceChange1h || 0;
    if (priceChange > 20 && priceChange < 100) {
      momentumScore = this.config.momentumWeight;
      flags.push(`📈 Strong momentum (+${priceChange.toFixed(0)}%) (+${momentumScore})`);
    } else if (priceChange > 5) {
      momentumScore = Math.floor(this.config.momentumWeight * 0.5);
      flags.push(`📈 Positive momentum (+${priceChange.toFixed(0)}%) (+${momentumScore})`);
    } else if (priceChange < -20) {
      flags.push(`📉 Dumping (${priceChange.toFixed(0)}%)`);
    }

    // 5. Holder Concentration Check (can reduce score)
    const concentration = await this.checkHolderConcentration(mint);
    if (concentration.isConcentrated) {
      // Reduce total by 20% for concentrated holdings
      flags.push(`⚠️ Concentrated holdings (top holder: ${concentration.topHolderPercent.toFixed(1)}%)`);
    }

    // Calculate total
    let total = safetyScore + smartMoneyScore + liquidityScore + momentumScore;
    if (concentration.isConcentrated) {
      total = Math.floor(total * 0.8);
      flags.push(`📊 Score reduced 20% due to concentration`);
    }

    logger.info({
      mint,
      total,
      breakdown: { safetyScore, smartMoneyScore, liquidityScore, momentumScore },
    }, 'Token scored');

    return {
      total,
      safety: safetyScore,
      smartMoney: smartMoneyScore,
      liquidity: liquidityScore,
      momentum: momentumScore,
      flags,
      details: {
        isSafe: safetyResult.isSafe,
        smartMoneyCount: smCount,
        liquidityUsd,
        topHolderPercent: concentration.topHolderPercent,
        isConcentrated: concentration.isConcentrated,
      },
    };
  }

  /**
   * Count smart money wallets holding this token
   */
  private async countSmartMoney(mint: string): Promise<{ count: number; wallets: string[] }> {
    try {
      const response = await this.helius.getTokenHolders(mint, 20);
      if (!response.holders || response.holders.length === 0) {
        return { count: 0, wallets: [] };
      }

      const smartWallets: string[] = [];
      for (const holder of response.holders) {
        const isSmartMoney = await this.smartMoney.isSmartMoney(holder.owner);
        if (isSmartMoney) {
          smartWallets.push(holder.owner);
        }
      }

      return { count: smartWallets.length, wallets: smartWallets };
    } catch (error) {
      logger.warn({ mint, error }, 'Failed to count smart money');
      return { count: 0, wallets: [] };
    }
  }

  /**
   * Check holder concentration (excluding LP pools)
   */
  private async checkHolderConcentration(mint: string): Promise<{
    topHolderPercent: number;
    top10Percent: number;
    isConcentrated: boolean;
  }> {
    try {
      const response = await this.helius.getTokenHolders(mint, 20);
      if (!response.holders || response.holders.length === 0) {
        return { topHolderPercent: 0, top10Percent: 0, isConcentrated: false };
      }

      // Filter out LP program addresses
      const nonLpHolders = response.holders.filter(h => !LP_PROGRAM_ADDRESSES.has(h.owner));

      if (nonLpHolders.length === 0) {
        return { topHolderPercent: 0, top10Percent: 0, isConcentrated: false };
      }

      // Calculate percentages
      const totalSupply = nonLpHolders.reduce((sum, h) => sum + h.amount, 0);
      const topHolderPercent = totalSupply > 0 ? (nonLpHolders[0].amount / totalSupply) * 100 : 0;
      const top10Total = nonLpHolders.slice(0, 10).reduce((sum, h) => sum + h.amount, 0);
      const top10Percent = totalSupply > 0 ? (top10Total / totalSupply) * 100 : 0;

      // Concentrated if top holder > 15% OR top 10 > 50%
      const isConcentrated = topHolderPercent > 15 || top10Percent > 50;

      return { topHolderPercent, top10Percent, isConcentrated };
    } catch (error) {
      logger.warn({ mint, error }, 'Failed to check holder concentration');
      return { topHolderPercent: 0, top10Percent: 0, isConcentrated: false };
    }
  }

  /**
   * Quick check if token meets minimum score threshold
   */
  async meetsMinimumScore(mint: string, metadata?: { liquidity?: number }): Promise<boolean> {
    const score = await this.calculateScore(mint, metadata);
    return score.total >= this.config.minScoreToTrade;
  }
}
