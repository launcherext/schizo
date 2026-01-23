export interface StateVector {
  priceChange1m: number;      // 1-minute price change percentage
  priceChange5m: number;      // 5-minute price change percentage
  volumeZScore: number;       // Volume relative to average
  buySellRatio: number;       // Ratio of buy to sell volume
  holderCount: number;        // Normalized holder count
  top10Concentration: number; // Top 10 holder concentration
  mintRevoked: number;        // 1 if mint authority revoked, 0 otherwise
  freezeRevoked: number;      // 1 if freeze authority revoked, 0 otherwise
  lpLocked: number;           // 1 if LP locked, 0 otherwise
  ageMinutes: number;         // Token age in minutes (normalized)
  tradeIntensity: number;     // Trades per minute normalized
  marketCapSol: number;       // Market cap in SOL (normalized)
  // NEW: Additional features for better DDQN decision making
  drawdownFromPeak: number;   // 0-1, how far price has dropped from peak
  volatility: number;         // 0-1, standard deviation of recent price changes
  uniqueTraders: number;      // 0-1, normalized count of unique traders
  volumeTrend: number;        // -1 to 1, volume acceleration/deceleration
}

export interface RugScore {
  total: number;              // 0-100 overall safety score
  mintAuthorityScore: number; // 0-25 points
  freezeAuthorityScore: number; // 0-20 points
  lpLockedScore: number;      // 0-25 points
  concentrationScore: number; // 0-15 points
  bundledBuysScore: number;   // 0-15 points
  details: string[];          // Human readable breakdown
}

export type PumpPhase = 'cold' | 'building' | 'hot' | 'peak' | 'dumping';

export interface PumpMetrics {
  phase: PumpPhase;
  heat: number;               // 0-200+ heat metric
  volumeRatio: number;        // 1min/5min volume ratio
  priceVelocity: number;      // Rate of price change
  buyPressure: number;        // Buy vs sell imbalance
  confidence: number;         // 0-1 confidence in assessment
  // NEW: Pump position and decay metrics
  pumpFromLow?: number;       // How much price has pumped from lowest seen (0 = at low, 1 = doubled)
  heatDecay?: number;         // How much heat has dropped from peak (0 = at peak, 1 = fully decayed)
  buyPressureDecay?: number;  // How much buy pressure has dropped from peak
}

export interface TokenSignal {
  mint: string;
  state: StateVector;
  rugScore: RugScore;
  pumpMetrics: PumpMetrics;
  timestamp: Date;
  recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'avoid';
}

export interface FeatureHistory {
  mint: string;
  features: StateVector[];
  timestamps: Date[];
  maxHistory: number;
}

export interface VelocityMetrics {
  mint: string;
  txCount: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: Set<string>;
  uniqueSellers: Set<string>;
  txPerMinute: number;
  buyPressure: number;  // buyCount / txCount
  windowStartTime: number;
}

export interface VelocityResult {
  hasGoodVelocity: boolean;
  metrics: VelocityMetrics | null;
  reason: string;
}

export interface EntryResult {
  canEnter: boolean;
  source: 'pump_detector' | 'velocity' | 'snipe_mode' | 'none';
  reason: string;
  metrics?: PumpMetrics | VelocityMetrics;
}
