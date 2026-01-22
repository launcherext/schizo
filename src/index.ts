import { Pool } from 'pg';
import { createChildLogger } from './utils/logger';
import { config } from './config/settings';
import { createTables } from './db/schema';
import { repository } from './db/repository';

// Data Layer
import { heliusWs, priceFeed, whaleTracker, NewTokenEvent, PriceData, WhaleActivity } from './data';
import { pumpPortalWs, BondingCurveData } from './data/pumpportal-ws';

// Signal Processing Layer
import { featureExtractor, rugDetector, pumpDetector, velocityTracker, entryEvaluator, rugMonitor, narrativeSensor, NarrativeSignal, tokenWatchlist } from './signals';
import { StateVector, PumpMetrics, RugScore } from './signals/types';

// AI Layer
import { ddqnAgent, regimeDetector, positionSizer } from './ai';
import { Action, AIDecision, MarketRegime } from './ai/types';

// Execution Layer
import { txManager } from './execution';

// Risk Layer
import { positionManager, capitalAllocator, drawdownGuard } from './risk';

// Learning Layer
import { tradeLogger, performanceAnalytics, modelTrainer } from './learning';

// Services Layer
import { walletSync, equityTracker, positionReconciler, c100Tracker, rewardClaimer, c100Buyback } from './services';

// API Layer
import { apiServer } from './api';

const logger = createChildLogger('orchestrator');

class TradingBot {
  private isRunning = false;
  private tokenQueue: NewTokenEvent[] = [];
  private processedMints: Set<string> = new Set();
  private bondingCurveCache: Map<string, BondingCurveData> = new Map();
  private rejectionStats = {
    quickSafety: 0,
    liquidity: 0,
    rugScore: 0,
    entryEval: 0,  // Combined pump/velocity rejection
    aiDecision: 0,
    riskCheck: 0,
    total: 0,
    passed: 0,
  };

  async start(): Promise<void> {
    logger.info('Starting Solana AI Trading Bot');
    logger.info({ paperTrading: config.paperTrading }, 'Mode');

    try {
      // Initialize database
      logger.info('Initializing database...');
      await repository.connect();
      const pool = new Pool({ connectionString: config.databaseUrl });
      await createTables(pool);
      await pool.end();

      // Initialize all layers
      logger.info('Initializing layers...');

      // Execution layer
      await txManager.initialize();

      // AI layer
      await modelTrainer.initialize();
      await regimeDetector.start();

      // Risk layer
      await capitalAllocator.syncWithWallet();
      await positionManager.start();
      await drawdownGuard.start();
      await drawdownGuard.resetAll();  // Clear old state for fresh testing - must be AFTER start

      // Data layer
      await priceFeed.start();
      await whaleTracker.start();

      // Setup event handlers
      this.setupEventHandlers();

      // Start WebSocket connections
      await heliusWs.connect();

      // Connect to PumpPortal for bonding curve data
      try {
        await pumpPortalWs.connect();
        logger.info('PumpPortal WebSocket connected');
      } catch (error) {
        logger.warn({ error }, 'PumpPortal connection failed - will use DexScreener fallback');
      }

      // Start learning
      await modelTrainer.startPeriodicTraining();

      // Start API server for dashboard
      await apiServer.start();

      // Start wallet sync and equity tracking services
      await walletSync.start(30000);      // Sync wallet every 30s
      await equityTracker.start(60000);   // Snapshot equity every 60s

      // Initial position reconciliation to detect any phantoms from previous session
      const reconcileResult = await positionReconciler.reconcile(true);
      if (reconcileResult.phantomsFound.length > 0) {
        logger.warn({
          phantoms: reconcileResult.phantomsFound.length,
          closed: reconcileResult.phantomsClosed,
        }, 'Startup reconciliation found phantom positions');
      }

      // Start C100 services
      await c100Tracker.start(30000);           // Price updates every 30s
      await rewardClaimer.start(5 * 60 * 1000); // Claim every 5 minutes
      await c100Buyback.initialize();

      this.isRunning = true;
      logger.info('Bot started successfully');

      // Process token queue periodically
      this.startTokenProcessor();

      // Periodic status logging
      this.startStatusLogger();

    } catch (error) {
      logger.error({ error }, 'Failed to start bot');
      await this.stop();
      throw error;
    }
  }

  private setupEventHandlers(): void {
    // New token detection from Helius
    heliusWs.on('newToken', (event: NewTokenEvent) => {
      logger.info({ mint: event.mint }, 'New token detected');
      this.tokenQueue.push(event);
    });

    // PumpPortal bonding curve data - add to watchlist for AI-driven entry
    pumpPortalWs.on('newToken', (data: BondingCurveData) => {
      this.bondingCurveCache.set(data.mint, data);

      // Subscribe to this token's trades for data collection
      pumpPortalWs.subscribeToToken(data.mint);

      // Add to watchlist for AI-driven entry (instead of immediate sniping)
      // Creator is the bonding curve key for pump.fun tokens
      tokenWatchlist.addToken(data.mint, data.bondingCurveKey);

      // Record initial price point
      tokenWatchlist.recordPrice(data.mint, data.priceSol, data.marketCapSol);

      logger.info({
        mint: data.mint.substring(0, 15),
        marketCapSol: data.marketCapSol.toFixed(2),
        liquiditySol: data.liquiditySol.toFixed(2),
      }, 'New token added to watchlist (AI-driven entry)');
    });

    pumpPortalWs.on('trade', (data: BondingCurveData & { txType: 'buy' | 'sell'; traderPublicKey: string; tokenAmount?: number }) => {
      // Update cache with latest bonding curve state
      this.bondingCurveCache.set(data.mint, data);

      // Record trade for velocity tracking (legacy)
      velocityTracker.recordTrade({
        mint: data.mint,
        txType: data.txType,
        traderPublicKey: data.traderPublicKey,
        marketCapSol: data.marketCapSol,
      });

      // Record trade to watchlist for AI-driven entry analysis
      tokenWatchlist.recordTrade(data.mint, {
        txType: data.txType,
        traderPublicKey: data.traderPublicKey,
        tokenAmount: data.tokenAmount || 0,
        marketCapSol: data.marketCapSol,
        priceSol: data.priceSol,
      });

      // Feed to rug monitor for post-entry protection
      rugMonitor.processTrade({
        mint: data.mint,
        txType: data.txType,
        traderPublicKey: data.traderPublicKey,
        tokenAmount: data.tokenAmount || 0,
        marketCapSol: data.marketCapSol,
        priceSol: data.priceSol,
      });
    });

    // Whale activity
    whaleTracker.on('whaleActivity', (activity: WhaleActivity) => {
      logger.info({
        wallet: activity.wallet,
        action: activity.action,
        mint: activity.mint,
        amountSol: activity.amountSol,
      }, 'Whale activity detected');

      // Could trigger analysis of the token
      if (activity.action === 'buy' && activity.amountSol > 50) {
        this.tokenQueue.push({
          mint: activity.mint,
          signature: '',
          timestamp: new Date(),
          creator: activity.wallet,
        });
      }
    });

    // Position events
    positionManager.on('positionOpened', (position) => {
      capitalAllocator.reserveCapital(position.amountSol, position.poolType);
      // Note: rugMonitor.watchPosition is called in analyzeAndTrade where we have creator info
    });

    positionManager.on('positionClosed', async (data) => {
      const { position, reason, pnlSol, pnlPercent, partialClosePnl, actualSolReceived } = data;

      capitalAllocator.releaseCapital(position.amountSol, position.poolType);
      drawdownGuard.recordTrade(pnlSol);
      positionSizer.recordTrade(pnlSol > 0);

      // Stop watching for rug signals
      rugMonitor.unwatchPosition(position.mint);

      // Log exit with accurate PnL including partial closes and actual SOL received
      await tradeLogger.logExit({
        positionId: position.id,
        exitPrice: position.currentPrice,
        exitReason: reason,
        actualSolReceived,
        partialClosePnl: partialClosePnl || 0,
      });

      // Take equity snapshot on trade close
      await equityTracker.onTradeClose();

      // Add to training
      await modelTrainer.addTradeExperience(position.id);

      // C100 Buyback on profitable close
      if (pnlSol > 0) {
        c100Buyback.onProfitableClose(pnlSol).catch(err => {
          logger.error({ err }, 'C100 buyback failed');
        });
      }

      logger.info({
        positionId: position.id,
        reason,
        pnlSol: pnlSol.toFixed(6),
        pnlPercent: pnlPercent.toFixed(2),
        partialClosePnl: (partialClosePnl || 0).toFixed(6),
      }, 'Position closed');
    });

    // Rug monitor alerts - close position immediately on critical rug signals
    rugMonitor.on('rugAlert', async (warning) => {
      const position = positionManager.getPositionByMint(warning.mint);
      if (position && position.status === 'open') {
        logger.error({
          positionId: position.id,
          mint: warning.mint.substring(0, 12) + '...',
          type: warning.type,
          message: warning.message,
        }, 'RUG DETECTED - Closing position immediately');

        await positionManager.closePosition(position.id, 'rug_detected');
      }
    });

    positionManager.on('partialClose', async (data) => {
      logger.info({
        positionId: data.position.id,
        tpLevel: data.tpLevel + 1,
        sellAmount: data.sellAmount,
      }, 'Partial close executed');
    });

    // Drawdown events
    drawdownGuard.on('tradingPaused', (data) => {
      logger.error(data, 'TRADING PAUSED');
    });

    drawdownGuard.on('tradingResumed', (data) => {
      logger.info(data, 'Trading resumed');
    });

    // Price events
    priceFeed.on('significantPriceChange', (data: { mint: string; change: number; data: PriceData }) => {
      logger.debug({
        mint: data.mint,
        change: data.change.toFixed(2),
      }, 'Significant price change');
    });
  }

  private startTokenProcessor(): void {
    // Process Helius token queue (legacy - for whale activity etc)
    setInterval(() => {
      this.processTokenQueue();
    }, 2000); // Process every 2 seconds

    // NEW: Process watchlist for AI-driven entry
    setInterval(() => {
      this.processWatchlistTokens();
    }, 5000); // Check watchlist every 5 seconds

    // Cleanup old watchlist entries
    setInterval(() => {
      tokenWatchlist.cleanup(600000); // 10 minute max age
    }, 60000); // Cleanup every minute
  }

  // NEW: Process tokens in watchlist that have enough data for AI analysis
  private async processWatchlistTokens(): Promise<void> {
    if (!this.isRunning) return;

    if (!drawdownGuard.canTrade()) {
      return; // Already logged in processTokenQueue
    }

    const readyTokens = tokenWatchlist.getReadyTokens();

    if (readyTokens.length > 0) {
      const stats = tokenWatchlist.getStats();
      logger.info({
        total: stats.total,
        ready: stats.ready,
        devSold: stats.devSold,
      }, 'Watchlist status');
    }

    for (const mint of readyTokens) {
      // Skip if already in a position or recently processed
      if (this.processedMints.has(mint)) continue;
      if (positionManager.getPositionByMint(mint)) continue;

      const filterResult = tokenWatchlist.passesHardFilters(mint);
      if (!filterResult.passes) {
        logger.debug({ mint: mint.substring(0, 15), reason: filterResult.reason }, 'Watchlist token rejected by hard filters');
        continue;
      }

      // Get watchlist features for logging/decision
      const watchlistFeatures = tokenWatchlist.extractFeatures(mint);
      if (!watchlistFeatures) continue;

      logger.info({
        mint: mint.substring(0, 15),
        priceChange: (watchlistFeatures.priceChange * 100).toFixed(2) + '%',
        volatility: watchlistFeatures.volatility.toFixed(4),
        drawdown: (watchlistFeatures.drawdown * 100).toFixed(2) + '%',
        buyPressure: (watchlistFeatures.buyPressure * 100).toFixed(0) + '%',
        uniqueTraders: watchlistFeatures.uniqueTraders,
        ageMinutes: watchlistFeatures.ageMinutes.toFixed(1),
      }, 'Analyzing watchlist token for AI entry');

      // Create synthetic event for analyzeAndTrade
      const token = tokenWatchlist.getToken(mint);
      if (!token) continue;

      const syntheticEvent: NewTokenEvent = {
        mint,
        signature: '',
        timestamp: new Date(token.firstSeen),
        creator: token.creator,
      };

      try {
        await this.analyzeAndTrade(syntheticEvent);
        this.processedMints.add(mint);

        // Cleanup processed token from watchlist
        tokenWatchlist.removeToken(mint);
      } catch (error) {
        logger.error({ mint, error }, 'Failed to analyze watchlist token');
      }
    }
  }

  private async processTokenQueue(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    if (!drawdownGuard.canTrade()) {
      const ddState = drawdownGuard.getState();
      logger.warn({
        queueLen: this.tokenQueue.length,
        currentDrawdown: (ddState.currentDrawdown * 100).toFixed(2),
        dailyPnl: ddState.dailyPnl.toFixed(4),
        isPaused: ddState.isPaused,
      }, 'Drawdown guard blocking trading');
      return;
    }

    if (this.tokenQueue.length > 0) {
      logger.info({ queueLen: this.tokenQueue.length }, 'Processing token queue');
    }

    while (this.tokenQueue.length > 0) {
      const token = this.tokenQueue.shift();
      if (!token) continue;

      // Skip if already processed recently
      if (this.processedMints.has(token.mint)) continue;

      try {
        logger.info({ mint: token.mint.substring(0, 15) }, 'Analyzing token...');
        await this.analyzeAndTrade(token);
        this.processedMints.add(token.mint);

        // Clean up old processed mints
        if (this.processedMints.size > 1000) {
          const oldest = Array.from(this.processedMints).slice(0, 500);
          oldest.forEach((m) => this.processedMints.delete(m));
        }
      } catch (error) {
        logger.error({ mint: token.mint, error }, 'Failed to analyze token');
      }
    }
  }

  private async analyzeAndTrade(token: NewTokenEvent): Promise<void> {
    const { mint } = token;

    logger.debug({ mint }, 'Analyzing token');

    // Get token info
    const tokenInfo = await priceFeed.getTokenInfo(mint);
    const holderInfo = await priceFeed.getHolderInfo(mint);

    // Quick safety check
    const quickSafety = rugDetector.getQuickSafetyFlags(tokenInfo, mint);
    logger.info({ mint, quickSafety }, 'Quick safety check result');
    if (!quickSafety.isSafe) {
      this.rejectionStats.quickSafety++;
      this.rejectionStats.total++;
      logger.info({ mint, flags: quickSafety.flags }, 'REJECTED: Quick safety check failed');
      return;
    }

    // Get price/liquidity data
    const isPumpFunToken = mint.endsWith('pump');
    let priceData = await priceFeed.fetchTokenPrice(mint);
    let bondingCurveData: BondingCurveData | null = null;

    // For Pump.fun tokens: Try PumpPortal bonding curve data first (instant!)
    if (isPumpFunToken) {
      // Check cache from PumpPortal WebSocket
      bondingCurveData = this.bondingCurveCache.get(mint) || pumpPortalWs.getBondingCurveData(mint);

      if (!bondingCurveData) {
        // Wait briefly for PumpPortal to receive the data
        for (let retry = 0; retry < 3; retry++) {
          logger.info({ mint, retry: retry + 1 }, 'Waiting for PumpPortal bonding curve data...');
          await new Promise(r => setTimeout(r, 2000));
          bondingCurveData = this.bondingCurveCache.get(mint) || pumpPortalWs.getBondingCurveData(mint);
          if (bondingCurveData) break;
        }
      }

      if (bondingCurveData) {
        logger.info({
          mint,
          source: 'PumpPortal',
          marketCapSol: bondingCurveData.marketCapSol.toFixed(2),
          liquiditySol: bondingCurveData.liquiditySol.toFixed(4),
          priceSol: bondingCurveData.priceSol.toExponential(4),
          isGraduated: bondingCurveData.isGraduated,
        }, 'Got bonding curve data');

        // Mark as bonding curve token for trade routing
        txManager.markAsBondingCurve(mint);
      } else if (!priceData) {
        // Try DexScreener as fallback (might be graduated)
        for (let retry = 0; retry < 2; retry++) {
          logger.info({ mint, retry: retry + 1 }, 'Trying DexScreener fallback...');
          await new Promise(r => setTimeout(r, 3000));
          priceData = await priceFeed.fetchTokenPrice(mint);
          if (priceData) {
            txManager.markAsGraduated(mint);
            break;
          }
        }
      }
    }

    // Determine liquidity
    let liquiditySol = 0;
    let priceSol = 0;
    let isBondingCurve = false;

    if (bondingCurveData) {
      // For bonding curve tokens, use marketCapSol as liquidity indicator
      // liquiditySol from bonding curve is essentially 0 for new tokens
      // marketCapSol is a better indicator of whether the token is tradeable
      liquiditySol = bondingCurveData.marketCapSol; // Use marketCap as proxy for new tokens
      priceSol = bondingCurveData.priceSol;
      isBondingCurve = true;
    } else if (priceData) {
      liquiditySol = priceData.liquidity / (priceFeed.getSolPrice() || 200); // Convert USD to SOL
      priceSol = priceData.priceSol;
    }

    // Minimum liquidity threshold - lower for bonding curve tokens
    const minLiquidity = isBondingCurve ? 10 : config.minLiquiditySol; // 10 SOL mcap for new tokens

    logger.info({
      mint,
      source: bondingCurveData ? 'PumpPortal' : (priceData ? 'DexScreener' : 'none'),
      liquiditySol: liquiditySol.toFixed(4),
      priceSol: priceSol.toExponential(4),
      minRequired: minLiquidity,
      isBondingCurve
    }, 'Liquidity check');

    // No data from either source
    if (!bondingCurveData && !priceData) {
      this.rejectionStats.liquidity++;
      this.rejectionStats.total++;
      logger.warn({ mint }, 'REJECTED: No price data from PumpPortal or DexScreener');
      return;
    }

    if (liquiditySol < minLiquidity) {
      this.rejectionStats.liquidity++;
      this.rejectionStats.total++;
      logger.info({ mint, liquiditySol, minRequired: minLiquidity }, 'REJECTED: Insufficient liquidity');
      return;
    }

    // Create unified price data for downstream processing
    // If using bonding curve data, convert to PriceData format
    if (!priceData && bondingCurveData) {
      const solPrice = priceFeed.getSolPrice() || 200;
      priceData = {
        mint,
        priceSol: bondingCurveData.priceSol,
        priceUsd: bondingCurveData.priceSol * solPrice,
        volume24h: 0,
        marketCapSol: bondingCurveData.marketCapSol,
        liquidity: bondingCurveData.liquiditySol * solPrice, // Convert to USD
        priceChange1m: 0,
        priceChange5m: 0,
        priceChange1h: 0,
        timestamp: bondingCurveData.timestamp,
      };
    }

    // Full rug analysis (LP info passed as null - loses 25 potential points)
    const rugScore = await rugDetector.analyzeToken(mint, tokenInfo, holderInfo, null);

    // Get narrative signal (async but don't block critical path too long)
    // We fire and forget the broadcast, or await if we want it in decision (future)
    narrativeSensor.getNarrativeSignal(tokenInfo?.symbol).then((signal: NarrativeSignal) => {
      apiServer.getIO().emit('signal:narrative', {
        mint,
        symbol: tokenInfo?.symbol,
        ...signal
      });
    }).catch((err: unknown) => logger.error({ err }, 'Failed to get narrative signal'));

    logger.info({
      mint,
      rugTotal: rugScore.total,
      minRequired: config.minRugScore,
      mintAuth: rugScore.mintAuthorityScore,
      freezeAuth: rugScore.freezeAuthorityScore,
      lpLocked: rugScore.lpLockedScore,
      concentration: rugScore.concentrationScore,
      bundledBuys: rugScore.bundledBuysScore,
    }, 'Rug analysis breakdown');

    if (!rugDetector.isSafe(rugScore)) {
      this.rejectionStats.rugScore++;
      this.rejectionStats.total++;
      logger.info({ mint, rugTotal: rugScore.total, minRequired: config.minRugScore }, 'REJECTED: Token failed rug check');
      return;
    }

    // Extract features (priceData is guaranteed non-null here due to earlier checks)
    const features = await featureExtractor.extractFeatures(
      mint,
      priceData!,
      holderInfo,
      tokenInfo
    );

    // Entry evaluation: uses pump detector if price history exists, otherwise velocity
    priceFeed.addToWatchList(mint); // Start tracking
    await new Promise((r) => setTimeout(r, 2000)); // Reduced delay for faster entry

    // Use unified entry evaluator
    const entryResult = entryEvaluator.evaluate(mint, bondingCurveData?.marketCapSol);

    // Also get pump metrics for logging/display regardless of entry source
    const pumpMetrics = pumpDetector.analyzePump(mint);
    logger.info({
      mint,
      entrySource: entryResult.source,
      canEnter: entryResult.canEnter,
      entryReason: entryResult.reason,
      phase: pumpMetrics.phase,
      heat: pumpMetrics.heat,
      buyPressure: pumpMetrics.buyPressure,
      confidence: pumpMetrics.confidence,
    }, 'Entry evaluation');

    // Check if good entry
    if (!entryResult.canEnter) {
      this.rejectionStats.entryEval++;
      this.rejectionStats.total++;
      logger.info({ mint, source: entryResult.source, reason: entryResult.reason }, 'REJECTED: Entry evaluation failed');
      priceFeed.removeFromWatchList(mint);
      velocityTracker.clearToken(mint);
      pumpPortalWs.unsubscribeFromToken(mint);
      return;
    }

    // Extract buy pressure from entry evaluation for AI confidence calculation
    // Use velocity metrics if available, otherwise fall back to pump metrics
    let entryBuyPressure = pumpMetrics.buyPressure;
    if (entryResult.metrics && 'buyPressure' in entryResult.metrics) {
      entryBuyPressure = entryResult.metrics.buyPressure;
    }

    // AI Decision
    const decision = this.makeDecision(features, rugScore, pumpMetrics, mint, entryBuyPressure);
    
    // Broadcast AI decision
    apiServer.getIO().emit('ai:decision', {
      ...decision,
      mint,
      symbol: tokenInfo?.symbol || 'UNKNOWN',
    });

    logger.info({
      mint,
      action: Action[decision.action],
      qValues: decision.qValues,
      confidence: decision.confidence,
      regime: decision.regime,
    }, 'AI decision');

    if (decision.action !== Action.BUY) {
      this.rejectionStats.aiDecision++;
      this.rejectionStats.total++;
      logger.info({ mint, action: Action[decision.action], qValues: decision.qValues }, 'REJECTED: AI decided not to buy');
      priceFeed.removeFromWatchList(mint);
      return;
    }

    // Risk check
    const poolType = capitalAllocator.suggestPoolType(rugScore.total);
    const riskCheck = capitalAllocator.checkRisk(decision.positionSize.sizeSol, poolType);
    logger.info({
      mint,
      poolType,
      requestedSize: decision.positionSize.sizeSol,
      openPositions: positionManager.getOpenPositions().length,
      maxPositions: config.maxConcurrentPositions,
      approved: riskCheck.approved,
      adjustedSize: riskCheck.adjustedSize,
    }, 'Risk check input');

    if (!riskCheck.approved) {
      this.rejectionStats.riskCheck++;
      this.rejectionStats.total++;
      logger.info({ mint, reason: riskCheck.reason, poolType, requestedSize: decision.positionSize.sizeSol }, 'REJECTED: Risk check failed');
      priceFeed.removeFromWatchList(mint);
      return;
    }

    // All filters passed!
    this.rejectionStats.passed++;
    logger.info({ mint, rugScore: rugScore.total, heat: pumpMetrics.heat, poolType }, 'PASSED: All filters - proceeding to trade');

    // Execute trade
    await this.executeBuy(
      mint,
      tokenInfo?.symbol || 'UNKNOWN',
      riskCheck.adjustedSize || decision.positionSize.sizeSol,
      priceData!.priceSol,
      features,
      pumpMetrics,
      poolType,
      token.creator
    );
  }

  private makeDecision(
    features: StateVector,
    rugScore: RugScore,
    pumpMetrics: PumpMetrics,
    mint?: string,  // NEW: Pass mint for dynamic threshold lookup
    entryBuyPressure?: number  // NEW: Buy pressure from entry evaluation
  ): AIDecision {
    const stateArray = featureExtractor.toArray(features);
    const { action, qValues } = ddqnAgent.selectAction(stateArray);

    const regime = regimeDetector.getCurrentRegime().regime;
    const availableCapital = capitalAllocator.getAvailableCapital('active');

    // Check if DDQN is in exploration mode (qValues all zeros)
    const isExplorationMode = qValues.every(q => q === 0);

    // Adjust confidence based on signals
    let confidence: number;
    if (isExplorationMode && entryBuyPressure !== undefined) {
      // In exploration mode, use entry evaluation's buy pressure directly as confidence
      // Entry evaluation already validated the token (5+ txs, 3+ buyers, good buy pressure)
      // Rug score was already validated separately (>45 threshold)
      // So use buyPressure directly - 67% buy pressure = 0.67 confidence
      confidence = entryBuyPressure;
      logger.info({
        mint: mint?.substring(0, 15),
        entryBuyPressure: entryBuyPressure.toFixed(2),
        rugScore: rugScore.total,
        confidence: confidence.toFixed(2),
      }, 'Using entry buy pressure as confidence (exploration mode)');
    } else {
      // Normal mode: use qValues spread as confidence
      confidence = Math.max(...qValues) - Math.min(...qValues);
      confidence *= rugScore.total / 100;
      confidence *= pumpMetrics.confidence;
    }

    // NEW: Get dynamic confidence threshold and momentum override
    let requiredConfidence = config.watchlist?.minConfidence || 0.55;
    let hasMomentumOverride = false;

    // In exploration mode, lower the threshold to allow trading while model learns
    // This matches the velocity tracker's minBuyPressure of 0.50
    if (isExplorationMode) {
      requiredConfidence = 0.50;
      logger.debug({ requiredConfidence }, 'Exploration mode: lowered confidence threshold');
    } else if (mint) {
      // Dynamic confidence threshold based on token age
      requiredConfidence = tokenWatchlist.getDynamicConfidenceThreshold(mint);

      // Check momentum override
      const momentumSignal = tokenWatchlist.getMomentumSignal(mint);
      if (momentumSignal?.hasMomentum) {
        hasMomentumOverride = true;
        const momentumFloor = config.momentumOverride?.confidenceFloor || 0.45;
        // If momentum is strong, use lower confidence floor
        requiredConfidence = Math.min(requiredConfidence, momentumFloor);
        logger.info({
          mint: mint.substring(0, 15),
          ...momentumSignal,
          adjustedThreshold: requiredConfidence.toFixed(2),
        }, 'MOMENTUM OVERRIDE - Lowering confidence threshold');
      }
    }

    // Handle action override based on confidence
    let finalAction = action;

    // In exploration mode with good confidence, FORCE BUY (don't rely on random action)
    if (isExplorationMode && confidence >= requiredConfidence) {
      finalAction = Action.BUY;
      logger.info({
        mint: mint?.substring(0, 15),
        confidence: confidence.toFixed(2),
        requiredConfidence: requiredConfidence.toFixed(2),
        originalAction: Action[action],
      }, 'EXPLORATION MODE: Forcing BUY (confidence above threshold)');
    } else if (action === Action.BUY && confidence < requiredConfidence) {
      // Normal mode: Block BUY if confidence is below threshold
      finalAction = Action.HOLD;
      logger.info({
        mint: mint?.substring(0, 15),
        confidence: confidence.toFixed(2),
        requiredConfidence: requiredConfidence.toFixed(2),
        hasMomentum: hasMomentumOverride,
      }, 'BUY blocked - confidence below dynamic threshold');
    }

    // NEW: Pass confidence to position sizer for dynamic sizing
    const positionSize = positionSizer.calculateSize(
      availableCapital,
      undefined,
      undefined,
      regime,
      confidence  // NEW: Use confidence as size multiplier
    );

    return {
      action: finalAction,
      confidence,
      regime,
      positionSize,
      qValues,
      features: stateArray,
      timestamp: new Date(),
    };
  }

  private async executeBuy(
    mint: string,
    symbol: string,
    sizeSol: number,
    currentPrice: number,
    features: StateVector,
    pumpMetrics: PumpMetrics,
    poolType: 'active' | 'high_risk',
    creator: string
  ): Promise<void> {
    logger.info({
      mint,
      symbol,
      sizeSol,
      currentPrice,
      poolType,
    }, 'Executing buy');

    const result = await txManager.executeBuy(mint, sizeSol, {
      slippageBps: config.defaultSlippageBps,  // 15% slippage
      maxRetries: 3,
    });

    if (!result.success) {
      logger.error({ mint, error: result.error }, 'Buy failed');
      priceFeed.removeFromWatchList(mint);
      return;
    }

    // CRITICAL: Verify actual token balance before creating position
    // This prevents phantom positions when buy tx fails silently
    // In paper trading mode, skip balance check and use simulated amount
    let amountTokens: number;
    let actualPrice: number;

    if (config.paperTrading) {
      // Paper trading: use simulated output amount
      amountTokens = result.outputAmount || (sizeSol * 1_000_000); // Fallback estimate
      actualPrice = sizeSol / amountTokens;
      logger.info({
        mint,
        mode: 'PAPER',
        simulatedTokens: amountTokens,
        calculatedPrice: actualPrice
      }, 'Paper trade: using simulated token amount');
    } else {
      // Real trading: verify actual on-chain balance
      await this.sleep(2000); // Wait for tx to settle
      const actualBalance = await txManager.getTokenBalance(mint);

      if (actualBalance <= 0) {
        logger.error({
          mint,
          signature: result.signature,
          expectedTokens: result.outputAmount || 'unknown',
          actualBalance
        }, 'Buy tx succeeded but no tokens received - NOT creating position');
        priceFeed.removeFromWatchList(mint);
        return;
      }

      amountTokens = actualBalance;
      actualPrice = sizeSol / amountTokens;
    }

    logger.info({
      mint,
      amountTokens,
      calculatedPrice: actualPrice,
      mode: config.paperTrading ? 'PAPER' : 'LIVE'
    }, 'Position ready to open');

    // Open position
    const position = await positionManager.openPosition({
      mint,
      symbol,
      entryPrice: actualPrice,
      amount: amountTokens,
      amountSol: sizeSol,
      poolType,
    });

    // Start watching for rug signals
    const bondingCurveData = this.bondingCurveCache.get(mint);
    rugMonitor.watchPosition({
      mint,
      creator,
      entryPrice: actualPrice,
      entryMarketCapSol: bondingCurveData?.marketCapSol || 0,
    });

    // Log trade entry
    await tradeLogger.logEntry({
      positionId: position.id,
      mint,
      symbol,
      entryPrice: actualPrice,
      amount: amountTokens,
      amountSol: sizeSol,
      features,
      regime: regimeDetector.getCurrentRegime().regime,
      pumpPhase: pumpMetrics.phase,
    });

    logger.info({
      positionId: position.id,
      mint,
      symbol,
      amountSol: sizeSol,
      amountTokens,
      entryPrice: actualPrice,
    }, 'Position opened');
  }

  private startStatusLogger(): void {
    setInterval(async () => {
      if (!this.isRunning) return;

      const allocation = capitalAllocator.getAllocation();
      const positions = positionManager.getOpenPositions();
      const drawdown = drawdownGuard.getState();

      logger.info({
        equity: allocation.totalSol.toFixed(4),
        positions: positions.length,
        drawdown: (drawdown.currentDrawdown * 100).toFixed(2),
        dailyPnl: drawdown.dailyPnl.toFixed(4),
        regime: regimeDetector.getRegimeName(),
        paused: drawdown.isPaused,
      }, 'Status');

      // Log rejection stats
      const stats = this.rejectionStats;
      if (stats.total > 0) {
        logger.info({
          quickSafety: stats.quickSafety,
          liquidity: stats.liquidity,
          rugScore: stats.rugScore,
          entryEval: stats.entryEval,
          aiDecision: stats.aiDecision,
          riskCheck: stats.riskCheck,
          total: stats.total,
          passed: stats.passed,
          passRate: ((stats.passed / (stats.total + stats.passed)) * 100).toFixed(1) + '%',
        }, 'Rejection Stats');
      }

      // Log watchlist stats
      const watchlistStats = tokenWatchlist.getStats();
      if (watchlistStats.total > 0) {
        logger.info({
          watching: watchlistStats.total,
          ready: watchlistStats.ready,
          devSold: watchlistStats.devSold,
        }, 'Watchlist Stats');
      }

    }, 60000); // Log every minute
  }

  async stop(): Promise<void> {
    logger.info('Stopping bot...');
    this.isRunning = false;

    // Stop all components
    modelTrainer.stopPeriodicTraining();
    await heliusWs.disconnect();
    priceFeed.stop();
    whaleTracker.stop();
    regimeDetector.stop();
    positionManager.stop();
    drawdownGuard.stop();

    // Stop new services
    walletSync.stop();
    equityTracker.stop();

    // Stop C100 services
    c100Tracker.stop();
    rewardClaimer.stop();

    // Stop API server
    await apiServer.stop();

    await repository.close();

    logger.info('Bot stopped');
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    allocation: string;
    drawdown: string;
    training: string;
    performance: string;
  }> {
    const metrics = await performanceAnalytics.calculateMetrics();

    return {
      isRunning: this.isRunning,
      allocation: capitalAllocator.getStatus(),
      drawdown: drawdownGuard.getStatus(),
      training: modelTrainer.getTrainingStatus(),
      performance: performanceAnalytics.formatMetrics(metrics),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main entry point
const bot = new TradingBot();

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await bot.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await bot.stop();
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection');
});

process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught exception');
  process.exit(1);
});

// Start the bot
bot.start().catch((error) => {
  logger.error({ error }, 'Failed to start bot');
  process.exit(1);
});

export { TradingBot, bot };
