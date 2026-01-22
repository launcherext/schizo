import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';
import { config } from '../config/settings';
import { repository } from '../db/repository';
import { positionManager } from './position-manager';
import { capitalAllocator } from './capital-allocator';
import { DrawdownState } from './types';

const logger = createChildLogger('drawdown-guard');

export class DrawdownGuard extends EventEmitter {
  private state: DrawdownState;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();

    this.state = {
      currentEquity: config.initialCapitalSol,
      peakEquity: config.initialCapitalSol,
      currentDrawdown: 0,
      maxDrawdown: 0,
      dailyPnl: 0,
      dailyStartEquity: config.initialCapitalSol,
      isPaused: false,
    };
  }

  async start(): Promise<void> {
    // Load state from database if available
    await this.loadState();

    // Start periodic checks
    this.checkInterval = setInterval(() => {
      this.updateState();
      this.checkLimits();
    }, 10000); // Check every 10 seconds

    logger.info('Drawdown guard started');
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info('Drawdown guard stopped');
  }

  private async loadState(): Promise<void> {
    try {
      const savedState = await repository.getConfig('drawdown_state');
      if (savedState) {
        const parsed = JSON.parse(savedState);
        this.state = { ...this.state, ...parsed };

        // Check if pause should be lifted
        if (this.state.pauseUntil && new Date(this.state.pauseUntil) < new Date()) {
          this.state.isPaused = false;
          this.state.pauseUntil = undefined;
          this.state.pauseReason = undefined;
        }
      }
    } catch (error) {
      logger.error({ error }, 'Failed to load drawdown state');
    }
  }

  private async saveState(): Promise<void> {
    try {
      await repository.setConfig('drawdown_state', JSON.stringify(this.state));
    } catch (error) {
      logger.error({ error }, 'Failed to save drawdown state');
    }
  }

  private async updateState(): Promise<void> {
    const allocation = capitalAllocator.getAllocation();
    const positions = positionManager.getOpenPositions();

    // Calculate current equity (wallet balance + unrealized P&L)
    let unrealizedPnl = 0;
    for (const position of positions) {
      unrealizedPnl += position.unrealizedPnl;
    }

    // In paper trading or when wallet is empty, use initial capital
    const baseEquity = allocation.totalSol > 0 ? allocation.totalSol : config.initialCapitalSol;
    this.state.currentEquity = baseEquity + unrealizedPnl;

    // Update peak equity
    if (this.state.currentEquity > this.state.peakEquity) {
      this.state.peakEquity = this.state.currentEquity;
    }

    // Calculate current drawdown
    this.state.currentDrawdown =
      (this.state.peakEquity - this.state.currentEquity) / this.state.peakEquity;

    // Update max drawdown
    if (this.state.currentDrawdown > this.state.maxDrawdown) {
      this.state.maxDrawdown = this.state.currentDrawdown;
    }

    // Update daily P&L
    this.state.dailyPnl = this.state.currentEquity - this.state.dailyStartEquity;

    // Check for new day
    await this.checkDayRollover();
  }

  private async checkDayRollover(): Promise<void> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const lastUpdate = await repository.getConfig('last_day_update');
    const lastUpdateDate = lastUpdate ? new Date(lastUpdate) : null;

    if (!lastUpdateDate || lastUpdateDate < todayStart) {
      // New day - record previous day stats and reset
      if (lastUpdateDate) {
        await repository.updateDailyStats(lastUpdateDate, {
          ending_equity: this.state.currentEquity,
          pnl: this.state.dailyPnl,
          max_drawdown: this.state.currentDrawdown,
        });
      }

      // Reset daily tracking
      this.state.dailyStartEquity = this.state.currentEquity;
      this.state.dailyPnl = 0;

      await repository.setConfig('last_day_update', now.toISOString());
      await repository.updateDailyStats(now, {
        starting_equity: this.state.currentEquity,
      });

      // Check if pause should be lifted
      if (this.state.isPaused && this.state.pauseUntil) {
        if (new Date(this.state.pauseUntil) <= now) {
          this.resumeTrading('Pause period expired');
        }
      }
    }
  }

  private checkLimits(): void {
    if (this.state.isPaused) return;

    // Prevent division by zero
    if (this.state.dailyStartEquity <= 0 || this.state.peakEquity <= 0) {
      return;
    }

    // Check daily loss limit
    const dailyLossPercent = -this.state.dailyPnl / this.state.dailyStartEquity;

    if (dailyLossPercent >= config.dailyLossLimit) {
      const pauseUntil = new Date();
      pauseUntil.setHours(pauseUntil.getHours() + 24);

      this.pauseTrading(
        `Daily loss limit (${(config.dailyLossLimit * 100).toFixed(0)}%) exceeded`,
        pauseUntil
      );
      return;
    }

    // Check max drawdown
    if (this.state.currentDrawdown >= 0.30) {
      // 30% max drawdown
      const pauseUntil = new Date();
      pauseUntil.setHours(pauseUntil.getHours() + 48);

      this.pauseTrading('Max drawdown (30%) exceeded', pauseUntil);
      return;
    }

    // Warn at 20% drawdown
    if (this.state.currentDrawdown >= 0.20 && this.state.currentDrawdown < 0.25) {
      logger.warn(
        { drawdown: (this.state.currentDrawdown * 100).toFixed(1) },
        'Drawdown warning - approaching limit'
      );
    }
  }

  pauseTrading(reason: string, until?: Date): void {
    this.state.isPaused = true;
    this.state.pauseReason = reason;
    this.state.pauseUntil = until;

    this.emit('tradingPaused', {
      reason,
      until,
      drawdown: this.state.currentDrawdown,
      dailyPnl: this.state.dailyPnl,
    });

    logger.error(
      { reason, until: until?.toISOString(), drawdown: this.state.currentDrawdown },
      'TRADING PAUSED'
    );

    this.saveState();
  }

  resumeTrading(reason: string): void {
    if (!this.state.isPaused) return;

    this.state.isPaused = false;
    this.state.pauseReason = undefined;
    this.state.pauseUntil = undefined;

    this.emit('tradingResumed', { reason });

    logger.info({ reason }, 'Trading resumed');

    this.saveState();
  }

  canTrade(): boolean {
    // Drawdown guard disabled - always allow trading
    return true;
  }

  getState(): DrawdownState {
    return { ...this.state };
  }

  getStatus(): string {
    if (this.state.isPaused) {
      return `PAUSED: ${this.state.pauseReason} (until ${this.state.pauseUntil?.toISOString()})`;
    }

    return [
      `Equity: ${this.state.currentEquity.toFixed(4)} SOL`,
      `Peak: ${this.state.peakEquity.toFixed(4)} SOL`,
      `Drawdown: ${(this.state.currentDrawdown * 100).toFixed(2)}%`,
      `Daily P&L: ${this.state.dailyPnl >= 0 ? '+' : ''}${this.state.dailyPnl.toFixed(4)} SOL`,
    ].join(' | ');
  }

  resetPeakEquity(): void {
    this.state.peakEquity = this.state.currentEquity;
    this.state.maxDrawdown = 0;
    logger.info({ newPeak: this.state.peakEquity }, 'Peak equity reset');
    this.saveState();
  }

  // Full reset for fresh start - uses actual wallet balance
  async resetAll(): Promise<void> {
    const allocation = capitalAllocator.getAllocation();
    const actualEquity = allocation.totalSol > 0 ? allocation.totalSol : config.initialCapitalSol;

    this.state = {
      currentEquity: actualEquity,
      peakEquity: actualEquity,
      currentDrawdown: 0,
      maxDrawdown: 0,
      dailyPnl: 0,
      dailyStartEquity: actualEquity,
      isPaused: false,
    };
    await this.saveState();
    logger.info({ equity: actualEquity }, 'Drawdown guard fully reset');
  }

  recordTrade(pnlSol: number): void {
    this.state.dailyPnl += pnlSol;

    if (pnlSol > 0) {
      this.state.currentEquity += pnlSol;
      if (this.state.currentEquity > this.state.peakEquity) {
        this.state.peakEquity = this.state.currentEquity;
      }
    } else {
      this.state.currentEquity += pnlSol;
      this.state.currentDrawdown =
        (this.state.peakEquity - this.state.currentEquity) / this.state.peakEquity;

      if (this.state.currentDrawdown > this.state.maxDrawdown) {
        this.state.maxDrawdown = this.state.currentDrawdown;
      }
    }

    this.checkLimits();
    this.saveState();
  }
}

export const drawdownGuard = new DrawdownGuard();
