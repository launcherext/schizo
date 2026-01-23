import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';
import { config, LAMPORTS_PER_SOL } from '../config/settings';
import { priceFeed } from '../data/price-feed';
import { txManager } from '../execution/tx-manager';
import { repository } from '../db/repository';
import { Position, RiskCheckResult } from './types';
import { velocityTracker } from '../signals/velocity-tracker';
import { pumpDetector } from '../signals/pump-detector';

// Estimated fee per transaction in SOL (Jupiter swap fee + priority fee)
const ESTIMATED_TX_FEE_SOL = 0.001;

const logger = createChildLogger('position-manager');

export class PositionManager extends EventEmitter {
  private positions: Map<string, Position> = new Map();
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
  }

  async start(): Promise<void> {
    // Load existing positions from database
    await this.loadPositions();

    // Start position monitoring
    this.monitorInterval = setInterval(() => {
      this.monitorPositions();
    }, config.priceCheckIntervalMs);

    // Start cleanup routine (runs every 60 seconds)
    setInterval(() => {
      this.cleanupStuckPositions().catch(err => {
        logger.error({ error: err.message }, 'Cleanup routine failed');
      });
    }, 60000);

    logger.info({ positionCount: this.positions.size }, 'Position manager started');
  }

  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    logger.info('Position manager stopped');
  }

  private async loadPositions(): Promise<void> {
    try {
      const dbPositions = await repository.getOpenPositions();

      for (const dbPos of dbPositions) {
        const amountSol = parseFloat(dbPos.amount_sol.toString());
        // Load accumulated PnL from partial closes
        const partialClosePnl = await repository.getTotalPartialClosePnl(dbPos.id);

        const position: Position = {
          id: dbPos.id,
          mint: dbPos.mint,
          symbol: dbPos.symbol || '',
          entryPrice: parseFloat(dbPos.entry_price.toString()),
          currentPrice: parseFloat(dbPos.current_price.toString()),
          amount: parseFloat(dbPos.amount.toString()),
          amountSol,
          entryTime: new Date(dbPos.entry_time),
          lastUpdate: new Date(dbPos.last_update),
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
          highestPrice: parseFloat(dbPos.highest_price.toString()),
          lowestPrice: parseFloat(dbPos.lowest_price.toString()),
          stopLoss: parseFloat(dbPos.stop_loss.toString()),
          takeProfit: JSON.parse(dbPos.take_profit_json || '[]'),
          tpSold: JSON.parse(dbPos.tp_sold_json || '[]'),
          status: dbPos.status as 'open' | 'closing' | 'closed',
          poolType: dbPos.pool_type as 'active' | 'high_risk',
          // NEW: Performance-based TP tracking (default for existing positions)
          initialRecovered: (dbPos as any).initial_recovered || false,
          scaledExitsTaken: (dbPos as any).scaled_exits_taken || 0,
          initialInvestment: (dbPos as any).initial_investment || amountSol,
          // NEW: Accumulated PnL from partial closes
          realizedPnl: partialClosePnl,
        };

        this.positions.set(position.id, position);
        priceFeed.addToWatchList(position.mint);
      }

      logger.info({ loaded: this.positions.size }, 'Positions loaded from database');
    } catch (error) {
      logger.error({ error }, 'Failed to load positions');
    }
  }

  async openPosition(params: {
    mint: string;
    symbol: string;
    entryPrice: number;
    amount: number;
    amountSol: number;
    poolType: 'active' | 'high_risk';
  }): Promise<Position> {
    const id = `pos_${params.mint}_${Date.now()}`;

    // Calculate stop loss and take profit levels
    const stopLoss = params.entryPrice * (1 - config.stopLossPercent);
    const takeProfit = config.takeProfitLevels.map((tp) => params.entryPrice * tp.multiplier);

    const position: Position = {
      id,
      mint: params.mint,
      symbol: params.symbol,
      entryPrice: params.entryPrice,
      currentPrice: params.entryPrice,
      amount: params.amount,
      amountSol: params.amountSol,
      entryTime: new Date(),
      lastUpdate: new Date(),
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      highestPrice: params.entryPrice,
      lowestPrice: params.entryPrice,
      stopLoss,
      takeProfit,
      tpSold: [],
      status: 'open',
      poolType: params.poolType,
      // NEW: Performance-based TP tracking
      initialRecovered: false,
      scaledExitsTaken: 0,
      initialInvestment: params.amountSol,
      // NEW: Accumulated PnL tracking
      realizedPnl: 0,
    };

    this.positions.set(id, position);
    priceFeed.addToWatchList(params.mint);

    // Save to database
    await repository.upsertPosition({
      id: position.id,
      mint: position.mint,
      symbol: position.symbol,
      entry_price: position.entryPrice,
      current_price: position.currentPrice,
      amount: position.amount,
      amount_sol: position.amountSol,
      entry_time: position.entryTime,
      highest_price: position.highestPrice,
      lowest_price: position.lowestPrice,
      stop_loss: position.stopLoss,
      take_profit_json: JSON.stringify(position.takeProfit),
      tp_sold_json: JSON.stringify(position.tpSold),
      status: position.status,
      pool_type: position.poolType,
      // Performance-based TP tracking
      initial_recovered: position.initialRecovered,
      scaled_exits_taken: position.scaledExitsTaken,
      initial_investment: position.initialInvestment,
      realized_pnl: position.realizedPnl,
    });

    this.emit('positionOpened', position);
    logger.info({
      id,
      mint: params.mint,
      amountSol: params.amountSol,
      stopLoss: stopLoss.toFixed(10),
      takeProfit: takeProfit.map((tp) => tp.toFixed(10)),
    }, 'Position opened');

    return position;
  }

  private async monitorPositions(): Promise<void> {
    for (const position of this.positions.values()) {
      if (position.status !== 'open') continue;

      try {
        let priceData = priceFeed.getPrice(position.mint);

        // If cache miss, attempt fresh fetch for bonding curve tokens
        if (!priceData && position.mint.endsWith('pump')) {
          priceData = await priceFeed.fetchTokenPrice(position.mint);
        }

        if (!priceData) {
          // Track how long we've been without price data
          const lastUpdateAge = Date.now() - position.lastUpdate.getTime();
          const positionAge = Date.now() - position.entryTime.getTime();

          // If no price data for 60+ seconds and position is at least 30 seconds old, close as dead
          if (lastUpdateAge > 60000 && positionAge > 30000) {
            logger.warn({
              mint: position.mint.substring(0, 15),
              lastUpdateAgeSeconds: (lastUpdateAge / 1000).toFixed(0),
              positionAgeSeconds: (positionAge / 1000).toFixed(0),
            }, 'DEAD TOKEN: No price data for 60s - force closing');

            await this.closePosition(position.id, 'dead_token', true);
            continue;
          }

          logger.warn({ mint: position.mint.substring(0, 15) }, 'No price data - skipping position');
          continue;
        }

        // STALE PRICE CHECK: If price data timestamp is old, the token might be dead
        // DexScreener can return cached data for dead tokens
        const priceAge = Date.now() - priceData.timestamp.getTime();
        const positionAge = Date.now() - position.entryTime.getTime();
        const STALE_PRICE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

        if (priceAge > STALE_PRICE_THRESHOLD_MS && positionAge > 60000) {
          logger.warn({
            mint: position.mint.substring(0, 15),
            priceAgeSeconds: (priceAge / 1000).toFixed(0),
            positionAgeSeconds: (positionAge / 1000).toFixed(0),
          }, 'STALE PRICE DATA: Price not updated for 5+ min - force closing as dead token');

          await this.closePosition(position.id, 'dead_token', true);
          continue;
        }

        const previousPrice = position.currentPrice;
        position.currentPrice = priceData.priceSol;
        position.lastUpdate = new Date();

        // Update highest/lowest
        if (position.currentPrice > position.highestPrice) {
          position.highestPrice = position.currentPrice;
          this.updateTrailingStop(position);
        }
        if (position.currentPrice < position.lowestPrice) {
          position.lowestPrice = position.currentPrice;
        }

        // Calculate unrealized P&L
        const currentValue = position.amount * position.currentPrice;
        position.unrealizedPnl = currentValue - position.amountSol;
        position.unrealizedPnlPercent =
          ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;

        // Check exit conditions
        await this.checkExitConditions(position);

        // Update database periodically (every 10th update)
        if (Math.random() < 0.1) {
          await this.persistPosition(position);
        }
      } catch (error) {
        logger.error({ positionId: position.id, error }, 'Failed to monitor position');
      }
    }
  }

  private updateTrailingStop(position: Position): void {
    // Enable trailing stop immediately when in profit, with dynamic tightening
    // This protects profits early instead of waiting for +100%
    const profitPercent = (position.highestPrice - position.entryPrice) / position.entryPrice;

    // Dynamic trailing percentage based on profit level
    // Higher profit = tighter trailing to protect gains
    let trailingPercent: number;
    if (profitPercent >= 1.00) {
      trailingPercent = 0.12;  // +100%: tight 12% trailing
    } else if (profitPercent >= 0.50) {
      trailingPercent = 0.15;  // +50%: 15% trailing
    } else if (profitPercent >= 0.30) {
      trailingPercent = 0.20;  // +30%: 20% trailing
    } else if (profitPercent >= 0.10) {
      trailingPercent = 0.25;  // +10%: 25% trailing
    } else {
      // Below +10%: no trailing stop yet, rely on fixed stop loss
      return;
    }

    const trailingStopPrice = position.highestPrice * (1 - trailingPercent);
    position.trailingStop = Math.max(position.trailingStop || 0, trailingStopPrice);
  }

  private async checkExitConditions(position: Position): Promise<void> {
    const currentPrice = position.currentPrice;
    const profitPercent = (currentPrice - position.entryPrice) / position.entryPrice;
    const positionAgeSeconds = (Date.now() - position.entryTime.getTime()) / 1000;
    const positionAgeMinutes = positionAgeSeconds / 60;

    // MAX HOLD TIME CHECK - Force exit positions held too long
    // Analysis showed positions held 4+ hours were almost all -90% losses
    const maxHoldMinutes = (config as any).maxHoldTimeMinutes || 30;
    if (positionAgeMinutes >= maxHoldMinutes) {
      logger.warn({
        positionId: position.id,
        mint: position.mint.substring(0, 15),
        holdMinutes: positionAgeMinutes.toFixed(1),
        maxHoldMinutes,
        profitPercent: (profitPercent * 100).toFixed(1) + '%',
      }, `MAX HOLD TIME REACHED (${maxHoldMinutes}min) - force closing to prevent zombie position`);

      await this.closePosition(position.id, 'trailing_stop', true); // Use high slippage for forced exit
      return;
    }

    // GUARD: Skip if profit percent is invalid (entry price = 0, or other corruption)
    if (!isFinite(profitPercent) || isNaN(profitPercent)) {
      logger.error({
        positionId: position.id,
        entryPrice: position.entryPrice,
        currentPrice,
        profitPercent,
      }, 'Invalid profit percent (possible corrupted position) - closing position');

      // Close the corrupted position
      await this.closePosition(position.id, 'manual');
      return;
    }

    // PROTECT PROFITS: Exit if price drops 15% from peak while in profit
    // This catches sharp reversals that the wider trailing stop would miss
    const dropFromPeak = position.highestPrice > 0
      ? (position.highestPrice - currentPrice) / position.highestPrice
      : 0;

    if (profitPercent > 0.20 && dropFromPeak > 0.15) {
      // We're in profit but price dropped 15%+ from peak - protect gains
      logger.warn({
        positionId: position.id,
        mint: position.mint.substring(0, 15),
        profitPercent: (profitPercent * 100).toFixed(1) + '%',
        dropFromPeak: (dropFromPeak * 100).toFixed(1) + '%',
        highestPrice: position.highestPrice,
        currentPrice,
      }, 'PROTECT PROFITS: 15%+ drop from peak while in profit - exiting');

      await this.closePosition(position.id, 'trailing_stop', true);
      return;
    }

    // Flash crash detection - disabled for first 90 seconds (snipe tokens too volatile)
    const recentPrices = priceFeed.getPriceHistory(position.mint, 10);

    // Only check flash crash for positions older than 90 seconds
    if (positionAgeSeconds > 90 && recentPrices.length >= 4) {
      let consecutiveDrops = 0;
      // Check from newest to oldest
      for (let i = recentPrices.length - 1; i > 0; i--) {
        if (recentPrices[i].priceSol < recentPrices[i - 1].priceSol) {
          consecutiveDrops++;
        } else {
          break; // Stop at first non-drop
        }
      }

      // Require 4+ consecutive drops AND 15%+ total drop (was 3 drops with no minimum)
      if (consecutiveDrops >= 4) {
        // Calculate the total drop across consecutive ticks
        const startPrice = recentPrices[recentPrices.length - 1 - consecutiveDrops].priceSol;
        const endPrice = recentPrices[recentPrices.length - 1].priceSol;
        const dropPercent = (startPrice - endPrice) / startPrice;

        // Only trigger if drop is significant (>15%)
        if (dropPercent > 0.15) {
          logger.error({
            positionId: position.id,
            mint: position.mint.substring(0, 15),
            consecutiveDrops,
            dropPercent: (dropPercent * 100).toFixed(1) + '%',
            startPrice,
            endPrice,
          }, 'FLASH CRASH DETECTED: 4+ consecutive drops >15% - emergency exit');

          await this.closePosition(position.id, 'stop_loss', true); // High slippage for emergency
          return;
        }
      }
    }

    // GUARD: Skip if position has no tokens left
    if (position.amount <= 0) {
      logger.warn({
        positionId: position.id,
        amount: position.amount,
      }, 'Position has no tokens - closing');

      // Mark as closed without trying to sell
      position.status = 'closed';
      await this.persistPosition(position);
      this.positions.delete(position.id);
      return;
    }

    // 0. RAPID DROP CHECK - Exit immediately if price crashes in first 20 seconds
    const rapidDropConfig = (config as any).rapidDropExit;

    if (rapidDropConfig?.enabled && positionAgeSeconds <= rapidDropConfig.windowSeconds) {
      if (profitPercent <= -rapidDropConfig.dropPercent) {
        logger.error({
          positionId: position.id,
          currentPrice,
          entryPrice: position.entryPrice,
          profitPercent: (profitPercent * 100).toFixed(2),
          positionAgeSeconds: positionAgeSeconds.toFixed(0),
        }, `RAPID DROP DETECTED - Emergency exit at ${(profitPercent * 100).toFixed(0)}%`);

        await this.closePosition(position.id, 'stop_loss', true); // true = use high slippage
        return;
      }
    }

    // 0.5 PUMP EXIT CHECK - Exit early if momentum is fading
    // CONSERVATIVE: Only triggers if clearly dumping or if in profit + severe decay
    // This prevents panic selling during consolidation before continuation pumps
    const pumpMetrics = pumpDetector.analyzePump(position.mint);
    if (pumpDetector.shouldExit(pumpMetrics, profitPercent)) {
      logger.warn({
        positionId: position.id,
        mint: position.mint.substring(0, 15),
        phase: pumpMetrics.phase,
        heatDecay: pumpMetrics.heatDecay ? (pumpMetrics.heatDecay * 100).toFixed(0) + '%' : 'N/A',
        buyPressure: (pumpMetrics.buyPressure * 100).toFixed(0) + '%',
        profitPercent: (profitPercent * 100).toFixed(2) + '%',
      }, 'PUMP EXIT: Clear dump signal - exiting');

      await this.closePosition(position.id, 'ai_signal', true);
      return;
    }

    // 1. STOP LOSS CHECK (age-based for new tokens)
    // Grace period: don't trigger stop loss for first X seconds
    if (positionAgeSeconds < config.stopLossGracePeriodSeconds) {
      // Skip stop loss check during grace period
    } else {
      // Calculate age-based stop loss
      let effectiveStopLoss = config.stopLossPercent; // Default 12%

      if (config.ageBasedStopLoss.enabled) {
        if (positionAgeSeconds < config.ageBasedStopLoss.newTokenThresholdSeconds) {
          // Brand new token (<60s): use wide stop
          effectiveStopLoss = config.ageBasedStopLoss.newTokenStopLossPercent;
        } else if (positionAgeSeconds < config.ageBasedStopLoss.youngTokenThresholdSeconds) {
          // Young token (60-180s): use medium stop
          effectiveStopLoss = config.ageBasedStopLoss.youngTokenStopLossPercent;
        }
        // After 180s: use standard stop loss
      }

      if (profitPercent <= -effectiveStopLoss) {
        logger.warn({
          positionId: position.id,
          currentPrice,
          entryPrice: position.entryPrice,
          profitPercent: (profitPercent * 100).toFixed(2),
          stopLossPercent: (effectiveStopLoss * 100).toFixed(0),
          positionAgeSeconds: positionAgeSeconds.toFixed(0),
        }, `Stop loss triggered at -${(effectiveStopLoss * 100).toFixed(0)}%`);

        await this.closePosition(position.id, 'stop_loss', true); // Use high slippage for stop loss
        return;
      }
    }

    // 2. TRAILING STOP CHECK (after any TP)
    if (position.trailingStop && currentPrice <= position.trailingStop) {
      logger.info({
        positionId: position.id,
        currentPrice,
        trailingStop: position.trailingStop,
        profitPercent: (profitPercent * 100).toFixed(2),
      }, 'Trailing stop triggered');

      await this.closePosition(position.id, 'trailing_stop', true); // Use high slippage for trailing stop
      return;
    }

    // 3. MOMENTUM-AWARE TAKE PROFIT
    // Check current momentum to decide TP thresholds dynamically
    const tpStrategy = config.takeProfitStrategy;
    const momentum = velocityTracker.getMomentumStrength(position.mint);

    // Dynamic TP thresholds based on momentum - PROTECT PROFITS EARLY
    // Take first profit at +40% (config), then adjust based on momentum
    // STRONG: Let it run a bit longer, but still protect gains
    // MEDIUM: Normal from config (+40% trigger, 20% trailing)
    // WEAK: Take profit earlier, tighter trailing
    let dynamicTpTrigger: number;
    let dynamicTrailingPercent: number;
    let dynamicSellPercent: number;

    switch (momentum.strength) {
      case 'strong':
        dynamicTpTrigger = 0.60;        // +60% for strong momentum (slightly higher than base 40%)
        dynamicTrailingPercent = 0.25;  // 25% trailing - still reasonable for strong pumps
        dynamicSellPercent = 0.30;      // Sell 30% - keep more for the ride
        break;
      case 'weak':
        dynamicTpTrigger = 0.30;        // +30% for weak momentum - take profit earlier
        dynamicTrailingPercent = 0.15;  // 15% trailing - tighter for fading momentum
        dynamicSellPercent = 0.40;      // Sell 40% - secure more gains
        break;
      default: // 'medium' or 'unknown'
        dynamicTpTrigger = tpStrategy.initialRecovery.triggerPercent; // +40% from config
        dynamicTrailingPercent = tpStrategy.trailingStopPercent;       // 20% from config
        dynamicSellPercent = 0.33;      // Sell 33%
    }

    // INITIAL RECOVERY with dynamic threshold
    if (!position.initialRecovered && profitPercent >= dynamicTpTrigger) {
      // Calculate how much to sell to recover initial investment
      const currentValue = position.amount * currentPrice;
      const sellAmount = position.initialInvestment / currentPrice;

      logger.info({
        positionId: position.id,
        profitPercent: (profitPercent * 100).toFixed(2),
        momentum: momentum.strength,
        momentumReason: momentum.reason,
        dynamicTpTrigger: (dynamicTpTrigger * 100).toFixed(0) + '%',
        sellAmount,
        initialInvestment: position.initialInvestment,
        currentValue,
      }, `🎯 MOMENTUM TP: ${momentum.strength} momentum → taking profit at +${(dynamicTpTrigger * 100).toFixed(0)}%`);

      const success = await this.partialCloseNewStrategy(position, sellAmount, 'initial_recovery');

      // ONLY mark as recovered and set trailing stop on successful sell
      if (success) {
        position.initialRecovered = true;
        position.trailingStop = currentPrice * (1 - dynamicTrailingPercent);
        await this.persistPosition(position);
      }
      return;
    }

    // 4. SCALED EXITS with dynamic intervals
    if (position.initialRecovered) {
      const profitSinceRecovery = profitPercent - dynamicTpTrigger;
      // Use same interval as trigger for consistency
      const scaledInterval = dynamicTpTrigger;
      const exitCount = Math.floor(profitSinceRecovery / scaledInterval);

      if (exitCount > position.scaledExitsTaken && position.amount > 0) {
        const sellAmount = position.amount * dynamicSellPercent;

        logger.info({
          positionId: position.id,
          profitPercent: (profitPercent * 100).toFixed(2),
          momentum: momentum.strength,
          exitNumber: position.scaledExitsTaken + 1,
          sellPercent: (dynamicSellPercent * 100).toFixed(0),
          sellAmount,
        }, `📊 Scaled exit #${position.scaledExitsTaken + 1}: ${momentum.strength} momentum → selling ${(dynamicSellPercent * 100).toFixed(0)}%`);

        const success = await this.partialCloseNewStrategy(position, sellAmount, 'scaled_exit');

        // ONLY increment counter and update trailing stop on successful sell
        if (success) {
          position.scaledExitsTaken++;
          position.trailingStop = currentPrice * (1 - dynamicTrailingPercent);
          await this.persistPosition(position);
        }
      }
    }

    // 5. PUMP EXHAUSTION DETECTION - Take profit when pump is slowing
    // Even if price is still high, if momentum is fading, start locking in gains
    // This catches the top before the dump
    // Only trigger once per 30 seconds to avoid over-selling
    const exhaustionCooldownMs = 30000;
    const lastExhaustionSell = (position as any).lastExhaustionSell || 0;
    const canTriggerExhaustion = Date.now() - lastExhaustionSell > exhaustionCooldownMs;

    // BALANCED: Trigger exhaustion at moderate profit with notable decay
    // With earlier TPs now, be more cautious about fading momentum
    if (profitPercent > 0.50 && position.amount > 0 && canTriggerExhaustion) {
      const nearHigh = currentPrice >= position.highestPrice * 0.85; // Within 15% of high
      const heatFading = pumpMetrics.heatDecay && pumpMetrics.heatDecay > 0.35; // 35% decay threshold
      const buyPressureFading = pumpMetrics.buyPressureDecay && pumpMetrics.buyPressureDecay > 0.30; // 30% decay
      const momentumWeakening = momentum.strength === 'weak'; // Only weak, not unknown

      // If we're in good profit, near the high, but momentum is fading - take some profit
      if (nearHigh && (heatFading || buyPressureFading || momentumWeakening)) {
        const exhaustionSellPercent = 0.30; // Sell 30% on exhaustion signal
        const sellAmount = position.amount * exhaustionSellPercent;

        logger.info({
          positionId: position.id,
          profitPercent: (profitPercent * 100).toFixed(2) + '%',
          nearHigh,
          heatDecay: pumpMetrics.heatDecay ? (pumpMetrics.heatDecay * 100).toFixed(0) + '%' : 'N/A',
          buyPressureDecay: pumpMetrics.buyPressureDecay ? (pumpMetrics.buyPressureDecay * 100).toFixed(0) + '%' : 'N/A',
          momentum: momentum.strength,
        }, '⚠️ PUMP EXHAUSTION: Momentum fading near highs - taking partial profit before reversal');

        const success = await this.partialCloseNewStrategy(position, sellAmount, 'scaled_exit');
        if (success) {
          // Tighten trailing stop on exhaustion signal
          position.trailingStop = currentPrice * (1 - 0.20); // Tighter 20% trailing after exhaustion
          (position as any).lastExhaustionSell = Date.now(); // Cooldown tracking
          await this.persistPosition(position);
        }
        return;
      }
    }

    // 6. Update trailing stop on new highs (after initial recovery) - also momentum-aware
    if (position.initialRecovered && currentPrice >= position.highestPrice) {
      const newTrailingStop = currentPrice * (1 - dynamicTrailingPercent);
      if (!position.trailingStop || newTrailingStop > position.trailingStop) {
        position.trailingStop = newTrailingStop;

        // Log when trailing stop updates on strong momentum
        if (momentum.strength === 'strong') {
          logger.debug({
            positionId: position.id,
            newHigh: currentPrice,
            trailingStop: newTrailingStop,
            trailingPercent: (dynamicTrailingPercent * 100).toFixed(0) + '%',
          }, '🚀 Strong momentum - trailing stop updated on new high');
        }
      }
    }
  }

  private async partialClose(position: Position, sellPercent: number, tpLevel: number): Promise<void> {
    const sellAmount = position.amount * sellPercent;

    // Execute partial sell with proper slippage for volatile tokens
    // skipBalanceCheck: trust our tracked position amount (RPC can be unreliable)
    const result = await txManager.executeSell(position.mint, sellAmount, 9, {
      slippageBps: config.defaultSlippageBps,
      skipBalanceCheck: true,
    });

    if (result.success) {
      position.amount -= sellAmount;
      position.tpSold.push(tpLevel);

      this.emit('partialClose', { position, tpLevel, sellAmount, result });

      // Update in database
      await this.persistPosition(position);
    } else {
      logger.error({
        positionId: position.id,
        tpLevel,
        error: result.error,
      }, 'Partial close failed');
    }
  }

  // NEW: Partial close for new TP strategy (absolute amount instead of percent)
  // Returns true on success, false on failure
  private async partialCloseNewStrategy(
    position: Position,
    sellAmount: number,
    reason: 'initial_recovery' | 'scaled_exit'
  ): Promise<boolean> {
    // Guard: Don't try to sell if amount is too small
    if (position.amount <= 0 || sellAmount <= 0) {
      logger.warn({
        positionId: position.id,
        amount: position.amount,
        sellAmount,
      }, 'Cannot sell - position amount is zero or negative');
      return false;
    }

    // Ensure we don't sell more than we have
    const actualSellAmount = Math.min(sellAmount, position.amount * 0.99);

    // Execute partial sell with proper slippage for volatile tokens
    // skipBalanceCheck: trust our tracked position amount (RPC can be unreliable)
    const result = await txManager.executeSell(position.mint, actualSellAmount, 9, {
      slippageBps: config.defaultSlippageBps,
      skipBalanceCheck: true,
    });

    if (result.success) {
      const previousAmount = position.amount;
      position.amount -= actualSellAmount;

      // Calculate PnL for this partial close
      const priceAtClose = position.currentPrice;
      const solReceived = result.outputAmount || (actualSellAmount * priceAtClose);
      const proportionalEntry = (actualSellAmount / previousAmount) * position.amountSol;
      const pnlSol = solReceived - proportionalEntry - ESTIMATED_TX_FEE_SOL;

      // Accumulate realized PnL
      position.realizedPnl = (position.realizedPnl || 0) + pnlSol;

      // Log to database
      await repository.insertPartialClose({
        position_id: position.id,
        mint: position.mint,
        close_type: reason,
        sell_amount_tokens: actualSellAmount,
        sell_amount_sol: solReceived,
        price_at_close: priceAtClose,
        pnl_sol: pnlSol,
        fees_sol: ESTIMATED_TX_FEE_SOL,
      });

      // Update position amount in database
      await repository.updatePositionAmount(position.id, position.amount);

      this.emit('partialClose', { position, reason, sellAmount: actualSellAmount, result, pnlSol });

      logger.info({
        positionId: position.id,
        reason,
        sellAmount: actualSellAmount,
        remainingAmount: position.amount,
        solReceived,
        pnlSol: pnlSol.toFixed(6),
        totalRealizedPnl: position.realizedPnl.toFixed(6),
      }, 'Partial close executed (new strategy)');
      return true;
    } else {
      logger.error({
        positionId: position.id,
        reason,
        error: result.error,
      }, 'Partial close failed (new strategy)');

      // SYNC: If tx-manager reports actual balance, update our position
      if (result.actualBalance !== undefined && result.actualBalance !== position.amount) {
        logger.warn({
          positionId: position.id,
          previousAmount: position.amount,
          actualBalance: result.actualBalance,
        }, 'Syncing position amount with actual on-chain balance (manual sell detected?)');

        position.amount = result.actualBalance;
        await this.persistPosition(position);

        // If balance is now 0, close the position
        if (position.amount <= 0) {
          logger.info({ positionId: position.id }, 'Position has no tokens after sync - marking as closed');
          position.status = 'closed';
          await this.persistPosition(position);
          this.positions.delete(position.id);
        }
      }

      return false;
    }
  }

  async closePosition(
    positionId: string,
    reason: 'stop_loss' | 'take_profit' | 'trailing_stop' | 'manual' | 'ai_signal' | 'rug_detected' | 'dead_token',
    useHighSlippage: boolean = false
  ): Promise<void> {
    const position = this.positions.get(positionId);

    if (!position) {
      logger.warn({ positionId }, 'Position not found');
      return;
    }

    if (position.status !== 'open') {
      logger.warn({ positionId, status: position.status }, 'Position not open');
      return;
    }

    position.status = 'closing';

    // Use high slippage for stop loss / emergency exits to ensure execution
    // Analysis showed stop loss trades failing due to insufficient slippage
    const slippageBps = (useHighSlippage || reason === 'stop_loss' || reason === 'rug_detected')
      ? ((config as any).stopLossSlippageBps || 3000)  // 30% for emergency exits
      : config.defaultSlippageBps;                      // 15% for normal exits

    logger.info({
      positionId,
      reason,
      slippageBps,
      useHighSlippage,
    }, 'Executing position close');

    // Execute full sell with proper slippage for volatile tokens
    // skipBalanceCheck: trust our tracked position amount (RPC can be unreliable)
    const result = await txManager.executeSell(position.mint, position.amount, 9, {
      slippageBps,
      skipBalanceCheck: true,
    });

    if (result.success) {
      position.status = 'closed';

      const exitPrice = position.currentPrice;

      // Calculate PnL for final close (remaining tokens)
      const solReceived = result.outputAmount || (position.amount * exitPrice);
      const remainingEntryValue = position.amount * position.entryPrice;
      const finalClosePnl = solReceived - remainingEntryValue - ESTIMATED_TX_FEE_SOL;

      // Total PnL = partial closes + final close
      const totalPnlSol = (position.realizedPnl || 0) + finalClosePnl;
      const pnlPercent = (totalPnlSol / position.amountSol) * 100;

      // Update database
      await repository.closePosition(positionId);

      // Clean up
      priceFeed.removeFromWatchList(position.mint);
      this.positions.delete(positionId);

      this.emit('positionClosed', {
        position,
        reason,
        exitPrice,
        pnlSol: totalPnlSol,
        pnlPercent,
        result,
        partialClosePnl: position.realizedPnl || 0,
        finalClosePnl,
        actualSolReceived: solReceived,
      });

      logger.info({
        positionId,
        reason,
        exitPrice,
        partialClosePnl: (position.realizedPnl || 0).toFixed(6),
        finalClosePnl: finalClosePnl.toFixed(6),
        totalPnlSol: totalPnlSol.toFixed(6),
        pnlPercent: pnlPercent.toFixed(2),
      }, 'Position closed');
    } else {
      // Check if actual balance is 0 - if so, close as total loss (ghost position)
      // BUT: Add grace period - don't close as ghost if position is < 60 seconds old
      // This prevents false positives due to RPC indexing delays
      const positionAgeMs = Date.now() - position.entryTime.getTime();
      const GHOST_GRACE_PERIOD_MS = 60000; // 60 seconds

      if (result.actualBalance === 0 && positionAgeMs > GHOST_GRACE_PERIOD_MS) {
        logger.warn({
          positionId,
          reason,
          error: result.error,
          positionAgeMs,
        }, 'Ghost position detected - no tokens on chain. Closing as total loss.');

        position.status = 'closed';
        position.amount = 0;
        // Total loss = entire investment
        const totalPnlSol = -position.amountSol;
        const pnlPercent = -100;

        // Update database
        await repository.closePosition(positionId);

        // Clean up
        priceFeed.removeFromWatchList(position.mint);
        this.positions.delete(positionId);

        this.emit('positionClosed', {
          position,
          reason: 'ghost_position',
          exitPrice: 0,
          pnlSol: totalPnlSol,
          pnlPercent,
          result,
        });

        logger.info({
          positionId,
          totalPnlSol: totalPnlSol.toFixed(6),
          pnlPercent: pnlPercent.toFixed(2),
        }, 'Ghost position closed as total loss');
        return;
      } else if (result.actualBalance === 0) {
        // Position is young, RPC might just be slow - retry later
        logger.warn({
          positionId,
          reason,
          error: result.error,
          positionAgeMs,
          graceRemaining: GHOST_GRACE_PERIOD_MS - positionAgeMs,
        }, 'Sell failed but position is young - will retry (RPC may be slow)');
        position.status = 'open';
        return;
      }

      position.status = 'open'; // Revert status
      logger.error({
        positionId,
        reason,
        error: result.error,
      }, 'Failed to close position');
    }
  }

  // Close a ghost position (0 tokens on-chain) without attempting to sell
  async closeGhostPosition(positionId: string): Promise<void> {
    const position = this.positions.get(positionId);

    if (!position) {
      logger.warn({ positionId }, 'Ghost position not found');
      return;
    }

    if (position.status !== 'open') {
      logger.warn({ positionId, status: position.status }, 'Ghost position not open');
      return;
    }

    logger.info({
      positionId,
      mint: position.mint.substring(0, 15),
      symbol: position.symbol,
      amountSol: position.amountSol,
    }, 'Closing ghost position (no sell attempt - 0 tokens on-chain)');

    position.status = 'closed';
    position.amount = 0;

    // Total loss = entire investment (we have no tokens)
    const totalPnlSol = -position.amountSol + (position.realizedPnl || 0);
    const pnlPercent = (totalPnlSol / position.amountSol) * 100;

    // Update database
    await repository.closePosition(positionId);

    // Clean up
    priceFeed.removeFromWatchList(position.mint);
    this.positions.delete(positionId);

    this.emit('positionClosed', {
      position,
      reason: 'ghost_position',
      exitPrice: 0,
      pnlSol: totalPnlSol,
      pnlPercent,
      result: { success: false, error: 'Ghost position - 0 tokens on-chain' },
    });

    logger.info({
      positionId,
      totalPnlSol: totalPnlSol.toFixed(6),
      pnlPercent: pnlPercent.toFixed(2),
    }, 'Ghost position closed as loss');
  }

  private async persistPosition(position: Position): Promise<void> {
    await repository.upsertPosition({
      id: position.id,
      mint: position.mint,
      symbol: position.symbol,
      entry_price: position.entryPrice,
      current_price: position.currentPrice,
      amount: position.amount,
      amount_sol: position.amountSol,
      entry_time: position.entryTime,
      highest_price: position.highestPrice,
      lowest_price: position.lowestPrice,
      stop_loss: position.stopLoss,
      take_profit_json: JSON.stringify(position.takeProfit),
      tp_sold_json: JSON.stringify(position.tpSold),
      status: position.status,
      pool_type: position.poolType,
      // Performance-based TP tracking
      initial_recovered: position.initialRecovered,
      scaled_exits_taken: position.scaledExitsTaken,
      initial_investment: position.initialInvestment,
      realized_pnl: position.realizedPnl,
    });
  }

  getPosition(id: string): Position | undefined {
    return this.positions.get(id);
  }

  getPositionByMint(mint: string): Position | undefined {
    for (const position of this.positions.values()) {
      if (position.mint === mint && position.status === 'open') {
        return position;
      }
    }
    return undefined;
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter((p) => p.status === 'open');
  }

  getPositionCount(): number {
    return this.getOpenPositions().length;
  }

  getTotalExposure(): number {
    return this.getOpenPositions().reduce((sum, p) => sum + p.amountSol, 0);
  }

  canOpenPosition(riskCheck: RiskCheckResult): boolean {
    return riskCheck.approved;
  }

  /**
   * Cleanup routine - call periodically to close stuck positions
   * Positions older than 5 minutes with 0 on-chain balance are closed as losses
   */
  async cleanupStuckPositions(): Promise<number> {
    const openPositions = this.getOpenPositions();
    let cleanedCount = 0;
    const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

    for (const position of openPositions) {
      const ageMs = Date.now() - position.entryTime.getTime();

      if (ageMs < MAX_AGE_MS) continue; // Skip young positions

      try {
        // Check actual on-chain balance
        const actualBalance = await txManager.getTokenBalance(position.mint);

        if (actualBalance === 0) {
          logger.warn({
            positionId: position.id,
            symbol: position.symbol,
            ageMinutes: (ageMs / 60000).toFixed(1),
          }, 'CLEANUP: Closing stuck position (0 balance after 5 min)');

          await this.closeGhostPosition(position.id);
          cleanedCount++;
        }
      } catch (error: any) {
        logger.error({ positionId: position.id, error: error.message }, 'Error checking position balance');
      }
    }

    if (cleanedCount > 0) {
      logger.info({ cleanedCount }, 'Stuck positions cleanup complete');
    }

    return cleanedCount;
  }
}

export const positionManager = new PositionManager();
