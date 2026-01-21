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

  constructor(
    config: TradingConfig,
    pumpPortal: PumpPortalClient,
    tokenSafety: TokenSafetyAnalyzer,
    smartMoney: SmartMoneyTracker,
    db: DatabaseWithRepositories,
    connection: Connection,
    walletAddress: string,
    helius: HeliusClient,
    claude?: ClaudeClient
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

    logger.info({ config, hasPersonality: !!claude }, 'Trading Engine initialized');
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

      // Calculate top 10 holder concentration
      const top10 = holders.slice(0, 10);
      const top10Percent = top10.reduce((sum, h) => sum + h.percentage, 0);
      const topHolderPercent = holders[0]?.percentage || 0;

      // STRICT thresholds: top 10 < 20%, single holder < 10%
      const isConcentrated = top10Percent > 20 || topHolderPercent > 10;
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

    // Step 3: Check smart money participation - REQUIRED for entry
    const smartMoneyResult = await this.countSmartMoney(mint);
    const smartMoneyCount = smartMoneyResult.count;

    // STRICT: Must have at least 1 smart money wallet to buy
    if (smartMoneyCount === 0) {
      reasons.push('REJECTED: No smart money detected - need at least 1 whale/profitable wallet');
      return {
        shouldTrade: false,
        positionSizeSol: 0,
        reasons,
        safetyAnalysis,
        smartMoneyCount: 0,
      };
    }

    // Scale position based on smart money count
    if (smartMoneyCount >= 5) {
      positionSize *= 1.5;
      reasons.push(`Strong smart money signal (${smartMoneyCount} wallets) - increased position 50%`);
    } else if (smartMoneyCount >= 3) {
      positionSize *= 1.25;
      reasons.push(`Good smart money signal (${smartMoneyCount} wallets) - increased position 25%`);
    } else {
      reasons.push(`Smart money present (${smartMoneyCount} wallet(s)) - entry approved`);
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
   */
  async executeBuy(mint: string, tokenMetadata?: { liquidity?: number; marketCapSol?: number }): Promise<string | null> {
    logger.info({ mint }, 'Executing buy trade');

    // Check if trading is allowed
    const canTrade = await this.canTrade();
    if (!canTrade) {
      logger.warn('Trading blocked by circuit breaker');
      return null;
    }

    // Evaluate token
    const decision = await this.evaluateToken(mint, tokenMetadata);
    
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

      // Parse the confirmed transaction to get actual amounts
      const parsedTx = await this.txParser.waitAndParse(
        signature,
        this.walletAddress,
        mint,
        'buy',
        30000 // 30 second timeout
      );

      // Record trade in database with ACTUAL amounts from parsed transaction
      await this.db.trades.insert({
        signature,
        timestamp: Date.now(),
        type: 'BUY',
        tokenMint: mint,
        amountTokens: parsedTx.tokenAmount,
        amountSol: parsedTx.solAmount || decision.positionSizeSol,
        pricePerToken: parsedTx.pricePerToken,
        metadata: {
          requestedSol: decision.positionSizeSol,
          actualSol: parsedTx.solAmount,
          fee: parsedTx.fee,
          parseSuccess: parsedTx.success,
        },
      });

      logger.info({
        mint,
        signature,
        requestedSol: decision.positionSizeSol,
        actualSol: parsedTx.solAmount,
        tokensReceived: parsedTx.tokenAmount,
        pricePerToken: parsedTx.pricePerToken,
        fee: parsedTx.fee,
      }, 'Buy trade executed and parsed successfully');

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

      // Parse the confirmed transaction to get actual amounts
      const parsedTx = await this.txParser.waitAndParse(
        signature,
        this.walletAddress,
        mint,
        'sell',
        30000 // 30 second timeout
      );

      // Record trade in database with ACTUAL amounts from parsed transaction
      await this.db.trades.insert({
        signature,
        timestamp: Date.now(),
        type: 'SELL',
        tokenMint: mint,
        amountTokens: parsedTx.tokenAmount || amount,
        amountSol: parsedTx.solAmount,
        pricePerToken: parsedTx.pricePerToken,
        metadata: {
          requestedTokens: amount,
          actualTokens: parsedTx.tokenAmount,
          solReceived: parsedTx.solAmount,
          fee: parsedTx.fee,
          parseSuccess: parsedTx.success,
        },
      });

      logger.info({
        mint,
        signature,
        requestedTokens: amount,
        actualTokens: parsedTx.tokenAmount,
        solReceived: parsedTx.solAmount,
        pricePerToken: parsedTx.pricePerToken,
        fee: parsedTx.fee,
      }, 'Sell trade executed and parsed successfully');

      return signature;
    } catch (error) {
      logger.error({ mint, error }, 'Sell trade failed');
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

