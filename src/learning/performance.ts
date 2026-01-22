import * as ss from 'simple-statistics';
import { createChildLogger } from '../utils/logger';
import { TradeRecord, PerformanceMetrics, TimeframePerformance, FeatureImportance } from './types';
import { tradeLogger } from './trade-logger';

const logger = createChildLogger('performance');

export class PerformanceAnalytics {
  constructor() {}

  async calculateMetrics(trades?: TradeRecord[]): Promise<PerformanceMetrics> {
    const completedTrades = trades || (await tradeLogger.getRecentTrades(1000)).filter(
      (t) => t.exitPrice !== undefined
    );

    if (completedTrades.length === 0) {
      return this.getEmptyMetrics();
    }

    const pnls = completedTrades.map((t) => t.pnlSol || 0);
    const pnlPercents = completedTrades.map((t) => t.pnlPercent || 0);
    const holdTimes = completedTrades.map((t) => t.duration || 0);

    const wins = completedTrades.filter((t) => (t.pnlSol || 0) > 0);
    const losses = completedTrades.filter((t) => (t.pnlSol || 0) < 0);

    const grossProfit = wins.reduce((sum, t) => sum + (t.pnlSol || 0), 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + (t.pnlSol || 0), 0));

    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

    const metrics: PerformanceMetrics = {
      totalTrades: completedTrades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: wins.length / completedTrades.length,
      avgWin,
      avgLoss,
      largestWin: wins.length > 0 ? Math.max(...wins.map((t) => t.pnlSol || 0)) : 0,
      largestLoss: losses.length > 0 ? Math.min(...losses.map((t) => t.pnlSol || 0)) : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      expectancy: ss.mean(pnls),
      sharpeRatio: this.calculateSharpeRatio(pnlPercents),
      sortinoRatio: this.calculateSortinoRatio(pnlPercents),
      maxDrawdown: this.calculateMaxDrawdown(pnls),
      avgHoldTime: holdTimes.length > 0 ? ss.mean(holdTimes) : 0,
      totalPnl: ss.sum(pnls),
      totalPnlPercent: ss.sum(pnlPercents),
    };

    return metrics;
  }

  private calculateSharpeRatio(returns: number[], riskFreeRate: number = 0): number {
    if (returns.length < 2) return 0;

    const meanReturn = ss.mean(returns);
    const stdDev = ss.standardDeviation(returns);

    if (stdDev === 0) return 0;

    // Annualize assuming ~100 trades per month
    const annualizationFactor = Math.sqrt(1200);
    return ((meanReturn - riskFreeRate) / stdDev) * annualizationFactor;
  }

  private calculateSortinoRatio(returns: number[], riskFreeRate: number = 0): number {
    if (returns.length < 2) return 0;

    const meanReturn = ss.mean(returns);
    const negativeReturns = returns.filter((r) => r < 0);

    if (negativeReturns.length === 0) return Infinity;

    const downstdDev = ss.standardDeviation(negativeReturns);

    if (downstdDev === 0) return Infinity;

    const annualizationFactor = Math.sqrt(1200);
    return ((meanReturn - riskFreeRate) / downstdDev) * annualizationFactor;
  }

  private calculateMaxDrawdown(pnls: number[]): number {
    if (pnls.length === 0) return 0;

    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;

    for (const pnl of pnls) {
      cumulative += pnl;
      peak = Math.max(peak, cumulative);
      const drawdown = (peak - cumulative) / (peak || 1);
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    return maxDrawdown;
  }

  async getTimeframePerformance(): Promise<TimeframePerformance> {
    const allTrades = await tradeLogger.getRecentTrades(10000);
    const completedTrades = allTrades.filter((t) => t.exitPrice !== undefined);

    const now = new Date();

    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const hourlyTrades = completedTrades.filter(
      (t) => t.exitTime && t.exitTime >= hourAgo
    );
    const dailyTrades = completedTrades.filter(
      (t) => t.exitTime && t.exitTime >= dayAgo
    );
    const weeklyTrades = completedTrades.filter(
      (t) => t.exitTime && t.exitTime >= weekAgo
    );
    const monthlyTrades = completedTrades.filter(
      (t) => t.exitTime && t.exitTime >= monthAgo
    );

    return {
      hourly: await this.calculateMetrics(hourlyTrades),
      daily: await this.calculateMetrics(dailyTrades),
      weekly: await this.calculateMetrics(weeklyTrades),
      monthly: await this.calculateMetrics(monthlyTrades),
      allTime: await this.calculateMetrics(completedTrades),
    };
  }

  async analyzeFeatureImportance(): Promise<FeatureImportance[]> {
    const trades = await tradeLogger.getTradesForTraining(4);

    if (trades.length < 20) {
      return [];
    }

    const featureNames = [
      'priceChange1m',
      'priceChange5m',
      'volumeZScore',
      'buySellRatio',
      'holderCount',
      'top10Concentration',
      'mintRevoked',
      'freezeRevoked',
      'lpLocked',
      'ageMinutes',
      'tradeIntensity',
      'marketCapSol',
    ];

    const importance: FeatureImportance[] = [];

    for (let i = 0; i < featureNames.length; i++) {
      const featureValues = trades.map((t) => {
        const arr = Object.values(t.features);
        return arr[i] || 0;
      });

      const profits = trades.map((t) => t.pnlPercent || 0);

      // Calculate correlation with profit
      let correlation = 0;
      try {
        correlation = ss.sampleCorrelation(featureValues, profits);
        if (isNaN(correlation)) correlation = 0;
      } catch {
        correlation = 0;
      }

      // Calculate feature variance as importance proxy
      const variance = ss.variance(featureValues);

      importance.push({
        feature: featureNames[i],
        importance: variance,
        correlation,
      });
    }

    // Sort by absolute correlation
    importance.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    return importance;
  }

  private getEmptyMetrics(): PerformanceMetrics {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      profitFactor: 0,
      expectancy: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      maxDrawdown: 0,
      avgHoldTime: 0,
      totalPnl: 0,
      totalPnlPercent: 0,
    };
  }

  formatMetrics(metrics: PerformanceMetrics): string {
    return [
      `Trades: ${metrics.totalTrades} (${metrics.winningTrades}W/${metrics.losingTrades}L)`,
      `Win Rate: ${(metrics.winRate * 100).toFixed(1)}%`,
      `Total P&L: ${metrics.totalPnl >= 0 ? '+' : ''}${metrics.totalPnl.toFixed(4)} SOL`,
      `Profit Factor: ${metrics.profitFactor.toFixed(2)}`,
      `Sharpe: ${metrics.sharpeRatio.toFixed(2)}`,
      `Max DD: ${(metrics.maxDrawdown * 100).toFixed(1)}%`,
    ].join(' | ');
  }
}

export const performanceAnalytics = new PerformanceAnalytics();
