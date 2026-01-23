import { Action, MarketRegime } from '../ai/types';
import { StateVector, PumpPhase } from '../signals/types';

export interface TradeRecord {
  id: string;
  mint: string;
  symbol: string;
  action: Action;
  entryPrice: number;
  exitPrice?: number;
  amount: number;
  amountSol: number;
  entryTime: Date;
  exitTime?: Date;
  pnlSol?: number;
  pnlPercent?: number;
  duration?: number;          // milliseconds
  features: StateVector;
  regime: MarketRegime;
  pumpPhase: PumpPhase;
  exitReason?: 'stop_loss' | 'take_profit' | 'trailing_stop' | 'manual' | 'ai_signal' | 'rug_detected' | 'dead_token';
  slippage?: number;
  fees?: number;
}

export interface PerformanceMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  profitFactor: number;       // gross profit / gross loss
  expectancy: number;         // avg profit per trade
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  avgHoldTime: number;
  totalPnl: number;
  totalPnlPercent: number;
}

export interface TimeframePerformance {
  hourly: PerformanceMetrics;
  daily: PerformanceMetrics;
  weekly: PerformanceMetrics;
  monthly: PerformanceMetrics;
  allTime: PerformanceMetrics;
}

export interface FeatureImportance {
  feature: string;
  importance: number;
  correlation: number;        // correlation with profit
}

export interface ModelTrainingResult {
  epochsTrained: number;
  finalLoss: number;
  validationLoss: number;
  trainingTime: number;
  samplesUsed: number;
  improvementPercent: number;
  timestamp: Date;
}

export interface LearningState {
  tradesProcessed: number;
  lastTrainingTime: Date;
  modelVersion: number;
  performanceHistory: PerformanceMetrics[];
  featureImportance: FeatureImportance[];
}
