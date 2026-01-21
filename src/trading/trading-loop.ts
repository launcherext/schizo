/**
 * Trading Loop - Automatic token monitoring and trading
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { DatabaseWithRepositories } from '../db/database-with-repos.js';
import type { TokenSafetyAnalyzer } from '../analysis/token-safety.js';
import type { SmartMoneyTracker } from '../analysis/smart-money.js';
import type { TradingEngine } from './trading-engine.js';
import type { ClaudeClient } from '../personality/claude-client.js';
import { dexscreener, type TokenMetadata } from '../api/dexscreener.js';
import { getBirdeyeClient, type BirdeyeToken } from '../api/birdeye.js';
import { agentEvents } from '../events/emitter.js';
import { logger } from '../lib/logger.js';

/**
 * Trading loop configuration
 */
export interface TradingLoopConfig {
  runLoop: boolean;      // Controls if the loop actively fetches and analyzes tokens
  enableTrading: boolean; // Controls if trades are actually executed
  pollIntervalMs: number;
  maxTokensPerCycle: number;
}

/**
 * Default configuration
 */
export const DEFAULT_TRADING_LOOP_CONFIG: TradingLoopConfig = {
  runLoop: true,
  enableTrading: false,
  pollIntervalMs: 10000, // 10 seconds - gotta catch those runners
  maxTokensPerCycle: 10,
};

/**
 * Trading Loop - Orchestrates the full trading flow
 */
export class TradingLoop {
  private config: TradingLoopConfig;
  private connection: Connection;
  private db: DatabaseWithRepositories;
  private tokenSafety: TokenSafetyAnalyzer;
  private smartMoney: SmartMoneyTracker;
  private tradingEngine?: TradingEngine;
  private claude?: ClaudeClient;
  private walletPublicKey?: PublicKey;
  private isRunning: boolean = false;
  private intervalId?: NodeJS.Timeout;
  private trendingIntervalId?: NodeJS.Timeout; // Separate interval for trending scan
  private seenTokens = new Map<string, number>(); // Track tokens we've already analyzed with timestamp
  private tokenMetadataCache = new Map<string, TokenMetadata>(); // Cache enriched data

  private trendingTokenQueue: BirdeyeToken[] = []; // Queue of trending tokens from Birdeye
  private isProcessing = false; // Prevent concurrent processing
  private lastTrendingScan = 0; // Track last trending scan time

  constructor(
    config: TradingLoopConfig,
    connection: Connection,
    db: DatabaseWithRepositories,
    tokenSafety: TokenSafetyAnalyzer,
    smartMoney: SmartMoneyTracker,
    tradingEngine?: TradingEngine,
    claude?: ClaudeClient,
    walletPublicKey?: PublicKey
  ) {
    this.config = config;
    this.connection = connection;
    this.db = db;
    this.tokenSafety = tokenSafety;
    this.smartMoney = smartMoney;
    this.tradingEngine = tradingEngine;
    this.claude = claude;
    this.walletPublicKey = walletPublicKey;

    const mode = tradingEngine ? 'FULL' : 'ANALYSIS-ONLY';
    logger.info({ config, mode }, 'Trading Loop initialized');
  }

  /**
   * Start the trading loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Trading loop already running');
      return;
    }

    if (!this.config.runLoop) {
      logger.info('Trading loop disabled in config');
      return;
    }

    this.isRunning = true;
    logger.info('Starting trading loop...');

    if (!this.config.enableTrading) {
      logger.info('⚠️  ANALYSIS MODE ONLY - Trading execution is DISABLED');
    }

    // NOTE: New token discovery is now handled by SniperPipeline
    // This loop executes trending scans and position management

    // Process queue periodically
    this.intervalId = setInterval(() => {
      // Also run position checks if trading
      if (this.config.enableTrading && this.tradingEngine) {
        this.checkPositionExits().catch(error => {
          logger.error({ error }, 'Error checking position exits');
        });
      }

      // Emit stats
      this.emitStatsUpdate().catch(() => {});
    }, this.config.pollIntervalMs);

    // Scan trending tokens every 60 seconds (Birdeye rate limit friendly)
    const birdeyeClient = getBirdeyeClient();
    if (birdeyeClient) {
      logger.info('🦅 Birdeye integration enabled - scanning trending tokens');

      // Initial scan after 5 seconds
      setTimeout(() => {
        this.scanTrendingTokens().catch(error => {
          logger.error({ error }, 'Error in initial trending scan');
        });
      }, 5000);

      // Then scan every 60 seconds
      this.trendingIntervalId = setInterval(() => {
        this.scanTrendingTokens().catch(error => {
          logger.error({ error }, 'Error scanning trending tokens');
        });
      }, 60000); // Every 60 seconds
    } else {
      logger.warn('BIRDEYE_API_KEY not configured - trending token scanning disabled');
    }

    logger.info({ intervalMs: this.config.pollIntervalMs }, 'Trading loop started');
  }

  /**
   * Scan trending tokens from Birdeye
   */
  private async scanTrendingTokens(): Promise<void> {
    const birdeyeClient = getBirdeyeClient();
    if (!birdeyeClient) return;

    logger.debug('Scanning trending tokens from Birdeye...');

    try {
      // Get trending tokens and top gainers
      const [trending, gainers] = await Promise.all([
        birdeyeClient.getTrendingTokens(15),
        birdeyeClient.getTopGainers(10, '1h'),
      ]);

      const allTokens = [...trending, ...gainers];
      let addedCount = 0;

      for (const token of allTokens) {
        // Skip if already seen recently (within last 30 mins)
        const lastSeen = this.seenTokens.get(token.address);
        if (lastSeen && Date.now() - lastSeen < 30 * 60 * 1000) continue;

        // Quick filter for trending tokens
        const filterResult = this.passesTrendingFilter(token);
        if (!filterResult.passes) {
          logger.debug({
            address: token.address,
            symbol: token.symbol,
            reason: filterResult.reason
          }, 'Trending token rejected by filter');
          continue;
        }

        this.seenTokens.set(token.address, Date.now());
        this.trendingTokenQueue.push(token);
        addedCount++;

        logger.info({
          address: token.address,
          symbol: token.symbol,
          name: token.name,
          price: token.price,
          priceChange24h: token.priceChange24h?.toFixed(1) + '%',
          volume24h: token.volume24h,
          liquidity: token.liquidity,
        }, '📈 Trending token from Birdeye!');
      }

      if (addedCount > 0) {
        logger.info({ addedCount }, 'Added trending tokens to queue');
      }

      // Process trending queue
      await this.processTrendingQueue();

    } catch (error) {
      logger.error({ error }, 'Failed to scan trending tokens');
    }
  }

  /**
   * Filter for trending tokens (more established, need higher standards)
   */
  private passesTrendingFilter(token: BirdeyeToken): { passes: boolean; reason?: string } {
    // Minimum liquidity for trending tokens ($5k)
    const MIN_LIQUIDITY = 5000;
    if (token.liquidity < MIN_LIQUIDITY) {
      return { passes: false, reason: `Low liquidity: $${token.liquidity.toFixed(0)}` };
    }

    // Minimum volume ($1k in 24h)
    const MIN_VOLUME = 1000;
    if (token.volume24h < MIN_VOLUME) {
      return { passes: false, reason: `Low volume: $${token.volume24h.toFixed(0)}` };
    }

    // Skip tokens that dumped hard (down >50% in 24h)
    if (token.priceChange24h < -50) {
      return { passes: false, reason: `Dumping: ${token.priceChange24h.toFixed(1)}%` };
    }

    // Suspicious patterns
    const suspiciousPatterns = [/test/i, /rug/i, /scam/i, /fake/i];
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(token.symbol) || pattern.test(token.name)) {
        return { passes: false, reason: `Suspicious name: ${token.symbol}` };
      }
    }

    return { passes: true };
  }

  /**
   * Process trending token queue
   */
  private async processTrendingQueue(): Promise<void> {
    this.isProcessing = true;
    try {
      // Process up to 3 trending tokens per cycle
      const tokensToProcess = this.trendingTokenQueue.splice(0, 3);

      for (const token of tokensToProcess) {
        // Convert Birdeye token to analysis format
        await this.analyzeAndTrade(token.address, token);
      }
    } finally {
      this.isProcessing = false;

      // Cleanup seen tokens map occasionally (every cycle)
      const now = Date.now();
      for (const [mint, timestamp] of this.seenTokens.entries()) {
        if (now - timestamp > 60 * 60 * 1000) { // 1 hour TTL
          this.seenTokens.delete(mint);
        }
      }
    }
  }



  /**
   * Check if token has valid social links (Twitter, Website)
   * Returns true if at least one valid social exists
   */
  private hasValidSocials(metadata: TokenMetadata | undefined): { valid: boolean; reason?: string } {
    if (!metadata) {
      return { valid: false, reason: 'No metadata available' };
    }

    // Check for social links in metadata
    // DexScreener provides these when available
    const hasTwitter = metadata.dexUrl?.includes('twitter') || false;
    const hasWebsite = metadata.dexUrl?.includes('http') || false;

    // For now, we'll use the presence of a DexScreener listing as a proxy
    // Real implementation would check actual social links from token metadata
    if (metadata.ageMinutes && metadata.ageMinutes > 5) {
      // Token has been around for more than 5 minutes and has DexScreener data
      return { valid: true };
    }

    return { valid: false, reason: 'Token too new - waiting for social verification' };
  }





  /**
   * Stop the trading loop
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    // Stop intervals
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (this.trendingIntervalId) {
      clearInterval(this.trendingIntervalId);
      this.trendingIntervalId = undefined;
    }

    logger.info('Trading loop stopped');
  }

  /**
   * Run one cycle of the trading loop
   */
  private async runCycle(): Promise<void> {
    logger.debug('Running trading cycle...');

    try {
      // Step 1: Check existing positions for stop-loss/take-profit exits
      if (this.config.enableTrading && this.tradingEngine) {
        await this.checkPositionExits();
      }

      // Step 2: Emit stats update for dashboard
      await this.emitStatsUpdate();

      logger.debug('Trading cycle complete');
    } catch (error) {
      logger.error({ error }, 'Error in trading cycle');
    }
  }

  /**
   * Emit stats update event for dashboard
   */
  private async emitStatsUpdate(): Promise<void> {
    try {
      const stats = this.tradingEngine
        ? await this.tradingEngine.getStats()
        : { todayTrades: 0, openPositions: 0, dailyPnL: 0, consecutiveLosses: 0 };

      // Calculate win rate from completed trades
      const allTrades = this.db.trades.getRecent(100);
      const completedRoundTrips = this.calculateCompletedTrades(allTrades);
      const winRate = completedRoundTrips.total > 0
        ? (completedRoundTrips.wins / completedRoundTrips.total) * 100
        : 0;

      // Count buybacks
      const buybacks = allTrades.filter(t => t.metadata?.isBuyback).length;

      // Get wallet balance
      let balance = 0;
      if (this.walletPublicKey) {
        try {
          const lamports = await this.connection.getBalance(this.walletPublicKey);
          balance = lamports / LAMPORTS_PER_SOL;
        } catch (err) {
          logger.debug({ error: err }, 'Failed to fetch wallet balance');
        }
      } else {
        logger.debug('No wallet configured - balance will show as 0');
      }

      agentEvents.emit({
        type: 'STATS_UPDATE',
        timestamp: Date.now(),
        data: {
          todayTrades: stats.todayTrades,
          openPositions: stats.openPositions,
          dailyPnL: stats.dailyPnL,
          winRate,
          totalBuybacks: buybacks,
          balance,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Error emitting stats update');
    }
  }

  /**
   * Calculate completed trades (wins/losses)
   */
  private calculateCompletedTrades(trades: Array<{ type: string; tokenMint: string; amountSol: number; metadata?: Record<string, unknown> }>): { wins: number; losses: number; total: number } {
    const tokenBuyCosts = new Map<string, number[]>();
    let wins = 0;
    let losses = 0;

    for (const trade of trades.filter(t => !t.metadata?.isBuyback)) {
      if (trade.type === 'BUY') {
        const costs = tokenBuyCosts.get(trade.tokenMint) || [];
        costs.push(trade.amountSol);
        tokenBuyCosts.set(trade.tokenMint, costs);
      } else if (trade.type === 'SELL') {
        const costs = tokenBuyCosts.get(trade.tokenMint) || [];
        if (costs.length > 0) {
          const buyCost = costs.shift()!;
          tokenBuyCosts.set(trade.tokenMint, costs);
          if (trade.amountSol > buyCost) {
            wins++;
          } else {
            losses++;
          }
        }
      }
    }

    return { wins, losses, total: wins + losses };
  }

  /**
   * Check open positions for stop-loss/take-profit exits
   */
  private async checkPositionExits(): Promise<void> {
    if (!this.tradingEngine) return;

    try {
      const exitSignatures = await this.tradingEngine.checkPositionsForExit();

      for (const signature of exitSignatures) {
        agentEvents.emit({
          type: 'TRADE_EXECUTED',
          timestamp: Date.now(),
          data: {
            mint: 'position-exit',
            type: 'SELL',
            signature,
            amount: 0, // Amount determined by position
          },
        });
      }

      if (exitSignatures.length > 0) {
        logger.info({ count: exitSignatures.length }, 'Position exits executed');
      }
    } catch (error) {
      logger.error({ error }, 'Error checking position exits');
    }
  }

  /**
   * Check for smart money presence in a token's holders
   * Returns the count of smart money wallets holding this token
   *
   * Note: Full implementation requires fetching top token holders.
   * This is a placeholder that returns 0 until holder data is integrated.
   */
  private async checkSmartMoney(mint: string): Promise<number> {
    // TODO: Implement when we have a way to get token holders
    // The flow would be:
    // 1. Fetch top N holders for this token (via Helius getTokenAccounts or PumpPortal)
    // 2. For each holder, call this.smartMoney.isSmartMoney(holderAddress)
    // 3. Return count of smart money wallets
    //
    // For now, return 0 as we don't have the holder data API integrated
    logger.debug({ mint }, 'Smart money check skipped - holder data not available');
    return 0;
  }



  /**
   * Get cached metadata for a token
   */
  getTokenMetadata(mint: string): TokenMetadata | undefined {
    return this.tokenMetadataCache.get(mint);
  }

  /**
   * Analyze a token and execute trade if approved
   * Accepts data from Birdeye (trending tokens) using Trending Analysis
   */
  private async analyzeAndTrade(mint: string, birdeyeToken?: BirdeyeToken): Promise<void> {
    // Try to get enriched metadata from DexScreener
    let metadata = this.tokenMetadataCache.get(mint);
    if (!metadata) {
      // Small delay for very new tokens to appear on DexScreener

      metadata = await dexscreener.getTokenMetadata(mint) || undefined;
      if (metadata) {
        this.tokenMetadataCache.set(mint, metadata);
      }
    }

    // Use Birdeye data as fallback
    const symbol = metadata?.symbol || birdeyeToken?.symbol || mint.slice(0, 6);
    const name = metadata?.name || birdeyeToken?.name || 'Unknown';
    const marketCapSol = (birdeyeToken?.marketCap ? birdeyeToken.marketCap / 170 : 0);
    const liquidity = metadata?.liquidity || birdeyeToken?.liquidity || (marketCapSol * 170);
    const isTrending = !!birdeyeToken;

    // CRITICAL: Safety Analysis FIRST (save API calls and time)
    // Bail immediately if unsafe (mint/freeze auth enabled)
    const safetyResult = await this.tokenSafety.analyze(mint);

    agentEvents.emit({
      type: 'SAFETY_CHECK',
      timestamp: Date.now(),
      data: { mint, result: safetyResult },
    });

    if (!safetyResult.isSafe) {
        logger.warn({ mint, risks: safetyResult.risks }, '⛔ REJECTED: Unsafe token (Mint/Freeze Auth)');
        return;
    }

    // Filter: Liquidity to Market Cap Ratio Check
    // Prevent thin LP rugs (liquidity < 8% of MC)
    if (liquidity > 0 && marketCapSol > 0) {
        const mcUsd = marketCapSol * 170; // Approx SOL price
        const ratio = liquidity / mcUsd;
        if (ratio < 0.08) {
             logger.warn({ mint, liquidity, mcUsd, ratio: ratio.toFixed(3) }, '⛔ REJECTED: Thin Liquidity (<8% of MC)');
             return;
        }
    }

    logger.info({
      mint,
      symbol,
      name,
      hasDexData: !!metadata,
      marketCapSol,
      source: isTrending ? 'BIRDEYE_TRENDING' : 'DEXSCREENER',
    }, isTrending ? '📈 Analyzing TRENDING token...' : '🆕 Analyzing NEW token...');

    // Emit TOKEN_DISCOVERED with best available data
    // Use Birdeye logo as fallback
    const imageUrl = metadata?.imageUrl || birdeyeToken?.logoURI;

    agentEvents.emit({
      type: 'TOKEN_DISCOVERED',
      timestamp: Date.now(),
      data: {
        mint,
        name,
        symbol,
        priceUsd: metadata?.priceUsd || birdeyeToken?.price || 0,
        priceChange5m: metadata?.priceChange5m || 0,
        priceChange1h: metadata?.priceChange1h || birdeyeToken?.priceChange1h || 0,
        volume1h: metadata?.volume1h || birdeyeToken?.volume24h || 0,
        liquidity,
        marketCap: metadata?.marketCap || birdeyeToken?.marketCap || (marketCapSol * 170),
        buys5m: metadata?.buys5m || 0,
        sells5m: metadata?.sells5m || 0,
        ageMinutes: metadata?.ageMinutes || 0,
        dexUrl: metadata?.dexUrl || `https://dexscreener.com/solana/${mint}`,
        imageUrl,
        marketCapSol,
      },
    });

    // Emit analysis start event
    agentEvents.emit({
      type: 'ANALYSIS_START',
      timestamp: Date.now(),
      data: { mint },
    });

    // NOTE: Removed verbose scanning thoughts - SCHIZO was too chatty
    // Only speak on interesting findings (safety issues, trades, etc.)

    try {
      // PRE-CHECK: Minimum activity check - don't buy zero-action tokens
      // Skip for trending tokens (already vetted by Birdeye)
      // ALSO skip for PumpPortal tokens (brand new, pre-vetted by PumpPortal feed)
      if (!isTrending) {
        // AGGRESSIVE FILTER: No age requirement, only need SOME activity
        const MIN_VOLUME_USD = 10;  // Just need $10 in volume
        const MIN_TRANSACTIONS = 2; // Or 2 transactions

        const volume = metadata?.volume1h || 0;
        const totalTxns = (metadata?.buys5m || 0) + (metadata?.sells5m || 0);

        // Reject ONLY if there's literally zero activity
        if (volume < MIN_VOLUME_USD && totalTxns < MIN_TRANSACTIONS) {
          logger.info({ 
            mint, symbol, volume, totalTxns,
            reason: 'Zero activity detected' 
          }, 'REJECTED: Token has no trading activity');
          return;
        }

        logger.info({ 
          mint, symbol, volume, totalTxns,
          ageMinutes: metadata?.ageMinutes || 0
        }, '✅ Token has activity - proceeding to analysis');

      } else {
        logger.info({ mint, symbol, volume24h: birdeyeToken?.volume24h, liquidity: birdeyeToken?.liquidity }, 'Trending token - skipping new token activity checks');
      }

      // Step 1: Safety analysis (Already done above!)
      // Skipping redundant call...
      
      // Only emit SAFETY thought if there are critical risks worth calling out
      const hasCriticalRisk = safetyResult.risks.some(r =>
        r === 'MINT_AUTHORITY_ACTIVE' || r === 'FREEZE_AUTHORITY_ACTIVE'
      );
      if (this.claude && hasCriticalRisk) {
        try {
          const safetyThought = await this.claude.generateAnalysisThought('safety', {
            symbol,
            name,
            isSafe: safetyResult.isSafe,
            risks: safetyResult.risks,
          });
          agentEvents.emit({
            type: 'ANALYSIS_THOUGHT',
            timestamp: Date.now(),
            data: {
              mint,
              symbol,
              stage: 'safety',
              thought: safetyThought,
              details: {
                isSafe: safetyResult.isSafe,
                risks: safetyResult.risks,
              },
            },
          });
        } catch (err) {
          logger.debug({ err }, 'Failed to generate safety thought');
        }
      }

      // Step 2: Smart money check
      // Note: Full smart money detection requires fetching top token holders,
      // which needs additional API calls. For now, we rely on the Trading Engine's
      // safety analysis. Smart money signals can be added when holder data is available.
      const smartMoneyCount = await this.checkSmartMoney(mint);

      agentEvents.emit({
        type: 'SMART_MONEY_CHECK',
        timestamp: Date.now(),
        data: { mint, count: smartMoneyCount },
      });

      // Only emit SMART_MONEY thought if we actually found smart money (rare/interesting)
      if (this.claude && smartMoneyCount > 0) {
        try {
          const smartMoneyThought = await this.claude.generateAnalysisThought('smart_money', {
            symbol,
            name,
            smartMoneyCount,
          });
          agentEvents.emit({
            type: 'ANALYSIS_THOUGHT',
            timestamp: Date.now(),
            data: {
              mint,
              symbol,
              stage: 'smart_money',
              thought: smartMoneyThought,
              details: {
                smartMoneyCount,
              },
            },
          });
        } catch (err) {
          logger.debug({ err }, 'Failed to generate smart money thought');
        }
      }

      // Step 3: Get trading decision from Trading Engine (if available)
      if (!this.tradingEngine) {
        // Analysis-only mode - just emit that we analyzed it
        agentEvents.emit({
          type: 'TRADE_DECISION',
          timestamp: Date.now(),
          data: {
            mint,
            decision: {
              shouldTrade: false,
              reasons: ['Analysis-only mode'],
              positionSizeSol: 0,
              safetyAnalysis: safetyResult,
              smartMoneyCount,
            },
            reasoning: 'Running in analysis-only mode - no trading engine configured',
          },
        });
        return;
      }

      // Pass metadata to avoid extra API calls
      const tokenMeta = {
        liquidity: metadata?.liquidity,
        marketCapSol: marketCapSol,
      };
      const decision = await this.tradingEngine.evaluateToken(mint, tokenMeta);

      // Emit decision event with AI reasoning
      agentEvents.emit({
        type: 'TRADE_DECISION',
        timestamp: Date.now(),
        data: {
          mint,
          decision,
          reasoning: decision.reasoning,
        },
      });

      // Emit DECISION thought - ONLY on BUY decisions (not every single reject)
      // This prevents SCHIZO from being too chatty about every token he passes on
      if (this.claude && decision.shouldTrade) {
        try {
          const decisionThought = await this.claude.generateAnalysisThought('decision', {
            symbol,
            name,
            shouldTrade: decision.shouldTrade,
            reasons: decision.reasons,
          });
          agentEvents.emit({
            type: 'ANALYSIS_THOUGHT',
            timestamp: Date.now(),
            data: {
              mint,
              symbol,
              stage: 'decision',
              thought: decisionThought,
              details: {
                shouldTrade: decision.shouldTrade,
                reasons: decision.reasons,
              },
            },
          });
        } catch (err) {
          logger.debug({ err }, 'Failed to generate decision thought');
        }
      }

      // Step 4: Execute trade if approved
      if (decision.shouldTrade) {
        if (!this.config.enableTrading) {
          logger.info({ mint, decision }, 'Trade approved but execution DISABLED (Analysis Mode)');
          
          // Emit SIMULATED trade event for dashboard visualization
          agentEvents.emit({
            type: 'TRADE_EXECUTED',
            timestamp: Date.now(),
            data: {
              mint,
              type: 'BUY',
              signature: 'SIMULATED_MODE',
              amount: decision.positionSizeSol,
            },
          });
          return;
        }

        logger.info({ mint, positionSize: decision.positionSizeSol }, 'Executing trade...');
        
        const signature = await this.tradingEngine.executeBuy(mint);
        
        if (signature) {
          agentEvents.emit({
            type: 'TRADE_EXECUTED',
            timestamp: Date.now(),
            data: {
              mint,
              type: 'BUY',
              signature,
              amount: decision.positionSizeSol,
            },
          });

          logger.info({ mint, signature }, 'Trade executed successfully');
        } else {
          logger.warn({ mint }, 'Trade execution failed');
        }
      } else {
        logger.info({ mint, reasons: decision.reasons }, 'Trade rejected');
      }
    } catch (error) {
      logger.error({ mint, error }, 'Error analyzing token');
    }
  }
}
