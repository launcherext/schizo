import { Express, Request, Response } from 'express';
import { createChildLogger } from '../utils/logger';
import { positionManager, capitalAllocator, drawdownGuard } from '../risk';
import { tradeLogger, performanceAnalytics } from '../learning';
import { tokenWatchlist, pumpDetector } from '../signals';
import { ddqnAgent, regimeDetector, positionSizer } from '../ai';
import { config } from '../config/settings';
import { walletSync, equityTracker, positionReconciler, c100Tracker, rewardClaimer, c100Buyback } from '../services';
import { txManager } from '../execution/tx-manager';
import { repository } from '../db/repository';

const logger = createChildLogger('api-routes');

// Store AI decision history for debugging
interface AIDecisionLog {
  mint: string;
  symbol: string;
  timestamp: Date;
  action: string;
  confidence: number;
  requiredConfidence: number;
  hasMomentum: boolean;
  qValues: number[];
  features: Record<string, number>;
  outcome?: 'passed' | 'rejected';
  rejectionReason?: string;
}

const aiDecisionHistory: AIDecisionLog[] = [];
const MAX_DECISION_HISTORY = 100;

// Store rejection stats
const rejectionStats = {
  quickSafety: 0,
  liquidity: 0,
  rugScore: 0,
  entryEval: 0,
  aiDecision: 0,
  riskCheck: 0,
  confidenceBelow: 0,  // NEW: Track confidence-based rejections
  total: 0,
  passed: 0,
};

// Export function to log AI decisions from index.ts
export function logAIDecision(decision: AIDecisionLog): void {
  aiDecisionHistory.unshift(decision);
  if (aiDecisionHistory.length > MAX_DECISION_HISTORY) {
    aiDecisionHistory.pop();
  }
}

// Export function to update rejection stats
export function updateRejectionStats(type: keyof typeof rejectionStats): void {
  if (type in rejectionStats) {
    rejectionStats[type]++;
    if (type !== 'passed') {
      rejectionStats.total++;
    }
  }
}

export function setupRoutes(app: Express): void {
  // Health check
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Get bot status
  app.get('/api/status', async (req: Request, res: Response) => {
    try {
      const drawdown = drawdownGuard.getState();
      const allocation = capitalAllocator.getAllocation();
      const positions = positionManager.getOpenPositions();

      res.json({
        isRunning: true,
        isPaused: drawdown.isPaused,
        pauseReason: drawdown.pauseReason,
        pauseUntil: drawdown.pauseUntil,
        positionCount: positions.length,
        totalExposure: positionManager.getTotalExposure(),
        totalCapital: allocation.totalSol,
        currentEquity: drawdown.currentEquity,
        paperTrading: config.paperTrading,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get status');
      res.status(500).json({ error: 'Failed to get status' });
    }
  });

  // Get stats for dashboard
  app.get('/api/stats', async (req: Request, res: Response) => {
    try {
      const metrics = await performanceAnalytics.calculateMetrics();
      const allocation = capitalAllocator.getAllocation();
      const drawdown = drawdownGuard.getState();
      const positions = positionManager.getOpenPositions();

      // Calculate total unrealized P&L
      const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

      // Calculate multiplier: (realized + unrealized + initial) / initial
      const realizedPnl = metrics.totalPnl;
      const currentEquity = config.initialCapitalSol + realizedPnl + totalUnrealizedPnl;
      const multiplier = currentEquity / config.initialCapitalSol;

      // Calculate win streak
      const recentTrades = await tradeLogger.getRecentTrades(20);
      let winStreak = 0;
      for (const trade of recentTrades) {
        if (trade.pnlSol !== undefined) {
          if (trade.pnlSol > 0) {
            winStreak++;
          } else {
            break;
          }
        }
      }

      res.json({
        multiplier: multiplier.toFixed(2),
        winRate: (metrics.winRate * 100).toFixed(1),
        totalTrades: metrics.totalTrades,
        winningTrades: metrics.winningTrades,
        losingTrades: metrics.losingTrades,
        totalPnl: metrics.totalPnl.toFixed(4),
        totalUnrealizedPnl: totalUnrealizedPnl.toFixed(4),
        currentEquity: currentEquity.toFixed(4),
        initialCapital: config.initialCapitalSol,
        progressPercent: Math.min(100, (currentEquity / 100) * 100),
        profitFactor: metrics.profitFactor.toFixed(2),
        sharpeRatio: metrics.sharpeRatio.toFixed(2),
        maxDrawdown: (metrics.maxDrawdown * 100).toFixed(1),
        avgWin: metrics.avgWin.toFixed(4),
        avgLoss: metrics.avgLoss.toFixed(4),
        largestWin: metrics.largestWin.toFixed(4),
        largestLoss: metrics.largestLoss.toFixed(4),
        winStreak,
        drawdown: {
          current: (drawdown.currentDrawdown * 100).toFixed(2),
          max: (drawdown.maxDrawdown * 100).toFixed(2),
          dailyPnl: drawdown.dailyPnl.toFixed(4),
        },
        allocation: {
          total: allocation.totalSol.toFixed(4),
          inPositions: allocation.inPositions.toFixed(4),
          availableActive: allocation.availableActive.toFixed(4),
          availableHighRisk: allocation.availableHighRisk.toFixed(4),
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get stats');
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  // Get recent trades
  app.get('/api/trades', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const trades = await tradeLogger.getRecentTrades(limit);

      const formattedTrades = trades.map((trade) => ({
        id: trade.id,
        mint: trade.mint,
        symbol: trade.symbol,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        amount: trade.amount,
        amountSol: trade.amountSol,
        entryTime: trade.entryTime,
        exitTime: trade.exitTime,
        pnlSol: trade.pnlSol?.toFixed(6),
        pnlPercent: trade.pnlPercent?.toFixed(2),
        duration: trade.duration,
        exitReason: trade.exitReason,
        isOpen: !trade.exitTime,
      }));

      res.json(formattedTrades);
    } catch (error) {
      logger.error({ error }, 'Failed to get trades');
      res.status(500).json({ error: 'Failed to get trades' });
    }
  });

  // Get open positions
  app.get('/api/positions', async (req: Request, res: Response) => {
    try {
      const positions = positionManager.getOpenPositions();

      const formattedPositions = positions.map((p) => ({
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        amount: p.amount,
        amountSol: p.amountSol,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        highestPrice: p.highestPrice,
        unrealizedPnl: p.unrealizedPnl.toFixed(6),
        unrealizedPnlPercent: p.unrealizedPnlPercent.toFixed(2),
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        tpSold: p.tpSold,
        trailingStop: p.trailingStop,
        status: p.status,
        poolType: p.poolType,
        entryTime: p.entryTime,
        lastUpdate: p.lastUpdate,
        holdTime: Date.now() - p.entryTime.getTime(),
      }));

      const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
      const totalExposure = positionManager.getTotalExposure();

      res.json({
        positions: formattedPositions,
        totalUnrealizedPnl: totalUnrealizedPnl.toFixed(6),
        totalExposure: totalExposure.toFixed(4),
        positionCount: positions.length,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get positions');
      res.status(500).json({ error: 'Failed to get positions' });
    }
  });

  // Get detailed performance metrics
  app.get('/api/performance', async (req: Request, res: Response) => {
    try {
      const timeframePerformance = await performanceAnalytics.getTimeframePerformance();

      res.json({
        hourly: formatMetrics(timeframePerformance.hourly),
        daily: formatMetrics(timeframePerformance.daily),
        weekly: formatMetrics(timeframePerformance.weekly),
        monthly: formatMetrics(timeframePerformance.monthly),
        allTime: formatMetrics(timeframePerformance.allTime),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get performance');
      res.status(500).json({ error: 'Failed to get performance' });
    }
  });

  // Get active trades (currently being monitored but not yet closed)
  app.get('/api/active-trades', (req: Request, res: Response) => {
    try {
      const activeTrades = tradeLogger.getActiveTrades();
      res.json(activeTrades);
    } catch (error) {
      logger.error({ error }, 'Failed to get active trades');
      res.status(500).json({ error: 'Failed to get active trades' });
    }
  });

  // NEW: Get AI decision history for debugging
  app.get('/api/debug/ai-decisions', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const decisions = aiDecisionHistory.slice(0, limit);

      res.json({
        decisions,
        totalDecisions: aiDecisionHistory.length,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get AI decisions');
      res.status(500).json({ error: 'Failed to get AI decisions' });
    }
  });

  // NEW: Get rejection statistics
  app.get('/api/debug/rejection-stats', (req: Request, res: Response) => {
    try {
      const passRate = rejectionStats.passed > 0 || rejectionStats.total > 0
        ? (rejectionStats.passed / (rejectionStats.total + rejectionStats.passed)) * 100
        : 0;

      res.json({
        ...rejectionStats,
        passRate: passRate.toFixed(1) + '%',
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get rejection stats');
      res.status(500).json({ error: 'Failed to get rejection stats' });
    }
  });

  // NEW: Get watchlist status with detailed features
  app.get('/api/debug/watchlist', (req: Request, res: Response) => {
    try {
      const tokens = tokenWatchlist.getAllTokens();
      const watchlistData = tokens.map(mint => {
        const token = tokenWatchlist.getToken(mint);
        const features = tokenWatchlist.extractFeatures(mint);
        const momentumSignal = tokenWatchlist.getMomentumSignal(mint);
        const dynamicThreshold = tokenWatchlist.getDynamicConfidenceThreshold(mint);
        const filterResult = tokenWatchlist.passesHardFilters(mint);

        return {
          mint: mint.substring(0, 15) + '...',
          fullMint: mint,
          ageSeconds: token ? (Date.now() - token.firstSeen) / 1000 : 0,
          dataPoints: token?.priceHistory.length || 0,
          tradeCount: token?.trades.length || 0,
          devSoldPercent: token?.devSoldPercent || 0,
          devSold: token?.devSold || false,
          passesFilters: filterResult.passes,
          filterReason: filterResult.reason,
          dynamicThreshold: dynamicThreshold.toFixed(2),
          features: features ? {
            priceChange: (features.priceChange * 100).toFixed(2) + '%',
            buyPressure: (features.buyPressure * 100).toFixed(0) + '%',
            volumeAcceleration: features.volumeAcceleration.toFixed(2) + 'x',
            uniqueTraderGrowth: features.uniqueTraderGrowth,
            hasMomentum: features.hasMomentum,
            drawdown: (features.drawdown * 100).toFixed(1) + '%',
          } : null,
          momentum: momentumSignal,
        };
      });

      const stats = tokenWatchlist.getStats();

      res.json({
        stats,
        tokens: watchlistData,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get watchlist');
      res.status(500).json({ error: 'Failed to get watchlist' });
    }
  });

  // NEW: Get DDQN model stats
  app.get('/api/debug/model-stats', (req: Request, res: Response) => {
    try {
      const regime = regimeDetector.getCurrentRegime();
      const winRate = positionSizer.getWinRate();
      const epsilon = ddqnAgent.getEpsilon ? ddqnAgent.getEpsilon() : 'N/A';

      res.json({
        regime: regime.regime,
        regimeName: regimeDetector.getRegimeName(),
        regimeConfidence: regime.confidence,
        winRate: (winRate * 100).toFixed(1) + '%',
        epsilon,
        configThresholds: {
          minConfidence: config.watchlist?.minConfidence,
          maxConfidence: config.watchlist?.maxConfidence,
          minAgeSeconds: config.watchlist?.minAgeSeconds,
          maxDrawdown: config.watchlist?.maxDrawdown,
        },
        momentumConfig: config.momentumOverride,
        devSoldConfig: config.devSoldConfig,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get model stats');
      res.status(500).json({ error: 'Failed to get model stats' });
    }
  });

  // NEW: Get confidence analysis for winning vs losing trades
  app.get('/api/debug/confidence-analysis', async (req: Request, res: Response) => {
    try {
      const trades = await tradeLogger.getRecentTrades(100);
      const completedTrades = trades.filter(t => t.exitTime);

      const winners = completedTrades.filter(t => (t.pnlSol || 0) > 0);
      const losers = completedTrades.filter(t => (t.pnlSol || 0) <= 0);

      // Calculate average confidence for winners vs losers
      // Note: We'd need to store confidence with trades to do this properly
      // For now, return trade counts

      res.json({
        totalTrades: completedTrades.length,
        winners: winners.length,
        losers: losers.length,
        winRate: completedTrades.length > 0
          ? ((winners.length / completedTrades.length) * 100).toFixed(1) + '%'
          : 'N/A',
        avgWinPnl: winners.length > 0
          ? (winners.reduce((sum, t) => sum + (t.pnlPercent || 0), 0) / winners.length).toFixed(2) + '%'
          : 'N/A',
        avgLossPnl: losers.length > 0
          ? (losers.reduce((sum, t) => sum + (t.pnlPercent || 0), 0) / losers.length).toFixed(2) + '%'
          : 'N/A',
        recentDecisions: aiDecisionHistory.slice(0, 10).map(d => ({
          mint: d.mint.substring(0, 12),
          action: d.action,
          confidence: d.confidence.toFixed(2),
          requiredConfidence: d.requiredConfidence.toFixed(2),
          hasMomentum: d.hasMomentum,
          outcome: d.outcome,
        })),
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get confidence analysis');
      res.status(500).json({ error: 'Failed to get confidence analysis' });
    }
  });

  // NEW: Get actual wallet balance and equity
  app.get('/api/wallet', async (req: Request, res: Response) => {
    try {
      const walletState = walletSync.getState();
      const latestEquity = equityTracker.getLatestSnapshot();
      const equityChange = equityTracker.getEquityChange(24);

      res.json({
        solBalance: walletState?.solBalance || 0,
        lastSync: walletState?.lastSync || null,
        isHealthy: walletSync.isHealthy(),
        equity: latestEquity ? {
          total: latestEquity.totalEquitySol,
          walletBalance: latestEquity.walletBalanceSol,
          positionsValue: latestEquity.positionsValueSol,
          unrealizedPnl: latestEquity.unrealizedPnlSol,
          positionCount: latestEquity.positionCount,
          timestamp: latestEquity.timestamp,
        } : null,
        change24h: equityChange,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get wallet info');
      res.status(500).json({ error: 'Failed to get wallet info' });
    }
  });

  // NEW: Get equity history for chart
  app.get('/api/equity-history', async (req: Request, res: Response) => {
    try {
      const hours = parseInt(req.query.hours as string) || 24;
      const history = await equityTracker.getEquityHistory(hours);

      res.json({
        history: history.map(s => ({
          timestamp: s.timestamp,
          totalEquity: s.totalEquitySol,
          walletBalance: s.walletBalanceSol,
          positionsValue: s.positionsValueSol,
          unrealizedPnl: s.unrealizedPnlSol,
          positionCount: s.positionCount,
        })),
        count: history.length,
        hours,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get equity history');
      res.status(500).json({ error: 'Failed to get equity history' });
    }
  });

  // NEW: Trigger manual reconciliation
  app.post('/api/reconcile', async (req: Request, res: Response) => {
    try {
      const autoClose = req.body?.autoClose !== false; // Default true
      const result = await positionReconciler.reconcile(autoClose);

      res.json({
        success: true,
        phantomsFound: result.phantomsFound.length,
        phantomsClosed: result.phantomsClosed,
        orphansFound: result.orphansFound.length,
        details: {
          phantoms: result.phantomsFound.map(p => ({
            positionId: p.positionId,
            mint: p.mint.substring(0, 15) + '...',
            symbol: p.symbol,
            expectedAmount: p.expectedAmount,
            actualAmount: p.actualAmount,
            amountSol: p.amountSol,
          })),
          orphans: result.orphansFound,
        },
        reconciliationTime: result.reconciliationTime,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to reconcile positions');
      res.status(500).json({ error: 'Failed to reconcile positions' });
    }
  });

  // NEW: Get positions with real-time unrealized PnL
  app.get('/api/positions/realtime', async (req: Request, res: Response) => {
    try {
      const positions = positionManager.getOpenPositions();

      const formattedPositions = positions.map((p) => {
        const currentValue = p.amount * p.currentPrice;
        const entryValue = p.amountSol;
        const unrealizedPnl = currentValue - entryValue;
        const totalPnl = (p.realizedPnl || 0) + unrealizedPnl;

        return {
          id: p.id,
          mint: p.mint,
          symbol: p.symbol,
          amount: p.amount,
          amountSol: p.amountSol,
          entryPrice: p.entryPrice,
          currentPrice: p.currentPrice,
          highestPrice: p.highestPrice,
          currentValue,
          unrealizedPnl: unrealizedPnl.toFixed(6),
          unrealizedPnlPercent: ((unrealizedPnl / entryValue) * 100).toFixed(2),
          realizedPnl: (p.realizedPnl || 0).toFixed(6),
          totalPnl: totalPnl.toFixed(6),
          totalPnlPercent: ((totalPnl / entryValue) * 100).toFixed(2),
          stopLoss: p.stopLoss,
          trailingStop: p.trailingStop,
          initialRecovered: p.initialRecovered,
          scaledExitsTaken: p.scaledExitsTaken,
          status: p.status,
          poolType: p.poolType,
          entryTime: p.entryTime,
          lastUpdate: p.lastUpdate,
          holdTimeMs: Date.now() - p.entryTime.getTime(),
        };
      });

      const totalUnrealizedPnl = positions.reduce((sum, p) => {
        const currentValue = p.amount * p.currentPrice;
        return sum + (currentValue - p.amountSol);
      }, 0);

      const totalRealizedPnl = positions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
      const totalExposure = positionManager.getTotalExposure();

      res.json({
        positions: formattedPositions,
        summary: {
          totalUnrealizedPnl: totalUnrealizedPnl.toFixed(6),
          totalRealizedPnl: totalRealizedPnl.toFixed(6),
          totalPnl: (totalUnrealizedPnl + totalRealizedPnl).toFixed(6),
          totalExposure: totalExposure.toFixed(4),
          positionCount: positions.length,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get realtime positions');
      res.status(500).json({ error: 'Failed to get realtime positions' });
    }
  });

  // Manual test buy endpoint
  app.post('/api/test/buy', async (req: Request, res: Response) => {
    try {
      const { mint, amountSol = 0.01 } = req.body;

      if (!mint) {
        return res.status(400).json({ error: 'mint is required' });
      }

      logger.info({ mint, amountSol }, 'Manual test buy requested');

      // Execute the buy
      const result = await txManager.executeBuy(mint, amountSol, {
        slippageBps: config.defaultSlippageBps,
        maxRetries: 3,
      });

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: result.error,
          mint,
          amountSol,
        });
      }

      // Wait for tx to settle and check balance
      await new Promise(resolve => setTimeout(resolve, 2000));
      const actualBalance = await txManager.getTokenBalance(mint);

      // Create position if we got tokens
      if (actualBalance > 0) {
        const entryPrice = amountSol / actualBalance;
        const position = await positionManager.openPosition({
          mint,
          symbol: mint.slice(0, 8),
          entryPrice,
          amount: actualBalance,
          amountSol,
          poolType: 'active',
        });

        await tradeLogger.logEntry({
          positionId: position.id,
          mint,
          symbol: mint.slice(0, 8),
          entryPrice,
          amount: actualBalance,
          amountSol,
          features: {} as any,
          regime: 0,
          pumpPhase: 'cold',
        });

        return res.json({
          success: true,
          positionId: position.id,
          mint,
          amountSol,
          tokensReceived: actualBalance,
          entryPrice,
          signature: result.signature,
        });
      } else {
        return res.json({
          success: false,
          error: 'Buy tx succeeded but no tokens received',
          mint,
          amountSol,
          signature: result.signature,
          actualBalance,
        });
      }
    } catch (error: any) {
      logger.error({ error }, 'Manual test buy failed');
      res.status(500).json({ error: error.message });
    }
  });

  // =====================
  // C100 Routes
  // =====================

  // Get C100 status - token info + claim/buyback totals
  app.get('/api/c100/status', async (req: Request, res: Response) => {
    try {
      const tokenData = c100Tracker.getTokenData();
      const claimStats = rewardClaimer.getStats();
      const buybackStats = c100Buyback.getStats();

      res.json({
        enabled: c100Tracker.isEnabled(),
        token: tokenData ? {
          mint: tokenData.mint,
          name: tokenData.name,
          symbol: tokenData.symbol,
          priceSol: tokenData.priceSol,
          priceUsd: tokenData.priceUsd,
          marketCapUsd: tokenData.marketCapUsd,
          volume24h: tokenData.volume24h,
          priceChange24h: tokenData.priceChange24h,
          lastUpdated: tokenData.lastUpdated,
        } : null,
        claims: {
          totalClaimedSol: claimStats.totalClaimedSol,
          claimCount: claimStats.claimCount,
          lastClaimTime: claimStats.lastClaimTime,
          sources: claimStats.sources,
        },
        buybacks: {
          totalBuybackSol: buybackStats.totalBuybackSol,
          totalTokensBought: buybackStats.totalTokensBought,
          buybackCount: buybackStats.buybackCount,
          lastBuybackTime: buybackStats.lastBuybackTime,
          avgPriceSol: buybackStats.avgPriceSol,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get C100 status');
      res.status(500).json({ error: 'Failed to get C100 status' });
    }
  });

  // Get recent claim transactions
  app.get('/api/c100/claims', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const claims = await repository.getRecentC100Claims(limit);

      res.json({
        claims: claims.map(c => ({
          id: c.id,
          source: c.source,
          amountSol: parseFloat(c.amount_sol.toString()),
          signature: c.signature,
          status: c.status,
          timestamp: c.timestamp,
        })),
        count: claims.length,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get C100 claims');
      res.status(500).json({ error: 'Failed to get C100 claims' });
    }
  });

  // Get recent buyback transactions
  app.get('/api/c100/buybacks', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const buybacks = await repository.getRecentC100Buybacks(limit);

      res.json({
        buybacks: buybacks.map(b => ({
          id: b.id,
          amountSol: parseFloat(b.amount_sol.toString()),
          amountTokens: b.amount_tokens ? parseFloat(b.amount_tokens.toString()) : null,
          priceSol: b.price_sol ? parseFloat(b.price_sol.toString()) : null,
          source: b.source,
          signature: b.signature,
          status: b.status,
          timestamp: b.timestamp,
        })),
        count: buybacks.length,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get C100 buybacks');
      res.status(500).json({ error: 'Failed to get C100 buybacks' });
    }
  });

  // Manual claim trigger (for testing)
  app.post('/api/c100/claim', async (req: Request, res: Response) => {
    try {
      logger.info('Manual claim triggered');
      const results = await rewardClaimer.claimAllRewards();

      const totalClaimed = results.reduce((sum, r) => sum + (r.success ? r.amountSol : 0), 0);

      res.json({
        success: true,
        totalClaimed,
        results,
      });
    } catch (error: any) {
      logger.error({ error }, 'Manual claim failed');
      res.status(500).json({ error: error.message });
    }
  });

  // Manual buyback trigger (for testing)
  app.post('/api/c100/buyback', async (req: Request, res: Response) => {
    try {
      const { amountSol = 0.01 } = req.body;

      logger.info({ amountSol }, 'Manual buyback triggered');
      const result = await c100Buyback.executeBuyback(amountSol, 'manual');

      res.json(result);
    } catch (error: any) {
      logger.error({ error }, 'Manual buyback failed');
      res.status(500).json({ error: error.message });
    }
  });

  logger.info('API routes configured');
}

function formatMetrics(metrics: any): any {
  return {
    totalTrades: metrics.totalTrades,
    winningTrades: metrics.winningTrades,
    losingTrades: metrics.losingTrades,
    winRate: (metrics.winRate * 100).toFixed(1),
    totalPnl: metrics.totalPnl.toFixed(4),
    profitFactor: metrics.profitFactor.toFixed(2),
    sharpeRatio: metrics.sharpeRatio.toFixed(2),
    maxDrawdown: (metrics.maxDrawdown * 100).toFixed(1),
    avgWin: metrics.avgWin.toFixed(4),
    avgLoss: metrics.avgLoss.toFixed(4),
  };
}
