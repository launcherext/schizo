/**
 * Trading Engine - Decision logic and risk management
 */

import { Connection, type Keypair } from '@solana/web3.js';
import type { DatabaseWithRepositories } from '../db/database-with-repos.js';
import { PumpPortalClient } from './pumpportal-client.js';
import { TokenSafetyAnalyzer } from '../analysis/token-safety.js';
import { SmartMoneyTracker } from '../analysis/smart-money.js';
import type { TokenSafetyResult } from '../analysis/types.js';
import { logger } from '../lib/logger.js';
import type { ClaudeClient } from '../personality/claude-client.js';
import type { AnalysisContext } from '../personality/prompts.js';
import { agentEvents } from '../events/emitter.js';
import { TransactionParser } from './transaction-parser.js';
import type { HeliusClient } from '../api/helius.js';
import { ScoringEngine, type TokenScore } from './scoring-engine.js';
import type { RiskProfile } from './types.js';
import { JupiterClient } from '../api/jupiter.js';
import { LearningEngine, type TradeFeatures, type TradeLesson } from '../analysis/learning-engine.js';

/**
 * Known LP pool program addresses to exclude from holder concentration
 */
const LP_PROGRAM_ADDRESSES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium V4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  '6EF8rrecthR5Dkzon8Nwu2RMhZvZP9vhU8uLxWv2fCmY', // Pump.fun Bonding Curve
]);

/**
 * Trading configuration
 */
export interface TradingConfig {
  riskProfile: RiskProfile; // Added Risk Profile
  basePositionSol: number; // Base position size in SOL
  maxPositionSol: number; // Maximum position size in SOL
  maxOpenPositions: number; // Maximum concurrent open positions
  maxDailyTrades: number; // Maximum trades per day
  circuitBreakerDailyLoss: number; // Daily loss threshold (negative number)
  circuitBreakerConsecutiveLosses: number; // Consecutive loss threshold
  minLiquiditySol: number; // Minimum liquidity required
  slippageTolerance: number; // Slippage tolerance (0-1)
  stopLossPercent: number; // Stop-loss threshold as decimal (e.g., 0.2 = -20%)
  takeProfitPercent: number; // Take-profit threshold as decimal (e.g., 0.5 = +50%)
}

/**
 * Open position with entry details
 */
export interface OpenPosition {
  tokenMint: string;
  tokenSymbol?: string;
  tokenName?: string;
  tokenImage?: string; // Token image URL
  entryAmountSol: number;
  entryAmountTokens: number;
  entryPrice: number; // SOL per token at entry
  entryTimestamp: number;
  currentPrice?: number; // Current price if available
  unrealizedPnLPercent?: number; // Unrealized P&L as percentage
}

/**
 * Trade decision result
 */
export interface TradeDecision {
  shouldTrade: boolean;
  positionSizeSol: number;
  reasons: string[];
  safetyAnalysis: TokenSafetyResult;
  smartMoneyCount: number;
  reasoning?: string; // AI-generated reasoning (Phase 4)
}

/**
 * Trading statistics
 */
export interface TradingStats {
  todayTrades: number;
  openPositions: number;
  dailyPnL: number;
  consecutiveLosses: number;
  circuitBreakerActive: boolean;
  circuitBreakerReason: string | null;
}

/**
 * Trading Engine
 * 
 * Integrates Phase 2 analysis modules to make intelligent trading decisions
 * with position sizing and risk management.
 */
/**
 * Holder concentration result
 */
interface HolderConcentrationResult {
  top10Percent: number;
  topHolderPercent: number;
  isConcentrated: boolean;
  reason?: string;
}

export class TradingEngine {
  private config: TradingConfig;
  private pumpPortal: PumpPortalClient;
  private tokenSafety: TokenSafetyAnalyzer;
  private smartMoney: SmartMoneyTracker;
  private db: DatabaseWithRepositories;
  private claude?: ClaudeClient; // Optional for Phase 4
  private connection: Connection;
  private txParser: TransactionParser;
  private walletAddress: string;
  private helius: HeliusClient;
  private jupiter?: JupiterClient; // Optional Jupiter client for graduated tokens
  private learningEngine?: LearningEngine; // Learning from trade outcomes
  private entryFeatures: Map<string, { features: TradeFeatures; confidence: number; entryPrice: number }> = new Map();

  constructor(
    config: TradingConfig,
    pumpPortal: PumpPortalClient,
    tokenSafety: TokenSafetyAnalyzer,
    smartMoney: SmartMoneyTracker,
    db: DatabaseWithRepositories,
    connection: Connection,
    walletAddress: string,
    helius: HeliusClient,
    claude?: ClaudeClient,
    jupiter?: JupiterClient,
    learningEngine?: LearningEngine
  ) {
    this.config = config;
    this.pumpPortal = pumpPortal;
    this.tokenSafety = tokenSafety;
    this.smartMoney = smartMoney;
    this.db = db;
    this.connection = connection;
    this.walletAddress = walletAddress;
    this.helius = helius;
    this.txParser = new TransactionParser(connection);
    this.claude = claude;
    this.jupiter = jupiter;
    this.learningEngine = learningEngine;

    logger.info({ config, hasPersonality: !!claude, hasJupiter: !!jupiter, hasLearning: !!learningEngine }, 'Trading Engine initialized');
  }

  /**
   * Check holder concentration for a token
   * STRICT: Rejects if top 10 holders own >20% or any single holder owns >10%
   */
  private async checkHolderConcentration(mint: string): Promise<HolderConcentrationResult> {
    try {
      const holdersResponse = await this.helius.getTokenHolders(mint, 20);
      const holders = holdersResponse.holders;

      if (holders.length === 0) {
        return {
          top10Percent: 100,
          topHolderPercent: 100,
          isConcentrated: true,
          reason: 'No holder data available - rejecting',
        };
      }

      // Need minimum holder count (no single-holder tokens)
      if (holdersResponse.totalHolders < 10) {
        return {
          top10Percent: 100,
          topHolderPercent: holders[0]?.percentage || 100,
          isConcentrated: true,
          reason: `Only ${holdersResponse.totalHolders} holders - need at least 10`,
        };
      }

      // Filter out LP program addresses before calculating concentration
      const nonLpHolders = holders.filter(h => !LP_PROGRAM_ADDRESSES.has(h.owner));

      if (nonLpHolders.length === 0) {
        return {
          top10Percent: 0,
          topHolderPercent: 0,
          isConcentrated: false,
          reason: 'Only LP pools as holders',
        };
      }

      // Calculate top 10 holder concentration (excluding LPs)
      const top10 = nonLpHolders.slice(0, 10);
      const totalPercent = nonLpHolders.reduce((sum, h) => sum + h.percentage, 0);
      // Normalize percentages after excluding LPs
      const top10Percent = totalPercent > 0 
        ? (top10.reduce((sum, h) => sum + h.percentage, 0) / totalPercent) * 100 
        : 0;
      const topHolderPercent = totalPercent > 0 
        ? (nonLpHolders[0]?.percentage / totalPercent) * 100 
        : 0;

      // RELAXED thresholds: top holder < 15%, top 10 < 50%
      const isConcentrated = topHolderPercent > 15 || top10Percent > 50;
      let reason: string | undefined;

      if (topHolderPercent > 10) {
        reason = `Single holder owns ${topHolderPercent.toFixed(1)}% (>10% limit)`;
      } else if (top10Percent > 20) {
        reason = `Top 10 holders own ${top10Percent.toFixed(1)}% (>20% limit)`;
      }

      logger.debug({
        mint,
        top10Percent: top10Percent.toFixed(1),
        topHolderPercent: topHolderPercent.toFixed(1),
        totalHolders: holdersResponse.totalHolders,
        isConcentrated,
      }, 'Holder concentration check');

      return {
        top10Percent,
        topHolderPercent,
        isConcentrated,
        reason,
      };
    } catch (error) {
      logger.warn({ mint, error }, 'Failed to check holder concentration');
      return {
        top10Percent: 100,
        topHolderPercent: 100,
        isConcentrated: true,
        reason: 'Failed to fetch holder data - rejecting for safety',
      };
    }
  }

  /**
   * Count smart money wallets among token holders
   */
  private async countSmartMoney(mint: string): Promise<{ count: number; wallets: string[] }> {
    try {
      const holdersResponse = await this.helius.getTokenHolders(mint, 50);
      const holders = holdersResponse.holders;

      const smartMoneyWallets: string[] = [];

      // Check each holder against smart money database
      // Process in batches to avoid overwhelming the API
      for (const holder of holders) {
        try {
          const isSmartMoney = await this.smartMoney.isSmartMoney(holder.owner);
          if (isSmartMoney) {
            smartMoneyWallets.push(holder.owner);
          }
        } catch (error) {
          // Skip individual failures
          logger.debug({ wallet: holder.owner, error }, 'Failed to classify wallet');
        }
      }

      logger.info({
        mint,
        smartMoneyCount: smartMoneyWallets.length,
        totalHolders: holders.length,
      }, 'Smart money detection complete');

      return {
        count: smartMoneyWallets.length,
        wallets: smartMoneyWallets,
      };
    } catch (error) {
      logger.warn({ mint, error }, 'Failed to count smart money');
      return { count: 0, wallets: [] };
    }
  }

  /**
   * Evaluate if we should trade a token
   * @param mint - Token mint address
   * @param tokenMetadata - Optional metadata (liquidity, etc.) to avoid extra API calls
   */
  async evaluateToken(mint: string, tokenMetadata?: { liquidity?: number; marketCapSol?: number }): Promise<TradeDecision> {
    logger.info({ mint, hasMetadata: !!tokenMetadata }, 'Evaluating token for trading');

    const reasons: string[] = [];
    let positionSize = this.config.basePositionSol;

    // Step 1: Analyze token safety
    const safetyAnalysis = await this.tokenSafety.analyze(mint);

    // RED FLAGS: Do not trade
    // Check if token has critical risks
    const hasMintAuth = safetyAnalysis.risks.includes('MINT_AUTHORITY_ACTIVE');
    const hasFreezeAuth = safetyAnalysis.risks.includes('FREEZE_AUTHORITY_ACTIVE');
    const hasRiskyAuth = hasMintAuth || hasFreezeAuth;
    
    // RISK DIAL LOGIC: Soft vs Hard Fails
    let allowRiskyTrade = false;
    
    if (hasRiskyAuth) {
        if (this.config.riskProfile === 'AGGRESSIVE') {
            // Check mitigating factors for Aggressive profile
            // 1. Liquidity > $5k (approx 30 SOL)
            // 2. Buy Pressure exists
            // We need metadata for this. If not passed, we skip the risk allowance.
            
            const liquidity = tokenMetadata?.liquidity || 0;
            // Calculate pseudo buy pressure if we have the data, otherwise assume neutral
            // Since we don't have buys/sells passed here explicitly in all cases, we might need to rely on what we have.
            // If tokenMetadata is from ValidationResult, we might want to extend it to carry buy/sell counts or pressure.
            // For now, let's trust liquidity as the main gate + a penalty.
            
            if (liquidity > 5000) {
                 allowRiskyTrade = true;
                 positionSize *= 0.4; // 60% penalty for risky auth
                 reasons.push(`AGGRESSIVE MODE: Allowed risky auth (Mint/Freeze) due to liquidity > $5k. Position slashed 60%.`);
            }
        }
    }
    
    // If it has risky auth and we didn't explicitly allow it, REJECT
    if (hasRiskyAuth && !allowRiskyTrade) {
      reasons.push('Token has critical safety risks: ' + safetyAnalysis.risks.join(', '));
      return {
        shouldTrade: false,
        positionSizeSol: 0,
        reasons,
        safetyAnalysis,
        smartMoneyCount: 0,
      };
    }
    
    // Other critical risks (Token 2022 extensions) are still hard fails for now
    // unless we want to relax those too. Let's keep Permanent Delegate as a HARD fail.
    const otherRisks = safetyAnalysis.risks.filter(r => r !== 'MINT_AUTHORITY_ACTIVE' && r !== 'FREEZE_AUTHORITY_ACTIVE');
    if (otherRisks.length > 0) {
        // ... (existing rejection for other risks)
         reasons.push('Token has critical safety risks: ' + otherRisks.join(', '));
         return {
            shouldTrade: false,
            positionSizeSol: 0,
            reasons,
            safetyAnalysis,
            smartMoneyCount: 0,
         };
    }

    // YELLOW FLAGS: Reduce position size if token has any risks (that we allowed)
    if (safetyAnalysis.risks.length > 0) {
      if (!allowRiskyTrade) {
          // If we are here, it means we have only minor risks (like Mutable Metadata)
           positionSize *= 0.8; // 20% penalty
           reasons.push(`Token has ${safetyAnalysis.risks.length} risk(s) - reduced position size by 20%`);
      }
      // If allowRiskyTrade is true, we already slashed by 60%, so no double penalty needed
    }

    // Step 2: Check holder concentration (reject if too concentrated)
    const concentration = await this.checkHolderConcentration(mint);
    if (concentration.isConcentrated) {
      reasons.push(`REJECTED: ${concentration.reason}`);
      return {
        shouldTrade: false,
        positionSizeSol: 0,
        reasons,
        safetyAnalysis,
        smartMoneyCount: 0,
      };
    }
    reasons.push(`Holder distribution OK (top holder: ${concentration.topHolderPercent.toFixed(1)}%, top 10: ${concentration.top10Percent.toFixed(1)}%)`);

    // Step 3: Check smart money participation - OPTIONAL, used for position sizing bonus
    const smartMoneyResult = await this.countSmartMoney(mint);
    const smartMoneyCount = smartMoneyResult.count;

    // Smart money is now OPTIONAL - we trade based on safety/concentration/liquidity
    // Smart money presence increases position size as a bonus
    if (smartMoneyCount === 0) {
      reasons.push('No smart money detected - using base position size');
    } else if (smartMoneyCount >= 5) {
      positionSize *= 1.5;
      reasons.push(`Strong smart money signal (${smartMoneyCount} wallets) - increased position 50%`);
    } else if (smartMoneyCount >= 3) {
      positionSize *= 1.25;
      reasons.push(`Good smart money signal (${smartMoneyCount} wallets) - increased position 25%`);
    } else {
      positionSize *= 1.1;
      reasons.push(`Smart money present (${smartMoneyCount} wallet(s)) - increased position 10%`);
    }

    // Cap at maximum position size
    if (positionSize > this.config.maxPositionSol) {
      reasons.push(`Position size capped at maximum (${this.config.maxPositionSol} SOL)`);
      positionSize = this.config.maxPositionSol;
    }

    // Check minimum liquidity (use passed metadata or estimate from market cap)
    const liquidity = tokenMetadata?.liquidity || (tokenMetadata?.marketCapSol ? tokenMetadata.marketCapSol * 170 : 0);

    if (liquidity > 0 && liquidity < this.config.minLiquiditySol) {
      reasons.push(`Insufficient liquidity (~${(liquidity / 170).toFixed(1)} SOL < ${this.config.minLiquiditySol} SOL minimum)`);
      return {
        shouldTrade: false,
        positionSizeSol: 0,
        reasons,
        safetyAnalysis,
        smartMoneyCount,
      };
    }

    if (liquidity > 0) {
      reasons.push(`Liquidity check passed (~${(liquidity / 170).toFixed(1)} SOL)`);
    } else {
      reasons.push('Liquidity unknown - proceeding with caution');
    }
    reasons.push(`Final position size: ${positionSize} SOL`);

    // Generate AI reasoning if Claude client available
    let reasoning: string | undefined;
    if (this.claude) {
      try {
        const context: AnalysisContext = {
          tokenMint: mint,
          safetyAnalysis,
          smartMoneyCount,
          decision: {
            shouldTrade: true,
            positionSizeSol: positionSize,
            reasons,
            safetyAnalysis,
            smartMoneyCount,
          },
        };
        reasoning = await this.claude.generateTradeReasoning(context);
      } catch (error) {
        logger.warn({ mint, error }, 'Failed to generate AI reasoning');
      }
    }

    return {
      shouldTrade: true,
      positionSizeSol: positionSize,
      reasons,
      safetyAnalysis,
      smartMoneyCount,
      reasoning,
    };
  }

  /**
   * Execute a buy trade with risk management
   * @param mint - Token mint address
   * @param tokenMetadata - Optional metadata (liquidity, marketCapSol)
   * @param skipEvaluation - Skip re-evaluation when entertainment mode pre-approved
   * @param overridePositionSol - Override position size (from entertainment mode)
   */
  async executeBuy(
    mint: string,
    tokenMetadata?: { liquidity?: number; marketCapSol?: number; symbol?: string; name?: string; imageUrl?: string },
    skipEvaluation?: boolean,
    overridePositionSol?: number
  ): Promise<string | null> {
    logger.info({ mint, skipEvaluation }, 'Executing buy trade');

    // HARD BLOCK: Pump.fun Mayhem Mode tokens (2 billion supply)
    // These are extremely high-risk tokens - NEVER trade them
    try {
      const isMayhem = await this.helius.isMayhemModeToken(mint);
      if (isMayhem) {
        logger.warn({ mint }, '🚫 BLOCKED: Pump.fun Mayhem Mode token (2B supply) - absolute no-go');
        return null;
      }
    } catch (error) {
      logger.debug({ mint, error }, 'Mayhem Mode check failed - proceeding with caution');
    }

    // Check if trading is allowed
    const canTrade = await this.canTrade();
    if (!canTrade) {
      logger.warn('Trading blocked by circuit breaker');
      return null;
    }

    let positionSizeSol = overridePositionSol || this.config.basePositionSol;

    // Skip evaluation if entertainment mode pre-approved
    if (!skipEvaluation) {
      // Evaluate token
      const decision = await this.evaluateToken(mint, tokenMetadata);

      logger.info({
        mint,
        shouldTrade: decision.shouldTrade,
        positionSize: decision.positionSizeSol,
        reasons: decision.reasons,
      }, 'Trade decision');

      if (!decision.shouldTrade) {
        logger.warn({ mint, reasons: decision.reasons }, `⛔ Trade rejected: ${decision.reasons.join(', ')}`);
        return null;
      }

      positionSizeSol = decision.positionSizeSol;
    } else {
      logger.info({ mint, positionSizeSol }, '🎰 Entertainment mode bypass - skipping re-evaluation');
    }

    // Check if token has graduated (tradeable on Jupiter/Raydium)
    let useJupiter = false;
    if (this.jupiter) {
      try {
        useJupiter = await this.jupiter.hasGraduated(mint);
        if (useJupiter) {
          logger.info({ mint }, 'Token has graduated - using Jupiter for swap');
        }
      } catch (error) {
        logger.debug({ mint, error }, 'Jupiter graduation check failed - using PumpPortal');
      }
    }

    // Execute trade via Jupiter (graduated) or PumpPortal (bonding curve)
    try {
      let signature: string;
      let tokensReceived: number;
      let actualSol: number;
      let pricePerToken: number;

      if (useJupiter && this.jupiter) {
        // Use Jupiter for graduated tokens
        const result = await this.jupiter.buy(mint, positionSizeSol, {
          slippageBps: Math.floor(this.config.slippageTolerance * 10000),
        });
        signature = result.signature;
        tokensReceived = result.outputAmount;
        actualSol = result.inputAmount;
        pricePerToken = actualSol / tokensReceived;

        logger.info({
          mint,
          signature,
          method: 'Jupiter',
          priceImpact: result.priceImpactPct,
        }, 'Jupiter buy executed');
      } else {
        // Use PumpPortal for bonding curve tokens
        signature = await this.pumpPortal.buy({
          mint,
          amount: positionSizeSol,
          slippage: this.config.slippageTolerance,
        });

        // Parse the confirmed transaction to get actual amounts
        const parsedTx = await this.txParser.waitAndParse(
          signature,
          this.walletAddress,
          mint,
          'buy',
          30000 // 30 second timeout
        );

        tokensReceived = parsedTx.tokenAmount;
        actualSol = parsedTx.solAmount || positionSizeSol;
        pricePerToken = parsedTx.pricePerToken;
      }

      // Record trade in database
      await this.db.trades.insert({
        signature,
        timestamp: Date.now(),
        type: 'BUY',
        tokenMint: mint,
        tokenSymbol: tokenMetadata?.symbol,
        amountTokens: tokensReceived,
        amountSol: actualSol,
        pricePerToken,
        metadata: {
          requestedSol: positionSizeSol,
          actualSol,
          method: useJupiter ? 'Jupiter' : 'PumpPortal',
          tokenName: tokenMetadata?.name,
          tokenImage: tokenMetadata?.imageUrl,
        },
      });

      logger.info({
        mint,
        signature,
        requestedSol: positionSizeSol,
        actualSol,
        tokensReceived,
        pricePerToken,
        method: useJupiter ? 'Jupiter' : 'PumpPortal',
      }, 'Buy trade executed successfully');

      // Capture entry features for learning engine
      if (this.learningEngine) {
        try {
          const features = await this.captureEntryFeatures(mint, tokenMetadata);
          this.entryFeatures.set(mint, {
            features,
            confidence: 50, // TODO: Get from decision
            entryPrice: pricePerToken,
          });
          logger.debug({ mint }, 'Captured entry features for learning');
        } catch (error) {
          logger.warn({ mint, error }, 'Failed to capture entry features');
        }
      }

      return signature;
    } catch (error) {
      logger.error({ mint, error, method: useJupiter ? 'Jupiter' : 'PumpPortal' }, 'Buy trade failed');
      return null;
    }
  }

  /**
   * Execute a sell trade
   */
  async executeSell(mint: string, amount: number): Promise<string | null> {
    logger.info({ mint, amount }, 'Executing sell trade');

    // Check if trading is allowed
    const canTrade = await this.canTrade();
    if (!canTrade) {
      logger.warn('Trading blocked by circuit breaker');
      return null;
    }

    // Check if token has graduated (tradeable on Jupiter/Raydium)
    let useJupiter = false;
    if (this.jupiter) {
      try {
        useJupiter = await this.jupiter.hasGraduated(mint);
        if (useJupiter) {
          logger.info({ mint }, 'Token has graduated - using Jupiter for sell');
        }
      } catch (error) {
        logger.debug({ mint, error }, 'Jupiter graduation check failed - using PumpPortal');
      }
    }

    // Execute trade via Jupiter (graduated) or PumpPortal (bonding curve)
    try {
      let signature: string;
      let actualTokens: number;
      let solReceived: number;
      let pricePerToken: number;

      if (useJupiter && this.jupiter) {
        // Use Jupiter for graduated tokens
        const result = await this.jupiter.sell(mint, amount, 6, {
          slippageBps: Math.floor(this.config.slippageTolerance * 10000),
        });
        signature = result.signature;
        actualTokens = result.inputAmount;
        solReceived = result.outputAmount;
        pricePerToken = solReceived / actualTokens;

        logger.info({
          mint,
          signature,
          method: 'Jupiter',
          priceImpact: result.priceImpactPct,
        }, 'Jupiter sell executed');
      } else {
        // Use PumpPortal for bonding curve tokens
        signature = await this.pumpPortal.sell({
          mint,
          amount,
          slippage: this.config.slippageTolerance,
        });

        // Parse the confirmed transaction to get actual amounts
        const parsedTx = await this.txParser.waitAndParse(
          signature,
          this.walletAddress,
          mint,
          'sell',
          30000 // 30 second timeout
        );

        actualTokens = parsedTx.tokenAmount || amount;
        solReceived = parsedTx.solAmount || 0;
        pricePerToken = parsedTx.pricePerToken;
      }

      // Record trade in database
      await this.db.trades.insert({
        signature,
        timestamp: Date.now(),
        type: 'SELL',
        tokenMint: mint,
        amountTokens: actualTokens,
        amountSol: solReceived,
        pricePerToken,
        metadata: {
          requestedTokens: amount,
          actualTokens,
          solReceived,
          method: useJupiter ? 'Jupiter' : 'PumpPortal',
        },
      });

      logger.info({
        mint,
        signature,
        requestedTokens: amount,
        actualTokens,
        solReceived,
        pricePerToken,
        method: useJupiter ? 'Jupiter' : 'PumpPortal',
      }, 'Sell trade executed successfully');

      return signature;
    } catch (error) {
      logger.error({ mint, error, method: useJupiter ? 'Jupiter' : 'PumpPortal' }, 'Sell trade failed');
      return null;
    }
  }

  /**
   * Execute a copy trade (SCHIZO MODE)
   * Bypasses some safety checks but still respects critical ones (honeypots)
   */
  async executeCopyTrade(mint: string, sourceWallet: string, solAmount: number): Promise<string | null> {
    logger.info({ mint, sourceWallet, solAmount }, 'Executing COPY TRADE');

    // 0. Check circuit breaker (max positions, daily trades, daily loss)
    const canTrade = await this.canTrade();
    if (!canTrade) {
      logger.warn({ mint, sourceWallet }, 'Copy trade BLOCKED: Circuit breaker active');
      return null;
    }

    // 1. Basic Safety Check (Honeypot only)
    const safetyAnalysis = await this.tokenSafety.analyze(mint);
    const hasCriticalRisk = safetyAnalysis.risks.some(r => 
      r === 'MINT_AUTHORITY_ACTIVE' || r === 'FREEZE_AUTHORITY_ACTIVE'
    );

    if (hasCriticalRisk) {
      logger.warn({ mint, risks: safetyAnalysis.risks }, 'Copy trade BLOCKED: Critical Token Risk');
      return null;
    }

    // 2. Determine Scale
    // We can match the SOL amount or use our own sizing logic.
    // For now, let's stick to our base position but scale slightly if it's a big whale buy.
    let positionSize = this.config.basePositionSol;
    
    // If the whale bought A LOT (> 10 SOL), we might ape harder
    if (solAmount > 10) {
      positionSize = Math.min(positionSize * 2, this.config.maxPositionSol);
    }

    // 3. Execute
    try {
      const signature = await this.pumpPortal.buy({
        mint,
        amount: positionSize,
        slippage: this.config.slippageTolerance * 2, // Higher slippage for copy trading speed
      });

      // 4. Parse & Record
      const parsedTx = await this.txParser.waitAndParse(
        signature,
        this.walletAddress,
        mint,
        'buy'
      );

       await this.db.trades.insert({
        signature,
        timestamp: Date.now(),
        type: 'BUY',
        tokenMint: mint,
        amountTokens: parsedTx.tokenAmount,
        amountSol: parsedTx.solAmount || positionSize,
        pricePerToken: parsedTx.pricePerToken,
        metadata: {
          strategy: 'COPY_TRADE',
          sourceWallet,
          targetSolAmount: solAmount,
          parseSuccess: parsedTx.success,
        },
      });

      logger.info({ signature, mint, positionSize }, 'Copy trade executed successfully');
      
      // Emit event
      agentEvents.emit({
        type: 'TRADE_EXECUTED',
        timestamp: Date.now(),
        data: {
          type: 'BUY',
          mint,
          amount: positionSize,
          signature
        }
      });
      
      return signature;

    } catch (error) {
      logger.error({ mint, error }, 'Copy trade execution failed');
      return null;
    }
  }

  /**
   * Check if trading is allowed (circuit breaker)
   */
  async canTrade(): Promise<boolean> {
    const stats = await this.getStats();

    // Check circuit breaker
    if (stats.circuitBreakerActive) {
      logger.warn({
        reason: stats.circuitBreakerReason,
      }, 'Circuit breaker active');
      return false;
    }

    // Check max open positions
    if (stats.openPositions >= this.config.maxOpenPositions) {
      logger.warn({
        openPositions: stats.openPositions,
        maxOpenPositions: this.config.maxOpenPositions,
      }, 'Max open positions reached');
      return false;
    }

    // Check max daily trades
    if (stats.todayTrades >= this.config.maxDailyTrades) {
      logger.warn({
        todayTrades: stats.todayTrades,
        maxDailyTrades: this.config.maxDailyTrades,
      }, 'Max daily trades reached');
      return false;
    }

    return true;
  }


  /**
   * Execute a buyback of SCHIZO token
   */
  async executeBuyback(profitSol: number, sourceTrade?: string): Promise<string | null> {
    const schizoMint = process.env.SCHIZO_TOKEN_MINT;
    const buybackPercentage = parseFloat(process.env.BUYBACK_PERCENTAGE || '0.5');

    if (!schizoMint) {
      logger.warn('SCHIZO_TOKEN_MINT not configured, skipping buyback');
      return null;
    }

    const buybackAmount = profitSol * buybackPercentage;

    logger.info({
      profitSol,
      buybackPercentage,
      buybackAmount,
      sourceTrade,
    }, 'Executing buyback');

    try {
      // Execute buyback via PumpPortal
      const signature = await this.pumpPortal.buy({
        mint: schizoMint,
        amount: buybackAmount,
        slippage: this.config.slippageTolerance,
      });

      // Record buyback in database
      await this.db.trades.insert({
        signature,
        timestamp: Date.now(),
        type: 'BUY',
        tokenMint: schizoMint,
        amountTokens: 0, // Will be updated when we parse transaction
        amountSol: buybackAmount,
        pricePerToken: 0, // Will be updated when we parse transaction
        metadata: {
          isBuyback: true,
          sourceTrade,
          profitSol,
        },
      });

      logger.info({
        signature,
        buybackAmount,
        schizoMint,
      }, 'Buyback executed successfully');

      // Emit buyback event for dashboard
      agentEvents.emit({
        type: 'BUYBACK_TRIGGERED',
        timestamp: Date.now(),
        data: {
          profit: profitSol,
          amount: buybackAmount,
          signature,
        },
      });

      return signature;
    } catch (error) {
      logger.error({ profitSol, error }, 'Buyback execution failed');
      return null;
    }
  }
  /**
   * Get current trading statistics
   */
  async getStats(): Promise<TradingStats> {
    // Get today's trades
    const todayStart = this.getTodayStart();
    const allTrades = this.db.trades.getRecent(1000); // Get recent 1000 trades
    const todayTrades = allTrades.filter((t: { timestamp: number }) => t.timestamp >= todayStart);

    // Calculate daily P&L from actual trades
    // P&L = SOL received from sells - SOL spent on buys
    const dailyPnL = this.calculateDailyPnL(todayTrades);

    // Count open positions by finding tokens with net positive holdings
    const openPositions = this.countOpenPositions(allTrades);

    // Count consecutive losses from recent completed trades
    const consecutiveLosses = this.countConsecutiveLosses(allTrades);

    // Check circuit breaker conditions
    let circuitBreakerActive = false;
    let circuitBreakerReason: string | null = null;

    if (dailyPnL <= this.config.circuitBreakerDailyLoss) {
      circuitBreakerActive = true;
      circuitBreakerReason = `Daily loss limit exceeded (${dailyPnL.toFixed(2)} SOL)`;
    }

    if (consecutiveLosses >= this.config.circuitBreakerConsecutiveLosses) {
      circuitBreakerActive = true;
      circuitBreakerReason = `Consecutive loss limit exceeded (${consecutiveLosses} losses)`;
    }

    return {
      todayTrades: todayTrades.length,
      openPositions,
      dailyPnL,
      consecutiveLosses,
      circuitBreakerActive,
      circuitBreakerReason,
    };
  }

  /**
   * Calculate daily P&L from trades
   * P&L = SOL received from sells - SOL spent on buys (excluding buybacks)
   */
  private calculateDailyPnL(todayTrades: Array<{ type: string; amountSol: number; metadata?: Record<string, unknown> }>): number {
    let pnl = 0;

    for (const trade of todayTrades) {
      // Skip buybacks - they're not trading P&L
      if (trade.metadata?.isBuyback) continue;

      if (trade.type === 'SELL') {
        pnl += trade.amountSol; // SOL received
      } else if (trade.type === 'BUY') {
        pnl -= trade.amountSol; // SOL spent
      }
    }

    return pnl;
  }

  /**
   * Count open positions (tokens with net positive holdings)
   */
  private countOpenPositions(allTrades: Array<{ type: string; tokenMint: string; amountTokens: number; metadata?: Record<string, unknown> }>): number {
    // Group trades by token
    const positions = new Map<string, number>();

    for (const trade of allTrades) {
      // Skip buybacks for position tracking
      if (trade.metadata?.isBuyback) continue;

      const current = positions.get(trade.tokenMint) || 0;

      if (trade.type === 'BUY') {
        positions.set(trade.tokenMint, current + trade.amountTokens);
      } else if (trade.type === 'SELL') {
        positions.set(trade.tokenMint, current - trade.amountTokens);
      }
    }

    // Count tokens with positive holdings
    let openCount = 0;
    for (const [, amount] of positions) {
      if (amount > 0) openCount++;
    }

    return openCount;
  }

  /**
   * Count consecutive losses from recent trades
   * A loss is a completed round-trip (buy + sell) where sell < buy
   */
  private countConsecutiveLosses(allTrades: Array<{ type: string; tokenMint: string; amountSol: number; timestamp: number; metadata?: Record<string, unknown> }>): number {
    // Find completed round-trips (buy followed by sell for same token)
    // Sort by timestamp descending (most recent first)
    const sortedTrades = [...allTrades]
      .filter(t => !t.metadata?.isBuyback)
      .sort((a, b) => b.timestamp - a.timestamp);

    // Track buy costs per token
    const tokenBuyCosts = new Map<string, number[]>();
    const completedTrades: Array<{ profit: number; timestamp: number }> = [];

    // Process in reverse chronological order to build history
    for (const trade of sortedTrades.reverse()) {
      if (trade.type === 'BUY') {
        const costs = tokenBuyCosts.get(trade.tokenMint) || [];
        costs.push(trade.amountSol);
        tokenBuyCosts.set(trade.tokenMint, costs);
      } else if (trade.type === 'SELL') {
        const costs = tokenBuyCosts.get(trade.tokenMint) || [];
        if (costs.length > 0) {
          const buyCost = costs.shift()!; // FIFO matching
          tokenBuyCosts.set(trade.tokenMint, costs);
          completedTrades.push({
            profit: trade.amountSol - buyCost,
            timestamp: trade.timestamp,
          });
        }
      }
    }

    // Count consecutive losses from most recent
    completedTrades.sort((a, b) => b.timestamp - a.timestamp);

    let consecutiveLosses = 0;
    for (const trade of completedTrades) {
      if (trade.profit < 0) {
        consecutiveLosses++;
      } else {
        break; // Stop counting at first win
      }
    }

    return consecutiveLosses;
  }

  /**
   * Get start of today (midnight) in milliseconds
   */
  private getTodayStart(): number {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return todayStart.getTime();
  }

  /**
   * Get all open positions (tokens with net positive holdings)
   */
  async getOpenPositions(): Promise<OpenPosition[]> {
    // Dust threshold: ignore positions worth less than ~$0.10 (at $200/SOL)
    const DUST_THRESHOLD_SOL = 0.0005; 
    
    const allTrades = this.db.trades.getRecent(1000);
    const positions = new Map<string, {
      tokenMint: string;
      tokenSymbol?: string;
      tokenName?: string;
      tokenImage?: string;
      totalSolSpent: number;
      totalTokensBought: number;
      totalSolReceived: number;
      totalTokensSold: number;
      earliestBuyTimestamp: number;
    }>();

    // Aggregate trades by token
    for (const trade of allTrades) {
      // Skip buybacks
      if (trade.metadata?.isBuyback) continue;

      const current = positions.get(trade.tokenMint) || {
        tokenMint: trade.tokenMint,
        tokenSymbol: trade.tokenSymbol,
        tokenName: trade.metadata?.tokenName as string | undefined,
        tokenImage: trade.metadata?.tokenImage as string | undefined,
        totalSolSpent: 0,
        totalTokensBought: 0,
        totalSolReceived: 0,
        totalTokensSold: 0,
        earliestBuyTimestamp: Infinity,
      };

      if (trade.type === 'BUY') {
        current.totalSolSpent += trade.amountSol;
        current.totalTokensBought += trade.amountTokens;
        if (trade.timestamp < current.earliestBuyTimestamp) {
          current.earliestBuyTimestamp = trade.timestamp;
        }
      } else if (trade.type === 'SELL') {
        current.totalSolReceived += trade.amountSol;
        current.totalTokensSold += trade.amountTokens;
      }

      positions.set(trade.tokenMint, current);
    }

    // Filter to positions with net positive token holdings
    const openPositions: OpenPosition[] = [];

    for (const [, pos] of positions) {
      const netTokens = pos.totalTokensBought - pos.totalTokensSold;
      
      // Skip if no tokens left
      if (netTokens <= 0) continue;

      // Calculate average entry price
      const entryPrice = pos.totalSolSpent / pos.totalTokensBought;
      const entrySol = (netTokens / pos.totalTokensBought) * pos.totalSolSpent;

      // Skip dust positions (< ~$0.10 worth, likely from rounding/slippage)
      if (entrySol < DUST_THRESHOLD_SOL) {
        logger.debug({
          mint: pos.tokenMint,
          entrySol,
          reason: 'Dust position filtered out'
        }, 'Ignoring dust position');
        continue;
      }

      openPositions.push({
        tokenMint: pos.tokenMint,
        tokenSymbol: pos.tokenSymbol,
        tokenName: pos.tokenName,
        tokenImage: pos.tokenImage,
        entryAmountSol: entrySol,
        entryAmountTokens: netTokens,
        entryPrice,
        entryTimestamp: pos.earliestBuyTimestamp,
      });
    }

    return openPositions;
  }

  /**
   * Get open positions with current prices and PnL
   * Fetches live prices from PumpPortal for each position
   */
  async getOpenPositionsWithPrices(): Promise<OpenPosition[]> {
    const positions = await this.getOpenPositions();
    const positionsWithPrices: OpenPosition[] = [];

    for (const position of positions) {
      try {
        // Get current price from PumpPortal
        const tokenInfo = await this.pumpPortal.getTokenInfo(position.tokenMint);
        const currentPrice = tokenInfo.price;

        // Calculate P&L percentage
        const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

        positionsWithPrices.push({
          ...position,
          currentPrice,
          unrealizedPnLPercent: pnlPercent,
        });
      } catch (error) {
        // If we can't get price, include position without price data
        logger.debug({ mint: position.tokenMint, error }, 'Could not fetch current price for position');
        positionsWithPrices.push(position);
      }
    }

    return positionsWithPrices;
  }

  /**
   * Check open positions and execute stop-loss/take-profit if needed
   * Returns array of exit trade signatures
   */
  async checkPositionsForExit(): Promise<string[]> {
    const positions = await this.getOpenPositions();
    const exitSignatures: string[] = [];

    logger.debug({ positionCount: positions.length }, 'Checking positions for exit signals');

    for (const position of positions) {
      try {
        // Get current price from PumpPortal
        const tokenInfo = await this.pumpPortal.getTokenInfo(position.tokenMint);
        const currentPrice = tokenInfo.price;

        // Calculate P&L percentage
        const pnlPercent = (currentPrice - position.entryPrice) / position.entryPrice;

        logger.debug({
          mint: position.tokenMint,
          entryPrice: position.entryPrice,
          currentPrice,
          pnlPercent: (pnlPercent * 100).toFixed(2) + '%',
        }, 'Position P&L check');

        // Check stop-loss
        if (pnlPercent <= -this.config.stopLossPercent) {
          logger.warn({
            mint: position.tokenMint,
            pnlPercent: (pnlPercent * 100).toFixed(2) + '%',
            stopLoss: (-this.config.stopLossPercent * 100).toFixed(2) + '%',
          }, 'STOP-LOSS triggered');

          const signature = await this.executeSell(position.tokenMint, position.entryAmountTokens);
          if (signature) {
            exitSignatures.push(signature);

            // Emit stop-loss event
            agentEvents.emit({
              type: 'STOP_LOSS',
              timestamp: Date.now(),
              data: {
                mint: position.tokenMint,
                entryPrice: position.entryPrice,
                exitPrice: currentPrice,
                lossPercent: pnlPercent * 100,
                signature,
              },
            });

            // Record trade lesson for learning engine
            await this.recordTradeLesson(position, currentPrice, Date.now(), pnlPercent);
          }
          continue;
        }

        // Check take-profit
        if (pnlPercent >= this.config.takeProfitPercent) {
          logger.info({
            mint: position.tokenMint,
            pnlPercent: (pnlPercent * 100).toFixed(2) + '%',
            takeProfit: (this.config.takeProfitPercent * 100).toFixed(2) + '%',
          }, 'TAKE-PROFIT triggered');

          const signature = await this.executeSell(position.tokenMint, position.entryAmountTokens);
          if (signature) {
            exitSignatures.push(signature);

            // Emit take-profit event
            agentEvents.emit({
              type: 'TAKE_PROFIT',
              timestamp: Date.now(),
              data: {
                mint: position.tokenMint,
                entryPrice: position.entryPrice,
                exitPrice: currentPrice,
                profitPercent: pnlPercent * 100,
                signature,
              },
            });

            // Record trade lesson for learning engine
            await this.recordTradeLesson(position, currentPrice, Date.now(), pnlPercent);

            // Calculate profit and trigger buyback if profitable
            const profitSol = position.entryAmountSol * pnlPercent;
            if (profitSol > 0) {
              await this.executeBuyback(profitSol, signature);
            }
          }
        }
      } catch (error) {
        logger.error({ mint: position.tokenMint, error }, 'Error checking position for exit');
      }
    }

    return exitSignatures;
  }

  /**
   * Get recent trades for dashboard display
   */
  getRecentTrades(limit: number = 20): Array<{
    signature: string;
    timestamp: number;
    type: 'BUY' | 'SELL';
    mint: string;
    amount: number;
    tokenSymbol?: string;
  }> {
    const trades = this.db.trades.getRecent(limit);
    return trades
      .filter((t: { metadata?: { isBuyback?: boolean } }) => !t.metadata?.isBuyback)
      .map((t: { signature: string; timestamp: number; type: 'BUY' | 'SELL'; tokenMint: string; amountSol: number; tokenSymbol?: string }) => ({
        signature: t.signature,
        timestamp: t.timestamp,
        type: t.type,
        mint: t.tokenMint,
        amount: t.amountSol,
        tokenSymbol: t.tokenSymbol,
      }));
  }

  /**
   * Capture features at trade entry for learning engine
   */
  private async captureEntryFeatures(
    mint: string,
    tokenMetadata?: { liquidity?: number; marketCapSol?: number; symbol?: string; name?: string }
  ): Promise<TradeFeatures> {
    // Get safety analysis
    const safety = await this.tokenSafety.analyze(mint);

    // Get holder concentration
    let holderConcentration: HolderConcentrationResult = {
      top10Percent: 0,
      topHolderPercent: 0,
      isConcentrated: false,
    };
    try {
      holderConcentration = await this.checkHolderConcentration(mint);
    } catch {
      // Ignore errors
    }

    // Get token info from PumpPortal
    let bondingProgress = 0;
    let tokenAgeMins = 0;
    let holderCount = 0;
    try {
      const tokenInfo = await this.pumpPortal.getTokenInfo(mint);
      holderCount = tokenInfo.holderCount ?? 0;
      // Bonding progress and age would need extended API - estimate from liquidity
      bondingProgress = Math.min(100, (tokenInfo.liquidity / 85) * 100); // 85 SOL = 100%
    } catch {
      // Ignore errors
    }

    // Check smart money (simplified)
    const smartMoneyCount = 0; // Would need holder data to check

    return {
      bondingCurveProgress: bondingProgress,
      marketCapSol: tokenMetadata?.marketCapSol ?? 0,
      liquidity: tokenMetadata?.liquidity ?? 0,
      tokenAgeMins,
      buyCount5m: 0, // Would need trade history
      sellCount5m: 0,
      buyVolume5m: 0,
      sellVolume5m: 0,
      heatMetric: 0, // Would need MomentumScanner
      holderCount,
      topHolderPercent: holderConcentration.topHolderPercent,
      top10HoldersPercent: holderConcentration.top10Percent,
      smartMoneyCount,
      smartMoneyBuying: smartMoneyCount > 0,
      mintAuthorityRevoked: !safety.risks.includes('MINT_AUTHORITY_ACTIVE'),
      freezeAuthorityRevoked: !safety.risks.includes('FREEZE_AUTHORITY_ACTIVE'),
      isBundled: false, // Would need BundleDetector
      bundleScore: 0,
      hasTwitter: false, // Would need social data
      hasTelegram: false,
      hasWebsite: false,
    };
  }

  /**
   * Record a trade lesson when position closes
   */
  private async recordTradeLesson(
    position: OpenPosition,
    exitPrice: number,
    exitTimestamp: number,
    pnlPercent: number
  ): Promise<void> {
    if (!this.learningEngine) return;

    const entryData = this.entryFeatures.get(position.tokenMint);
    if (!entryData) {
      logger.warn({ mint: position.tokenMint }, 'No entry features found for trade lesson');
      return;
    }

    const pnlSol = position.entryAmountSol * pnlPercent;
    const outcome: 'win' | 'loss' = pnlPercent > 0 ? 'win' : 'loss';

    const lesson: TradeLesson = {
      id: `${position.tokenMint}-${position.entryTimestamp}`,
      tokenMint: position.tokenMint,
      tokenSymbol: position.tokenSymbol,
      entryTimestamp: position.entryTimestamp,
      exitTimestamp,
      features: entryData.features,
      outcome,
      pnlPercent: pnlPercent * 100, // Convert to percentage
      pnlSol,
      holdTimeMs: exitTimestamp - position.entryTimestamp,
      entryPrice: entryData.entryPrice,
      exitPrice,
      confidenceAtEntry: entryData.confidence,
    };

    await this.learningEngine.recordLesson(lesson);

    // Clean up entry features
    this.entryFeatures.delete(position.tokenMint);

    logger.info({
      mint: position.tokenMint,
      outcome,
      pnlPercent: (pnlPercent * 100).toFixed(1) + '%',
      holdTimeMs: lesson.holdTimeMs,
    }, 'Trade lesson recorded');
  }
}
