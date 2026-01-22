export interface Position {
  id: string;
  mint: string;
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  amount: number;
  amountSol: number;            // Initial SOL investment
  entryTime: Date;
  lastUpdate: Date;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  highestPrice: number;
  lowestPrice: number;
  stopLoss: number;
  takeProfit: number[];
  tpSold: number[];             // Track which TP levels hit (legacy)
  trailingStop?: number;
  status: 'open' | 'closing' | 'closed';
  poolType: 'active' | 'high_risk';

  // NEW: Performance-based TP tracking
  initialRecovered: boolean;    // True after initial investment recovered at +50%
  scaledExitsTaken: number;     // Count of scaled exits taken after recovery
  initialInvestment: number;    // Original SOL amount for recovery calculation

  // NEW: Accumulated PnL from partial closes
  realizedPnl: number;          // Total realized PnL from partial closes
}

export interface CapitalAllocation {
  totalSol: number;
  reserveSol: number;         // Never trade
  activeSol: number;          // Normal trades
  highRiskSol: number;        // Meme plays
  inPositions: number;        // Currently allocated
  availableActive: number;    // Available for active pool
  availableHighRisk: number;  // Available for high risk pool
}

export interface DrawdownState {
  currentEquity: number;
  peakEquity: number;
  currentDrawdown: number;
  maxDrawdown: number;
  dailyPnl: number;
  dailyStartEquity: number;
  isPaused: boolean;
  pauseUntil?: Date;
  pauseReason?: string;
}

export interface RiskLimits {
  maxPositionSizeSol: number;
  maxConcurrentPositions: number;
  dailyLossLimit: number;
  maxDrawdownLimit: number;
  minPositionSizeSol: number;
}

export interface RiskCheckResult {
  approved: boolean;
  adjustedSize?: number;
  reason: string;
  warnings: string[];
}

export interface PortfolioMetrics {
  totalValue: number;
  totalPnl: number;
  totalPnlPercent: number;
  positionCount: number;
  avgPositionSize: number;
  largestPosition: number;
  exposure: number;           // Total in positions / total capital
}
