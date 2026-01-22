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
  name?: string;
  symbol: string;
  imageUrl?: string | null;
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
  name?: string;
  symbol?: string;
  imageUrl?: string | null;
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
  name?: string;
  symbol: string;
  imageUrl?: string | null;
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
  name?: string;
  symbol?: string;
  imageUrl?: string | null;
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

// C100 Token Types
export interface C100TokenData {
  mint: string;
  name: string;
  symbol: string;
  priceSol: number;
  priceUsd: number;
  marketCapUsd: number;
  volume24h: number;
  priceChange24h: number;
  lastUpdated: string;
}

export interface C100ClaimStats {
  totalClaimedSol: number;
  claimCount: number;
  lastClaimTime: string | null;
}

export interface C100BuybackStats {
  totalBuybackSol: number;
  totalTokensBought: number;
  buybackCount: number;
  lastBuybackTime: string | null;
}

export interface C100Data {
  enabled: boolean;
  token: C100TokenData | null;
  claims: C100ClaimStats;
  buybacks: C100BuybackStats;
}
