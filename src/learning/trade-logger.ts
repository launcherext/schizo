import { EventEmitter } from 'events';
import { createChildLogger } from '../utils/logger';
import { repository } from '../db/repository';
import { Action, MarketRegime } from '../ai/types';
import { StateVector, PumpPhase } from '../signals/types';
import { featureExtractor } from '../signals/feature-extractor';
import { TradeRecord } from './types';

const logger = createChildLogger('trade-logger');

export class TradeLogger extends EventEmitter {
  private activeTrades: Map<string, TradeRecord> = new Map();

  constructor() {
    super();
  }

  async logEntry(params: {
    positionId: string;
    mint: string;
    symbol: string;
    entryPrice: number;
    amount: number;
    amountSol: number;
    features: StateVector;
    regime: MarketRegime;
    pumpPhase: PumpPhase;
  }): Promise<TradeRecord> {
    const record: TradeRecord = {
      id: params.positionId,
      mint: params.mint,
      symbol: params.symbol,
      action: Action.BUY,
      entryPrice: params.entryPrice,
      amount: params.amount,
      amountSol: params.amountSol,
      entryTime: new Date(),
      features: params.features,
      regime: params.regime,
      pumpPhase: params.pumpPhase,
    };

    this.activeTrades.set(record.id, record);

    // Save to database
    await repository.insertTrade({
      id: record.id,
      mint: record.mint,
      symbol: record.symbol,
      action: record.action,
      entry_price: record.entryPrice,
      amount: record.amount,
      amount_sol: record.amountSol,
      entry_time: record.entryTime,
      features_json: JSON.stringify(record.features),
      regime: record.regime,
      pump_phase: record.pumpPhase,
    });

    logger.info({
      id: record.id,
      mint: record.mint,
      entryPrice: record.entryPrice,
      amountSol: record.amountSol,
    }, 'Trade entry logged');

    this.emit('entryLogged', record);

    return record;
  }

  async logExit(params: {
    positionId: string;
    exitPrice: number;
    exitReason: 'stop_loss' | 'take_profit' | 'trailing_stop' | 'manual' | 'ai_signal' | 'rug_detected' | 'dead_token';
    slippage?: number;
    fees?: number;
    actualSolReceived?: number;
    partialClosePnl?: number;
  }): Promise<TradeRecord | null> {
    const record = this.activeTrades.get(params.positionId);

    if (!record) {
      logger.warn({ positionId: params.positionId }, 'Trade not found for exit');
      return null;
    }

    record.exitPrice = params.exitPrice;
    record.exitTime = new Date();
    record.exitReason = params.exitReason;
    record.slippage = params.slippage;
    record.fees = params.fees;

    // Calculate P&L with fees and slippage included
    const grossPnl = (record.exitPrice - record.entryPrice) * record.amount;
    const fees = params.fees || 0;
    const slippageCost = params.slippage ? (params.slippage * record.amountSol) : 0;

    // If we have actual SOL received from the swap, use that for accurate PnL
    let netPnl: number;
    if (params.actualSolReceived !== undefined) {
      // Accurate PnL = actual received - initial investment
      netPnl = params.actualSolReceived - record.amountSol;
    } else {
      // Estimated PnL = gross - fees - slippage
      netPnl = grossPnl - fees - slippageCost;
    }

    // Add any accumulated partial close PnL
    const partialClosePnl = params.partialClosePnl || 0;
    record.pnlSol = netPnl + partialClosePnl;
    record.pnlPercent = (record.pnlSol / record.amountSol) * 100;
    record.duration = record.exitTime.getTime() - record.entryTime.getTime();

    logger.debug({
      positionId: params.positionId,
      grossPnl,
      fees,
      slippageCost,
      actualSolReceived: params.actualSolReceived,
      partialClosePnl,
      netPnl: record.pnlSol,
    }, 'PnL calculation breakdown');

    // Update database
    await repository.updateTradeExit(record.id, {
      exit_price: record.exitPrice,
      exit_time: record.exitTime,
      pnl_sol: record.pnlSol,
      pnl_percent: record.pnlPercent,
      duration_ms: record.duration,
      exit_reason: record.exitReason,
      slippage: record.slippage,
      fees: record.fees,
    });

    logger.info({
      id: record.id,
      mint: record.mint,
      exitPrice: record.exitPrice,
      pnlSol: record.pnlSol?.toFixed(6),
      pnlPercent: record.pnlPercent?.toFixed(2),
      duration: record.duration,
      exitReason: record.exitReason,
    }, 'Trade exit logged');

    this.activeTrades.delete(record.id);
    this.emit('exitLogged', record);

    return record;
  }

  getActiveTrades(): TradeRecord[] {
    return Array.from(this.activeTrades.values());
  }

  getActiveTrade(id: string): TradeRecord | undefined {
    return this.activeTrades.get(id);
  }

  async getRecentTrades(limit: number = 100): Promise<TradeRecord[]> {
    const dbTrades = await repository.getRecentTrades(limit);

    return dbTrades.map((t) => ({
      id: t.id,
      mint: t.mint,
      symbol: t.symbol || '',
      action: t.action as Action,
      entryPrice: parseFloat(t.entry_price.toString()),
      exitPrice: t.exit_price ? parseFloat(t.exit_price.toString()) : undefined,
      amount: parseFloat(t.amount.toString()),
      amountSol: parseFloat(t.amount_sol.toString()),
      entryTime: new Date(t.entry_time),
      exitTime: t.exit_time ? new Date(t.exit_time) : undefined,
      pnlSol: t.pnl_sol ? parseFloat(t.pnl_sol.toString()) : undefined,
      pnlPercent: t.pnl_percent ? parseFloat(t.pnl_percent.toString()) : undefined,
      duration: t.duration_ms ? parseInt(t.duration_ms.toString()) : undefined,
      features: JSON.parse(t.features_json || '{}'),
      regime: t.regime as MarketRegime,
      pumpPhase: t.pump_phase as PumpPhase,
      exitReason: t.exit_reason as any,
      slippage: t.slippage ? parseFloat(t.slippage.toString()) : undefined,
      fees: t.fees ? parseFloat(t.fees.toString()) : undefined,
    }));
  }

  async getTradesForTraining(weeks: number = 4): Promise<TradeRecord[]> {
    const dbTrades = await repository.getTradesForTraining(weeks);

    return dbTrades
      .filter((t) => t.exit_time !== null)
      .map((t) => ({
        id: t.id,
        mint: t.mint,
        symbol: t.symbol || '',
        action: t.action as Action,
        entryPrice: parseFloat(t.entry_price.toString()),
        exitPrice: t.exit_price ? parseFloat(t.exit_price.toString()) : undefined,
        amount: parseFloat(t.amount.toString()),
        amountSol: parseFloat(t.amount_sol.toString()),
        entryTime: new Date(t.entry_time),
        exitTime: t.exit_time ? new Date(t.exit_time) : undefined,
        pnlSol: t.pnl_sol ? parseFloat(t.pnl_sol.toString()) : undefined,
        pnlPercent: t.pnl_percent ? parseFloat(t.pnl_percent.toString()) : undefined,
        duration: t.duration_ms ? parseInt(t.duration_ms.toString()) : undefined,
        features: JSON.parse(t.features_json || '{}'),
        regime: t.regime as MarketRegime,
        pumpPhase: t.pump_phase as PumpPhase,
        exitReason: t.exit_reason as any,
        slippage: t.slippage ? parseFloat(t.slippage.toString()) : undefined,
        fees: t.fees ? parseFloat(t.fees.toString()) : undefined,
      }));
  }

  // Convert trade to experience for DDQN training
  tradeToExperience(trade: TradeRecord): {
    state: number[];
    action: Action;
    reward: number;
    nextState: number[];
    done: boolean;
  } | null {
    if (!trade.exitPrice || !trade.pnlPercent) {
      return null;
    }

    const state = featureExtractor.toArray(trade.features);

    // Reward function: profit-based with risk adjustment
    let reward = trade.pnlPercent / 10; // Scale to reasonable range

    // Penalty for large losses
    if (trade.pnlPercent < -20) {
      reward *= 1.5; // Amplify negative signal for big losses
    }

    // Bonus for good risk-adjusted exits
    if (trade.exitReason === 'take_profit') {
      reward *= 1.1;
    } else if (trade.exitReason === 'trailing_stop' && trade.pnlPercent > 0) {
      reward *= 1.05;
    }

    // Next state is similar to current (simplified)
    const nextState = state.slice();

    return {
      state,
      action: trade.action,
      reward,
      nextState,
      done: true,
    };
  }

  // NEW: Dense reward shaping for intermediate states during position holding
  // Call this periodically while position is open to provide learning signal
  calculateIntermediateReward(params: {
    unrealizedPnlPercent: number;
    previousPnlPercent: number;
    momentum: number;        // Price velocity
    volatility: number;
    drawdownFromPeak: number;
    holdDurationSeconds: number;
  }): number {
    const {
      unrealizedPnlPercent,
      previousPnlPercent,
      momentum,
      volatility,
      drawdownFromPeak,
      holdDurationSeconds,
    } = params;

    let reward = 0;

    // Reward for P&L improvement (delta reward)
    const pnlDelta = unrealizedPnlPercent - previousPnlPercent;
    reward += pnlDelta * 0.1;  // Small reward for positive movement

    // Reward for holding through upward momentum
    if (momentum > 0 && unrealizedPnlPercent > 0) {
      reward += 0.1 * Math.min(momentum, 1.0);  // Cap at 0.1 bonus
    }

    // Penalty for holding during drawdown
    if (drawdownFromPeak > 0.1) {  // More than 10% drawdown from peak
      reward -= 0.05 * drawdownFromPeak;
    }

    // Small penalty for holding through high volatility (risk)
    if (volatility > 0.05) {  // High volatility threshold
      reward -= 0.02 * volatility;
    }

    // Small penalty for entering tokens that immediately stagnate
    if (holdDurationSeconds < 30 && Math.abs(unrealizedPnlPercent) < 1) {
      reward -= 0.05;  // Token going nowhere quickly
    }

    // Clip rewards to prevent extreme values
    return Math.max(-1, Math.min(1, reward));
  }

  // NEW: Calculate reward signal for a position update
  getPositionRewardSignal(position: {
    mint: string;
    entryPrice: number;
    currentPrice: number;
    peakPrice: number;
    entryTime: Date;
    previousPrice?: number;
  }): {
    intermediateReward: number;
    unrealizedPnlPercent: number;
    momentum: number;
    drawdownFromPeak: number;
  } {
    const unrealizedPnlPercent = ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;
    const previousPnlPercent = position.previousPrice
      ? ((position.previousPrice - position.entryPrice) / position.entryPrice) * 100
      : 0;

    // Calculate momentum (price change rate)
    const momentum = position.previousPrice
      ? (position.currentPrice - position.previousPrice) / position.previousPrice
      : 0;

    // Calculate drawdown from peak
    const drawdownFromPeak = position.peakPrice > position.currentPrice
      ? (position.peakPrice - position.currentPrice) / position.peakPrice
      : 0;

    const holdDurationSeconds = (Date.now() - position.entryTime.getTime()) / 1000;

    const intermediateReward = this.calculateIntermediateReward({
      unrealizedPnlPercent,
      previousPnlPercent,
      momentum,
      volatility: 0,  // Would need historical data to calculate
      drawdownFromPeak,
      holdDurationSeconds,
    });

    return {
      intermediateReward,
      unrealizedPnlPercent,
      momentum,
      drawdownFromPeak,
    };
  }
}

export const tradeLogger = new TradeLogger();
