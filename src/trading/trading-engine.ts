/**
 * Trading Engine - Decision logic and risk management
 */

import type { Keypair } from '@solana/web3.js';
import type { DatabaseWithRepositories } from '../db/database-with-repos.js';
import { PumpPortalClient } from './pumpportal-client.js';
import { TokenSafetyAnalyzer } from '../analysis/token-safety.js';
import { SmartMoneyTracker } from '../analysis/smart-money.js';
import type { TokenSafetyResult } from '../analysis/types.js';
import { logger } from '../lib/logger.js';
import type { ClaudeClient } from '../personality/claude-client.js';
import type { AnalysisContext } from '../personality/prompts.js';
import { agentEvents } from '../events/emitter.js';

/**
 * Trading configuration
 */
export interface TradingConfig {
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
export class TradingEngine {
  private config: TradingConfig;
  private pumpPortal: PumpPortalClient;
  private tokenSafety: TokenSafetyAnalyzer;
  private smartMoney: SmartMoneyTracker;
  private db: DatabaseWithRepositories;
  private claude?: ClaudeClient; // Optional for Phase 4

  constructor(
    config: TradingConfig,
    pumpPortal: PumpPortalClient,
    tokenSafety: TokenSafetyAnalyzer,
    smartMoney: SmartMoneyTracker,
    db: DatabaseWithRepositories,
    claude?: ClaudeClient
  ) {
    this.config = config;
    this.pumpPortal = pumpPortal;
    this.tokenSafety = tokenSafety;
    this.smartMoney = smartMoney;
    this.db = db;
    this.claude = claude;

    logger.info({ config, hasPersonality: !!claude }, 'Trading Engine initialized');
  }

  /**
   * Evaluate if we should trade a token
   */
  async evaluateToken(mint: string): Promise<TradeDecision> {
    logger.info({ mint }, 'Evaluating token for trading');

    const reasons: string[] = [];
    let positionSize = this.config.basePositionSol;

    // Step 1: Analyze token safety
    const safetyAnalysis = await this.tokenSafety.analyze(mint);

    // RED FLAGS: Do not trade
    // Check if token has critical risks
    const hasHoneypotRisk = safetyAnalysis.risks.some(r => 
      r === 'MINT_AUTHORITY_ACTIVE' || r === 'FREEZE_AUTHORITY_ACTIVE'
    );
    
    if (!safetyAnalysis.isSafe || hasHoneypotRisk) {
      reasons.push('Token has critical safety risks: ' + safetyAnalysis.risks.join(', '));
      return {
        shouldTrade: false,
        positionSizeSol: 0,
        reasons,
        safetyAnalysis,
        smartMoneyCount: 0,
      };
    }

    // Note: For now, we'll use simplified risk assessment
    // In a real implementation, we'd fetch holder distribution data
    // and calculate concentration from on-chain data
    
    // YELLOW FLAGS: Reduce position size if token has any risks
    if (safetyAnalysis.risks.length > 0) {
      positionSize *= 0.5;
      reasons.push(`Token has ${safetyAnalysis.risks.length} risk(s) - reduced position size by 50%`);
    }

    // Step 2: Check smart money participation
    // Smart money detection requires token holder addresses which need additional API calls.
    // The SmartMoneyTracker is initialized but holder data integration is pending.
    // When holder data is available, call: this.smartMoney.classify(holderAddress)
    const smartMoneyCount = 0;
    reasons.push('Smart money: holder data not yet integrated');

    // POSITIVE SIGNALS: Increase position size
    if (smartMoneyCount >= 5) {
      positionSize *= 1.5;
      reasons.push(`Strong smart money signal (${smartMoneyCount} wallets) - increased position size by 50%`);
    } else if (smartMoneyCount >= 3) {
      reasons.push(`Moderate smart money signal (${smartMoneyCount} wallets)`);
    } else {
      reasons.push(`Weak smart money signal (${smartMoneyCount} wallets)`);
    }

    // Cap at maximum position size
    if (positionSize > this.config.maxPositionSol) {
      reasons.push(`Position size capped at maximum (${this.config.maxPositionSol} SOL)`);
      positionSize = this.config.maxPositionSol;
    }

    // Check minimum liquidity
    const tokenInfo = await this.pumpPortal.getTokenInfo(mint);
    if (tokenInfo.liquidity < this.config.minLiquiditySol) {
      reasons.push(`Insufficient liquidity (${tokenInfo.liquidity} SOL < ${this.config.minLiquiditySol} SOL minimum)`);
      return {
        shouldTrade: false,
        positionSizeSol: 0,
        reasons,
        safetyAnalysis,
        smartMoneyCount,
      };
    }

    reasons.push(`Liquidity check passed (${tokenInfo.liquidity} SOL)`);
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
   */
  async executeBuy(mint: string): Promise<string | null> {
    logger.info({ mint }, 'Executing buy trade');

    // Check if trading is allowed
    const canTrade = await this.canTrade();
    if (!canTrade) {
      logger.warn('Trading blocked by circuit breaker');
      return null;
    }

    // Evaluate token
    const decision = await this.evaluateToken(mint);
    
    logger.info({
      mint,
      shouldTrade: decision.shouldTrade,
      positionSize: decision.positionSizeSol,
      reasons: decision.reasons,
    }, 'Trade decision');

    if (!decision.shouldTrade) {
      logger.info({ mint, reasons: decision.reasons }, 'Trade rejected');
      return null;
    }

    // Execute trade via PumpPortal
    try {
      const signature = await this.pumpPortal.buy({
        mint,
        amount: decision.positionSizeSol,
        slippage: this.config.slippageTolerance,
      });

      // Record trade in database
      await this.db.trades.insert({
        signature,
        timestamp: Date.now(),
        type: 'BUY',
        tokenMint: mint,
        amountTokens: 0, // Will be updated when we parse transaction
        amountSol: decision.positionSizeSol,
        pricePerToken: 0, // Will be updated when we parse transaction
      });

      logger.info({
        mint,
        signature,
        amount: decision.positionSizeSol,
      }, 'Buy trade executed successfully');

      return signature;
    } catch (error) {
      logger.error({ mint, error }, 'Buy trade failed');
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

    // Execute trade via PumpPortal
    try {
      const signature = await this.pumpPortal.sell({
        mint,
        amount,
        slippage: this.config.slippageTolerance,
      });

      // Record trade in database
      await this.db.trades.insert({
        signature,
        timestamp: Date.now(),
        type: 'SELL',
        tokenMint: mint,
        amountTokens: amount,
        amountSol: 0, // Will be updated when we parse transaction
        pricePerToken: 0, // Will be updated when we parse transaction
      });

      logger.info({
        mint,
        signature,
        amount,
      }, 'Sell trade executed successfully');

      return signature;
    } catch (error) {
      logger.error({ mint, error }, 'Sell trade failed');
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
    const allTrades = this.db.trades.getRecent(1000);
    const positions = new Map<string, {
      tokenMint: string;
      tokenSymbol?: string;
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
      if (netTokens <= 0) continue;

      // Calculate average entry price
      const entryPrice = pos.totalSolSpent / pos.totalTokensBought;
      const entrySol = (netTokens / pos.totalTokensBought) * pos.totalSolSpent;

      openPositions.push({
        tokenMint: pos.tokenMint,
        tokenSymbol: pos.tokenSymbol,
        entryAmountSol: entrySol,
        entryAmountTokens: netTokens,
        entryPrice,
        entryTimestamp: pos.earliestBuyTimestamp,
      });
    }

    return openPositions;
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
}

