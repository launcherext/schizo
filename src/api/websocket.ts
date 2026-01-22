import { Server as SocketServer, Socket } from 'socket.io';
import { createChildLogger } from '../utils/logger';
import { positionManager, capitalAllocator, drawdownGuard } from '../risk';
import { tradeLogger, performanceAnalytics } from '../learning';
import { heliusWs } from '../data';
import { tokenWatchlist } from '../signals';
import { config } from '../config/settings';
import { Position } from '../risk/types';
import { walletSync, equityTracker, positionReconciler, c100Tracker, rewardClaimer, c100Buyback } from '../services';

const logger = createChildLogger('websocket');

// Track scanner state
let tokensScanned = 0;
let currentScanningToken: { mint: string; name?: string; symbol?: string; imageUrl?: string | null } | null = null;

// Token metadata cache for quick lookups
const tokenMetadataCache = new Map<string, { name?: string; symbol?: string; imageUrl?: string | null }>();

export function setupWebSocket(io: SocketServer): void {
  // Handle client connections
  io.on('connection', (socket: Socket) => {
    logger.info({ socketId: socket.id }, 'Client connected');

    // Send initial state on connect
    sendInitialState(socket);

    socket.on('disconnect', () => {
      logger.info({ socketId: socket.id }, 'Client disconnected');
    });

    // Allow clients to request refresh
    socket.on('refresh', async () => {
      await sendInitialState(socket);
    });
  });

  // Bridge existing EventEmitters to Socket.io
  setupEventBridges(io);

  // Start periodic broadcasts
  startPeriodicBroadcasts(io);

  logger.info('WebSocket handlers configured');
}

async function sendInitialState(socket: Socket): Promise<void> {
  try {
    // Send current stats
    const metrics = await performanceAnalytics.calculateMetrics();
    const allocation = capitalAllocator.getAllocation();
    const drawdown = drawdownGuard.getState();
    const positions = positionManager.getOpenPositions();
    const recentTrades = await tradeLogger.getRecentTrades(20);

    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const currentEquity = config.initialCapitalSol + metrics.totalPnl + totalUnrealizedPnl;
    const multiplier = currentEquity / config.initialCapitalSol;

    socket.emit('stats:initial', {
      multiplier: multiplier.toFixed(2),
      winRate: (metrics.winRate * 100).toFixed(1),
      totalTrades: metrics.totalTrades,
      tokensScanned,
      currentEquity: currentEquity.toFixed(4),
      initialCapital: config.initialCapitalSol,
      totalPnl: metrics.totalPnl.toFixed(4),
      totalUnrealizedPnl: totalUnrealizedPnl.toFixed(4),
      isPaused: drawdown.isPaused,
    });

    // Send current positions
    socket.emit('positions:initial', formatPositions(positions));

    // Send recent trades
    socket.emit('trades:initial', recentTrades.slice(0, 10).map(formatTrade));

    // Send scanner state
    socket.emit('scanner:initial', {
      tokensScanned,
      currentToken: currentScanningToken,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to send initial state');
  }
}

function setupEventBridges(io: SocketServer): void {
  // New token detected (scanner event)
  heliusWs.on('newToken', (event: { mint: string; signature: string; name?: string; symbol?: string }) => {
    tokensScanned++;
    currentScanningToken = { mint: event.mint, name: event.name, symbol: event.symbol };

    // Cache metadata from event
    if (event.name || event.symbol) {
      tokenMetadataCache.set(event.mint, { name: event.name, symbol: event.symbol });
    }

    io.emit('scanner:token', {
      mint: event.mint,
      signature: event.signature,
      name: event.name,
      symbol: event.symbol,
      tokensScanned,
    });

    // Clear current token after a delay
    setTimeout(() => {
      if (currentScanningToken?.mint === event.mint) {
        currentScanningToken = null;
        io.emit('scanner:idle', { tokensScanned });
      }
    }, 10000);
  });

  // Token metadata updated (image fetched)
  heliusWs.on('tokenMetadataUpdated', (data: { mint: string; name: string; symbol: string; imageUrl: string | null }) => {
    // Update cache
    tokenMetadataCache.set(data.mint, { name: data.name, symbol: data.symbol, imageUrl: data.imageUrl });

    // Update current scanning token if it matches
    if (currentScanningToken?.mint === data.mint) {
      currentScanningToken = { ...currentScanningToken, ...data };
    }

    // Broadcast metadata update
    io.emit('token:metadataUpdate', {
      mint: data.mint,
      name: data.name,
      symbol: data.symbol,
      imageUrl: data.imageUrl,
    });
  });

  // Position opened
  positionManager.on('positionOpened', (position: Position) => {
    io.emit('trade:open', {
      id: position.id,
      mint: position.mint,
      symbol: position.symbol,
      amountSol: position.amountSol.toFixed(4),
      entryPrice: position.entryPrice,
      poolType: position.poolType,
      timestamp: new Date().toISOString(),
    });

    io.emit('toast', {
      type: 'info',
      title: 'Position Opened',
      message: `Bought ${position.symbol || position.mint.substring(0, 8)} for ${position.amountSol.toFixed(4)} SOL`,
    });
  });

  // Position closed
  positionManager.on('positionClosed', (data: {
    position: Position;
    reason: string;
    exitPrice: number;
    pnlSol: number;
    pnlPercent: number;
  }) => {
    const { position, reason, pnlSol, pnlPercent } = data;

    io.emit('trade:close', {
      id: position.id,
      mint: position.mint,
      symbol: position.symbol,
      pnlSol: pnlSol.toFixed(6),
      pnlPercent: pnlPercent.toFixed(2),
      reason,
      timestamp: new Date().toISOString(),
    });

    // Show toast for profitable trades
    if (pnlSol > 0) {
      io.emit('toast', {
        type: 'success',
        title: `+${pnlSol.toFixed(4)} SOL`,
        message: `${position.symbol || position.mint.substring(0, 8)} closed at ${pnlPercent.toFixed(1)}%`,
      });
    } else {
      io.emit('toast', {
        type: 'error',
        title: `${pnlSol.toFixed(4)} SOL`,
        message: `${position.symbol || position.mint.substring(0, 8)} stopped out at ${pnlPercent.toFixed(1)}%`,
      });
    }
  });

  // Partial close (take profit hit)
  positionManager.on('partialClose', (data: {
    position: Position;
    tpLevel: number;
    sellAmount: number;
  }) => {
    io.emit('trade:partial', {
      id: data.position.id,
      mint: data.position.mint,
      symbol: data.position.symbol,
      tpLevel: data.tpLevel + 1,
      sellAmount: data.sellAmount,
      timestamp: new Date().toISOString(),
    });

    io.emit('toast', {
      type: 'success',
      title: `TP${data.tpLevel + 1} Hit`,
      message: `${data.position.symbol || data.position.mint.substring(0, 8)} partial sell`,
    });
  });

  // Trading paused
  drawdownGuard.on('tradingPaused', (data: { reason: string; until?: Date }) => {
    io.emit('status:paused', {
      reason: data.reason,
      until: data.until?.toISOString(),
    });

    io.emit('toast', {
      type: 'warning',
      title: 'Trading Paused',
      message: data.reason,
    });
  });

  // Trading resumed
  drawdownGuard.on('tradingResumed', (data: { reason: string }) => {
    io.emit('status:resumed', {
      reason: data.reason,
    });

    io.emit('toast', {
      type: 'info',
      title: 'Trading Resumed',
      message: data.reason,
    });
  });

  // Trade logged
  tradeLogger.on('exitLogged', (trade: any) => {
    io.emit('trade:logged', formatTrade(trade));
  });

  // Token Watchlist events
  tokenWatchlist.on('tokenAdded', (data: { mint: string; creator: string }) => {
    const token = tokenWatchlist.getToken(data.mint);
    if (token) {
      io.emit('watchlist:tokenAdded', formatWatchlistToken(data.mint, token));
    }
  });

  tokenWatchlist.on('tokenRemoved', (data: { mint: string }) => {
    io.emit('watchlist:tokenRemoved', { mint: data.mint });
  });

  tokenWatchlist.on('devSold', (data: { mint: string }) => {
    io.emit('watchlist:devSold', { mint: data.mint });
    io.emit('toast', {
      type: 'warning',
      title: 'Dev Sold',
      message: `Token ${data.mint.substring(0, 8)}... creator dumped`,
    });
  });

  tokenWatchlist.on('tokenReady', (data: { mint: string }) => {
    const token = tokenWatchlist.getToken(data.mint);
    if (token) {
      io.emit('watchlist:tokenAdded', formatWatchlistToken(data.mint, token));
    }
  });

  // Wallet sync events
  walletSync.on('synced', (data) => {
    io.emit('wallet:update', {
      solBalance: data.solBalance,
      lastSync: data.syncTime,
      discrepancyCount: data.discrepancies.length,
    });
  });

  walletSync.on('discrepancies', (discrepancies) => {
    if (discrepancies.length > 0) {
      io.emit('toast', {
        type: 'warning',
        title: 'Balance Discrepancy',
        message: `Found ${discrepancies.length} position(s) with balance issues`,
      });
    }
  });

  // Equity tracker events
  equityTracker.on('snapshot', (snapshot) => {
    io.emit('equity:snapshot', {
      timestamp: snapshot.timestamp,
      totalEquity: snapshot.totalEquitySol,
      walletBalance: snapshot.walletBalanceSol,
      positionsValue: snapshot.positionsValueSol,
      unrealizedPnl: snapshot.unrealizedPnlSol,
      positionCount: snapshot.positionCount,
      source: snapshot.source,
    });
  });

  // Position reconciler events
  positionReconciler.on('phantomsDetected', (phantoms) => {
    io.emit('reconciliation:phantoms', {
      count: phantoms.length,
      phantoms: phantoms.map((p: any) => ({
        positionId: p.positionId,
        mint: p.mint.substring(0, 15) + '...',
        symbol: p.symbol,
        lostSol: p.amountSol,
      })),
    });
  });

  positionReconciler.on('notification', (notification) => {
    io.emit('toast', notification);
  });

  // C100 events
  c100Tracker.on('priceUpdate', (data) => {
    io.emit('c100:priceUpdate', data);
  });

  rewardClaimer.on('claimSuccess', (data) => {
    io.emit('c100:claim', data);
    io.emit('toast', {
      type: 'success',
      title: 'Reward Claimed',
      message: `Claimed ${data.amountSol.toFixed(6)} SOL from ${data.source}`,
    });
  });

  rewardClaimer.on('claimCycleComplete', (data) => {
    if (data.totalClaimed > 0) {
      io.emit('c100:claimCycle', data);
    }
  });

  c100Buyback.on('buybackSuccess', (data) => {
    io.emit('c100:buyback', data);
    io.emit('toast', {
      type: 'success',
      title: 'C100 Buyback',
      message: `Bought ${data.amountTokens.toFixed(0)} tokens for ${data.amountSol.toFixed(6)} SOL`,
    });
  });
}

function startPeriodicBroadcasts(io: SocketServer): void {
  // Broadcast position updates every 1 second (live P&L)
  setInterval(() => {
    const positions = positionManager.getOpenPositions();
    if (positions.length > 0) {
      io.emit('positions:update', formatPositions(positions));
    }
  }, 1000);

  // Broadcast watchlist updates every 2 seconds
  setInterval(() => {
    const stats = tokenWatchlist.getStats();
    const allTokens = tokenWatchlist.getAllTokens();

    // Format all watched tokens (up to 20 most recent)
    if (stats.total > 0) {
      const formattedTokens = allTokens.slice(0, 20).map(mint => {
        const token = tokenWatchlist.getToken(mint);
        if (token) {
          return formatWatchlistToken(mint, token);
        }
        return null;
      }).filter(Boolean);

      io.emit('watchlist:update', {
        tokens: formattedTokens,
        stats
      });
    }
  }, 2000);

  // Broadcast stats every 5 seconds
  setInterval(async () => {
    try {
      const metrics = await performanceAnalytics.calculateMetrics();
      const drawdown = drawdownGuard.getState();
      const positions = positionManager.getOpenPositions();

      const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
      const currentEquity = config.initialCapitalSol + metrics.totalPnl + totalUnrealizedPnl;
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

      io.emit('stats:update', {
        multiplier: multiplier.toFixed(2),
        winRate: (metrics.winRate * 100).toFixed(1),
        totalTrades: metrics.totalTrades,
        tokensScanned,
        currentEquity: currentEquity.toFixed(4),
        totalPnl: metrics.totalPnl.toFixed(4),
        totalUnrealizedPnl: totalUnrealizedPnl.toFixed(4),
        dailyPnl: drawdown.dailyPnl.toFixed(4),
        drawdown: (drawdown.currentDrawdown * 100).toFixed(2),
        winStreak,
        isPaused: drawdown.isPaused,
        positionCount: positions.length,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to broadcast stats');
    }
  }, 5000);

  // Broadcast wallet balance every 10 seconds
  setInterval(() => {
    try {
      const walletState = walletSync.getState();
      const latestEquity = equityTracker.getLatestSnapshot();

      if (walletState) {
        io.emit('wallet:update', {
          solBalance: walletState.solBalance,
          lastSync: walletState.lastSync,
          isHealthy: walletSync.isHealthy(),
          totalEquity: latestEquity?.totalEquitySol || walletState.solBalance,
        });
      }
    } catch (error) {
      logger.error({ error }, 'Failed to broadcast wallet update');
    }
  }, 10000);

  // Broadcast C100 status every 30 seconds
  setInterval(() => {
    try {
      if (!c100Tracker.isEnabled()) return;

      const tokenData = c100Tracker.getTokenData();
      const claimStats = rewardClaimer.getStats();
      const buybackStats = c100Buyback.getStats();

      io.emit('c100:update', {
        token: tokenData,
        claims: {
          totalClaimedSol: claimStats.totalClaimedSol,
          claimCount: claimStats.claimCount,
          lastClaimTime: claimStats.lastClaimTime,
        },
        buybacks: {
          totalBuybackSol: buybackStats.totalBuybackSol,
          totalTokensBought: buybackStats.totalTokensBought,
          buybackCount: buybackStats.buybackCount,
          lastBuybackTime: buybackStats.lastBuybackTime,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to broadcast C100 update');
    }
  }, 30000);
}

function formatPositions(positions: Position[]): {
  positions: any[];
  totalUnrealizedPnl: string;
  totalExposure: string;
  positionCount: number;
} {
  const formattedPositions = positions.map((p) => ({
    id: p.id,
    mint: p.mint,
    symbol: p.symbol,
    amount: p.amount,
    amountSol: p.amountSol,
    entryPrice: p.entryPrice,
    currentPrice: p.currentPrice,
    highestPrice: p.highestPrice,
    unrealizedPnl: p.unrealizedPnl,
    unrealizedPnlPercent: p.unrealizedPnlPercent,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    tpSold: p.tpSold,
    trailingStop: p.trailingStop,
    status: p.status,
    poolType: p.poolType,
    entryTime: p.entryTime.toISOString(),
    holdTime: Date.now() - p.entryTime.getTime(),
  }));

  const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const totalExposure = positionManager.getTotalExposure();

  return {
    positions: formattedPositions,
    totalUnrealizedPnl: totalUnrealizedPnl.toFixed(6),
    totalExposure: totalExposure.toFixed(4),
    positionCount: positions.length,
  };
}

function formatTrade(trade: any): any {
  return {
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
  };
}

function formatWatchlistToken(mint: string, token: any): any {
  const features = tokenWatchlist.extractFeatures(mint);
  const filterResult = tokenWatchlist.passesHardFilters(mint);
  const cachedMetadata = tokenMetadataCache.get(mint);

  let status: 'collecting' | 'ready' | 'analyzing' | 'rejected' | 'bought' = 'collecting';
  if (token.devSold) {
    status = 'rejected';
  } else if (filterResult.passes) {
    status = 'ready';
  } else if (token.priceHistory?.length >= 10) {
    status = 'rejected';
  }

  return {
    mint,
    name: cachedMetadata?.name || token.name,
    symbol: cachedMetadata?.symbol || token.symbol,
    imageUrl: cachedMetadata?.imageUrl || null,
    firstSeen: token.firstSeen,
    dataPoints: token.priceHistory?.length || 0,
    priceChange: features?.priceChange || 0,
    volatility: features?.volatility || 0,
    drawdown: features?.drawdown || 0,
    buyPressure: features?.buyPressure || 0.5,
    uniqueTraders: features?.uniqueTraders || 0,
    devSold: token.devSold || false,
    status,
    rejectReason: !filterResult.passes ? filterResult.reason : undefined
  };
}

// Export for external use
export function getTokensScanned(): number {
  return tokensScanned;
}

export function resetTokensScanned(): void {
  tokensScanned = 0;
}
