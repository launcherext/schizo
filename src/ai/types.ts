export enum Action {
  HOLD = 0,
  BUY = 1,
  SELL = 2,
}

export interface Experience {
  state: number[];
  action: Action;
  reward: number;
  nextState: number[];
  done: boolean;
}

export interface DDQNConfig {
  stateSize: number;
  actionSize: number;
  hiddenSize: number;
  learningRate: number;
  gamma: number;
  epsilon: number;
  epsilonMin: number;
  epsilonDecay: number;
  replayBufferSize: number;
  batchSize: number;
  targetUpdateTau: number;
}

export enum MarketRegime {
  BULL = 0,      // 100% position sizing
  VOLATILE = 1,  // 50% position sizing
  CRASH = 2,     // 25% position sizing
}

export interface RegimeState {
  regime: MarketRegime;
  confidence: number;
  transitionProbs: number[][];
  history: MarketRegime[];
}

export interface PositionSizeResult {
  sizeSol: number;
  kellyFraction: number;
  regimeMultiplier: number;
  riskAdjustedSize: number;
  reason: string;
}

export interface AIDecision {
  action: Action;
  confidence: number;
  regime: MarketRegime;
  positionSize: PositionSizeResult;
  qValues: number[];
  features: number[];
  timestamp: Date;
}

export interface ModelMetrics {
  totalTrades: number;
  winRate: number;
  avgReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  profitFactor: number;
  lastUpdated: Date;
}
