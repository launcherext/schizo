export interface Stats {
  multiplier: string;
  currentEquity: string;
  initialCapital: string;
  winRate: string;
  totalTrades: number;
  tokensScanned: number;
  winStreak: number;
}

export interface Trade {
  id?: string;
  mint: string;
  symbol: string;
  amountSol: number;
  amountTokens: number;
  entryPrice: number;
  exitPrice?: number;
  pnlSol?: string;
  pnlPercent?: string;
  isOpen: boolean;
  entryTime: string;
  exitTime?: string;
}

export interface ScannerData {
  mint: string;
  tokensScanned: number;
  timestamp: number;
}

export interface ToastData {
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
}

export interface AIDecisionData {
  action: 0 | 1 | 2; // HOLD=0, BUY=1, SELL=2
  confidence: number;
  regime: 0 | 1 | 2; // BULL=0, VOLATILE=1, CRASH=2
  qValues: number[];
  mint: string;
  symbol: string;
  timestamp: string;
}

export interface NarrativeSignal {
  sentiment: 'bullish' | 'bearish' | 'neutral';
  bullishnessScore: number;
  hypeScore: number;
  keywords: string[];
  mint?: string;
  symbol?: string;
}

// Token Watchlist Types
export interface WatchlistToken {
  mint: string;
  symbol?: string;
  firstSeen: number;
  dataPoints: number;
  priceChange: number;
  volatility: number;
  drawdown: number;
  buyPressure: number;
  uniqueTraders: number;
  devSold: boolean;
  status: 'collecting' | 'ready' | 'analyzing' | 'rejected' | 'bought';
  rejectReason?: string;
}

export interface WatchlistStats {
  total: number;
  ready: number;
  devSold: number;
}
