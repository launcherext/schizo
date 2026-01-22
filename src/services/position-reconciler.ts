import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';
import { txManager } from '../execution/tx-manager';
import { positionManager } from '../risk/position-manager';
import { priceFeed } from '../data/price-feed';
import { repository } from '../db/repository';

const logger = createChildLogger('position-reconciler');

export interface PhantomPosition {
  positionId: string;
  mint: string;
  symbol: string;
  expectedAmount: number;
  actualAmount: number;
  amountSol: number;
  entryTime: Date;
}

export interface OrphanToken {
  mint: string;
  balance: number;
  estimatedValueSol: number;
}

export interface ReconciliationResult {
  phantomsFound: PhantomPosition[];
  orphansFound: OrphanToken[];
  phantomsClosed: number;
  reconciliationTime: Date;
}

export class PositionReconciler extends EventEmitter {
  private isRunning = false;

  constructor() {
    super();
  }

  async reconcile(autoClose: boolean = true): Promise<ReconciliationResult> {
    if (this.isRunning) {
      logger.warn('Reconciliation already in progress');
      return {
        phantomsFound: [],
        orphansFound: [],
        phantomsClosed: 0,
        reconciliationTime: new Date(),
      };
    }

    this.isRunning = true;
    const reconciliationTime = new Date();

    try {
      const phantomsFound: PhantomPosition[] = [];
      const orphansFound: OrphanToken[] = [];
      let phantomsClosed = 0;

      // Get all open positions
      const positions = positionManager.getOpenPositions();

      logger.info({ positionCount: positions.length }, 'Starting position reconciliation');

      // Check each position for phantom status
      for (const position of positions) {
        const actualBalance = await txManager.getTokenBalance(position.mint);

        // Position is phantom if we have position record but no tokens
        // Allow for small dust amounts (less than 0.1% of expected)
        const minTokenThreshold = position.amount * 0.001;

        if (actualBalance < minTokenThreshold) {
          const phantom: PhantomPosition = {
            positionId: position.id,
            mint: position.mint,
            symbol: position.symbol,
            expectedAmount: position.amount,
            actualAmount: actualBalance,
            amountSol: position.amountSol,
            entryTime: position.entryTime,
          };

          phantomsFound.push(phantom);

          logger.warn({
            positionId: position.id,
            mint: position.mint.substring(0, 15),
            expectedAmount: position.amount.toFixed(4),
            actualAmount: actualBalance.toFixed(4),
          }, 'PHANTOM POSITION DETECTED - No tokens in wallet');

          // Auto-close phantom position
          if (autoClose) {
            try {
              // Delete from position manager memory
              await this.closePhantomPosition(position.id);
              phantomsClosed++;

              logger.info({
                positionId: position.id,
                mint: position.mint.substring(0, 15),
              }, 'Phantom position closed');
            } catch (error) {
              logger.error({ error, positionId: position.id }, 'Failed to close phantom position');
            }
          }
        }
      }

      // Emit events
      if (phantomsFound.length > 0) {
        this.emit('phantomsDetected', phantomsFound);

        // Send toast notification for dashboard
        this.emit('notification', {
          type: 'warning',
          title: 'Phantom Positions Detected',
          message: `Found ${phantomsFound.length} phantom position(s). ${phantomsClosed} auto-closed.`,
        });
      }

      if (orphansFound.length > 0) {
        this.emit('orphansDetected', orphansFound);
      }

      const result: ReconciliationResult = {
        phantomsFound,
        orphansFound,
        phantomsClosed,
        reconciliationTime,
      };

      logger.info({
        phantomsFound: phantomsFound.length,
        orphansFound: orphansFound.length,
        phantomsClosed,
      }, 'Reconciliation complete');

      return result;
    } finally {
      this.isRunning = false;
    }
  }

  private async closePhantomPosition(positionId: string): Promise<void> {
    const position = positionManager.getPosition(positionId);
    if (!position) {
      logger.warn({ positionId }, 'Position not found for phantom close');
      return;
    }

    // Log the phantom close as a loss (no SOL received since no tokens to sell)
    // Calculate the loss as the initial investment
    const pnlSol = -position.amountSol;

    // Remove from price feed watch list
    priceFeed.removeFromWatchList(position.mint);

    // Update database - mark as closed with phantom reason
    await repository.closePosition(positionId);

    // Log the trade exit as a phantom close
    await repository.updateTradeExit(positionId, {
      exit_price: 0,
      exit_time: new Date(),
      pnl_sol: pnlSol,
      pnl_percent: -100,
      duration_ms: Date.now() - position.entryTime.getTime(),
      exit_reason: 'phantom_close',
    });

    // Emit position closed event (for capital allocator etc)
    positionManager.emit('positionClosed', {
      position,
      reason: 'phantom_close',
      exitPrice: 0,
      pnlSol,
      pnlPercent: -100,
      result: { success: false, error: 'Phantom position - no tokens' },
    });

    logger.info({
      positionId,
      mint: position.mint.substring(0, 15),
      lostSol: position.amountSol.toFixed(4),
    }, 'Phantom position logged as loss');
  }

  // Check a single position for phantom status
  async checkPosition(positionId: string): Promise<boolean> {
    const position = positionManager.getPosition(positionId);
    if (!position) {
      return false;
    }

    const actualBalance = await txManager.getTokenBalance(position.mint);
    const minTokenThreshold = position.amount * 0.001;

    return actualBalance < minTokenThreshold;
  }

  // Get current phantom count without closing
  async getPhantomCount(): Promise<number> {
    const positions = positionManager.getOpenPositions();
    let phantomCount = 0;

    for (const position of positions) {
      const actualBalance = await txManager.getTokenBalance(position.mint);
      const minTokenThreshold = position.amount * 0.001;

      if (actualBalance < minTokenThreshold) {
        phantomCount++;
      }
    }

    return phantomCount;
  }
}

export const positionReconciler = new PositionReconciler();
