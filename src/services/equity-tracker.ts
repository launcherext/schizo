import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';
import { walletSync } from './wallet-sync';
import { positionManager } from '../risk/position-manager';
import { priceFeed } from '../data/price-feed';
import { repository } from '../db/repository';

const logger = createChildLogger('equity-tracker');

export interface EquitySnapshot {
  timestamp: Date;
  walletBalanceSol: number;
  positionsValueSol: number;
  totalEquitySol: number;
  unrealizedPnlSol: number;
  positionCount: number;
  source: 'periodic' | 'trade_close' | 'startup';
}

export class EquityTracker extends EventEmitter {
  private snapshotInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private recentSnapshots: EquitySnapshot[] = [];
  private maxRecentSnapshots = 1440; // 24 hours at 1 minute intervals

  constructor() {
    super();
  }

  async start(intervalMs: number = 60000): Promise<void> {
    if (this.isRunning) {
      logger.warn('Equity tracker already running');
      return;
    }

    this.isRunning = true;

    // Initial snapshot
    await this.takeSnapshot('startup');

    // Start periodic snapshots
    this.snapshotInterval = setInterval(async () => {
      try {
        await this.takeSnapshot('periodic');
      } catch (error) {
        logger.error({ error }, 'Failed to take equity snapshot');
      }
    }, intervalMs);

    logger.info({ intervalMs }, 'Equity tracker started');
  }

  stop(): void {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
    this.isRunning = false;
    logger.info('Equity tracker stopped');
  }

  async takeSnapshot(source: 'periodic' | 'trade_close' | 'startup'): Promise<EquitySnapshot> {
    // Get wallet SOL balance
    const walletState = walletSync.getState();
    const walletBalanceSol = walletState?.solBalance || 0;

    // Calculate position values
    const positions = positionManager.getOpenPositions();
    let positionsValueSol = 0;
    let unrealizedPnlSol = 0;

    for (const position of positions) {
      // Get current price
      const priceData = priceFeed.getPrice(position.mint);
      const currentPrice = priceData?.priceSol || position.currentPrice;

      // Calculate current value
      const currentValue = position.amount * currentPrice;
      positionsValueSol += currentValue;

      // Calculate unrealized PnL
      const entryValue = position.amountSol;
      unrealizedPnlSol += currentValue - entryValue;
    }

    // Total equity = wallet SOL + position values
    const totalEquitySol = walletBalanceSol + positionsValueSol;

    const snapshot: EquitySnapshot = {
      timestamp: new Date(),
      walletBalanceSol,
      positionsValueSol,
      totalEquitySol,
      unrealizedPnlSol,
      positionCount: positions.length,
      source,
    };

    // Save to database
    await repository.insertEquitySnapshot({
      wallet_balance_sol: snapshot.walletBalanceSol,
      positions_value_sol: snapshot.positionsValueSol,
      total_equity_sol: snapshot.totalEquitySol,
      unrealized_pnl_sol: snapshot.unrealizedPnlSol,
      position_count: snapshot.positionCount,
      source: snapshot.source,
    });

    // Add to recent snapshots
    this.recentSnapshots.push(snapshot);
    if (this.recentSnapshots.length > this.maxRecentSnapshots) {
      this.recentSnapshots.shift();
    }

    // Emit event
    this.emit('snapshot', snapshot);

    logger.debug({
      walletSol: walletBalanceSol.toFixed(4),
      positionsValue: positionsValueSol.toFixed(4),
      totalEquity: totalEquitySol.toFixed(4),
      unrealizedPnl: unrealizedPnlSol.toFixed(4),
      positionCount: positions.length,
      source,
    }, 'Equity snapshot taken');

    return snapshot;
  }

  // Called when a trade closes to capture the equity change
  async onTradeClose(): Promise<void> {
    await this.takeSnapshot('trade_close');
  }

  getRecentSnapshots(): EquitySnapshot[] {
    return [...this.recentSnapshots];
  }

  async getEquityHistory(hours: number = 24): Promise<EquitySnapshot[]> {
    const dbSnapshots = await repository.getEquityHistory(hours);

    return dbSnapshots.map((s) => ({
      timestamp: new Date(s.timestamp),
      walletBalanceSol: parseFloat(s.wallet_balance_sol.toString()),
      positionsValueSol: parseFloat(s.positions_value_sol.toString()),
      totalEquitySol: parseFloat(s.total_equity_sol.toString()),
      unrealizedPnlSol: parseFloat(s.unrealized_pnl_sol.toString()),
      positionCount: s.position_count,
      source: s.source,
    }));
  }

  getLatestSnapshot(): EquitySnapshot | null {
    if (this.recentSnapshots.length === 0) return null;
    return this.recentSnapshots[this.recentSnapshots.length - 1];
  }

  getCurrentEquity(): number {
    const latest = this.getLatestSnapshot();
    return latest?.totalEquitySol || 0;
  }

  // Calculate equity change over a period
  getEquityChange(hours: number = 24): { changeSol: number; changePercent: number } {
    const cutoffTime = Date.now() - hours * 60 * 60 * 1000;
    const oldSnapshot = this.recentSnapshots.find((s) => s.timestamp.getTime() >= cutoffTime);
    const currentSnapshot = this.getLatestSnapshot();

    if (!oldSnapshot || !currentSnapshot) {
      return { changeSol: 0, changePercent: 0 };
    }

    const changeSol = currentSnapshot.totalEquitySol - oldSnapshot.totalEquitySol;
    const changePercent = oldSnapshot.totalEquitySol > 0
      ? (changeSol / oldSnapshot.totalEquitySol) * 100
      : 0;

    return { changeSol, changePercent };
  }
}

export const equityTracker = new EquityTracker();
