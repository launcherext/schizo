import * as ss from 'simple-statistics';
import { createChildLogger } from '../utils/logger';
import { MarketRegime, RegimeState } from './types';
import { priceFeed } from '../data/price-feed';
import { SOL_MINT } from '../config/settings';

const logger = createChildLogger('regime-detector');

export class RegimeDetector {
  private state: RegimeState;
  private priceHistory: number[] = [];
  private returnHistory: number[] = [];
  private maxHistory = 1000;
  private updateInterval: NodeJS.Timeout | null = null;

  // HMM parameters (simplified 3-state model)
  private transitionMatrix: number[][] = [
    [0.9, 0.08, 0.02], // From Bull
    [0.15, 0.7, 0.15], // From Volatile
    [0.1, 0.2, 0.7],   // From Crash
  ];

  private emissionParams = {
    [MarketRegime.BULL]: { meanReturn: 0.002, stdReturn: 0.01 },
    [MarketRegime.VOLATILE]: { meanReturn: 0, stdReturn: 0.03 },
    [MarketRegime.CRASH]: { meanReturn: -0.003, stdReturn: 0.04 },
  };

  constructor() {
    this.state = {
      regime: MarketRegime.VOLATILE,
      confidence: 0.5,
      transitionProbs: this.transitionMatrix,
      history: [],
    };
  }

  async start(): Promise<void> {
    // Start periodic regime updates
    this.updateInterval = setInterval(() => {
      this.updateRegime();
    }, 60000); // Update every minute

    logger.info('Regime detector started');
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    logger.info('Regime detector stopped');
  }

  private async updateRegime(): Promise<void> {
    try {
      // Get SOL price as market proxy
      const solPrice = priceFeed.getSolPrice();
      if (solPrice > 0) {
        this.addPrice(solPrice);
        this.detectRegime();
      }
    } catch (error) {
      logger.error({ error }, 'Failed to update regime');
    }
  }

  addPrice(price: number): void {
    this.priceHistory.push(price);

    if (this.priceHistory.length > 1) {
      const lastPrice = this.priceHistory[this.priceHistory.length - 2];
      const returnValue = (price - lastPrice) / lastPrice;
      this.returnHistory.push(returnValue);
    }

    // Trim histories
    if (this.priceHistory.length > this.maxHistory) {
      this.priceHistory = this.priceHistory.slice(-this.maxHistory);
      this.returnHistory = this.returnHistory.slice(-this.maxHistory);
    }
  }

  detectRegime(): MarketRegime {
    if (this.returnHistory.length < 30) {
      return this.state.regime;
    }

    // Calculate recent statistics
    const recentReturns = this.returnHistory.slice(-60);
    const meanReturn = ss.mean(recentReturns);
    const stdReturn = ss.standardDeviation(recentReturns);

    // Calculate likelihood of each regime
    const likelihoods = this.calculateLikelihoods(meanReturn, stdReturn);

    // Apply transition probabilities (forward algorithm simplified)
    const currentProbs = this.applyTransition(likelihoods);

    // Select most likely regime
    let maxProb = 0;
    let newRegime = this.state.regime;

    for (const [regime, prob] of Object.entries(currentProbs)) {
      if (prob > maxProb) {
        maxProb = prob;
        newRegime = parseInt(regime) as MarketRegime;
      }
    }

    // Update state
    const previousRegime = this.state.regime;
    this.state.regime = newRegime;
    this.state.confidence = maxProb;
    this.state.history.push(newRegime);

    if (this.state.history.length > 100) {
      this.state.history = this.state.history.slice(-100);
    }

    if (newRegime !== previousRegime) {
      logger.info(
        { from: MarketRegime[previousRegime], to: MarketRegime[newRegime], confidence: maxProb.toFixed(3) },
        'Regime changed'
      );
    }

    return newRegime;
  }

  private calculateLikelihoods(meanReturn: number, stdReturn: number): Record<MarketRegime, number> {
    const likelihoods: Record<MarketRegime, number> = {
      [MarketRegime.BULL]: 0,
      [MarketRegime.VOLATILE]: 0,
      [MarketRegime.CRASH]: 0,
    };

    for (const regime of [MarketRegime.BULL, MarketRegime.VOLATILE, MarketRegime.CRASH]) {
      const params = this.emissionParams[regime];

      // Gaussian likelihood for mean
      const meanLikelihood = this.gaussianPdf(meanReturn, params.meanReturn, params.stdReturn * 0.5);

      // Likelihood for volatility (higher vol less likely for bull)
      const volLikelihood = this.gaussianPdf(stdReturn, params.stdReturn, params.stdReturn * 0.3);

      likelihoods[regime] = meanLikelihood * volLikelihood;
    }

    // Normalize
    const total = Object.values(likelihoods).reduce((a, b) => a + b, 0);
    if (total > 0) {
      for (const regime of Object.keys(likelihoods) as unknown as MarketRegime[]) {
        likelihoods[regime] /= total;
      }
    }

    return likelihoods;
  }

  private gaussianPdf(x: number, mean: number, std: number): number {
    const exponent = -Math.pow(x - mean, 2) / (2 * Math.pow(std, 2));
    return Math.exp(exponent) / (std * Math.sqrt(2 * Math.PI));
  }

  private applyTransition(likelihoods: Record<MarketRegime, number>): Record<MarketRegime, number> {
    const currentRegime = this.state.regime;
    const transitionProbs = this.transitionMatrix[currentRegime];

    const result: Record<MarketRegime, number> = {
      [MarketRegime.BULL]: 0,
      [MarketRegime.VOLATILE]: 0,
      [MarketRegime.CRASH]: 0,
    };

    // Combine transition probability with emission likelihood
    for (const regime of [MarketRegime.BULL, MarketRegime.VOLATILE, MarketRegime.CRASH]) {
      result[regime] = transitionProbs[regime] * likelihoods[regime];
    }

    // Normalize
    const total = Object.values(result).reduce((a, b) => a + b, 0);
    if (total > 0) {
      for (const regime of Object.keys(result) as unknown as MarketRegime[]) {
        result[regime] /= total;
      }
    }

    return result;
  }

  getCurrentRegime(): RegimeState {
    return { ...this.state };
  }

  getRegimeMultiplier(regime?: MarketRegime): number {
    const r = regime ?? this.state.regime;

    switch (r) {
      case MarketRegime.BULL:
        return 1.0;
      case MarketRegime.VOLATILE:
        return 0.5;
      case MarketRegime.CRASH:
        return 0.25;
      default:
        return 0.5;
    }
  }

  getRegimeName(regime?: MarketRegime): string {
    const r = regime ?? this.state.regime;
    return MarketRegime[r] || 'UNKNOWN';
  }

  // Update transition matrix based on observed data
  updateTransitionMatrix(transitions: Array<{ from: MarketRegime; to: MarketRegime }>): void {
    if (transitions.length < 10) return;

    const counts: number[][] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];

    for (const { from, to } of transitions) {
      counts[from][to]++;
    }

    // Convert counts to probabilities with smoothing
    for (let i = 0; i < 3; i++) {
      const total = counts[i].reduce((a, b) => a + b, 0) + 3; // Add 3 for smoothing
      for (let j = 0; j < 3; j++) {
        this.transitionMatrix[i][j] = (counts[i][j] + 1) / total;
      }
    }

    this.state.transitionProbs = this.transitionMatrix;
    logger.info({ transitionMatrix: this.transitionMatrix }, 'Transition matrix updated');
  }

  getVolatility(): number {
    if (this.returnHistory.length < 10) return 0.02;
    const recent = this.returnHistory.slice(-30);
    return ss.standardDeviation(recent);
  }

  getTrend(): 'up' | 'down' | 'sideways' {
    if (this.returnHistory.length < 10) return 'sideways';

    const recent = this.returnHistory.slice(-20);
    const sum = recent.reduce((a, b) => a + b, 0);

    if (sum > 0.02) return 'up';
    if (sum < -0.02) return 'down';
    return 'sideways';
  }
}

export const regimeDetector = new RegimeDetector();
