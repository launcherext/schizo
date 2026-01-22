/**
 * Position Manager TP/SL Logic Tests
 *
 * Tests the critical profit-taking and stop-loss logic:
 * - 12% stop loss
 * - +50% initial recovery (sell to recover cost)
 * - 15% trailing stop after recovery
 * - Scaled exits every +50% after recovery
 */

import { config } from '../config/settings';

// Helper to calculate profit percent
function calcProfitPercent(currentPrice: number, entryPrice: number): number {
  return (currentPrice - entryPrice) / entryPrice;
}

// Helper to check if stop loss should trigger
function shouldTriggerStopLoss(currentPrice: number, entryPrice: number): boolean {
  const profitPercent = calcProfitPercent(currentPrice, entryPrice);
  return profitPercent <= -config.stopLossPercent;
}

// Helper to check if trailing stop should trigger
function shouldTriggerTrailingStop(currentPrice: number, trailingStop: number | undefined): boolean {
  return trailingStop !== undefined && currentPrice <= trailingStop;
}

// Helper to check if initial recovery should trigger
function shouldTriggerInitialRecovery(
  currentPrice: number,
  entryPrice: number,
  initialRecovered: boolean
): boolean {
  if (initialRecovered) return false;
  const profitPercent = calcProfitPercent(currentPrice, entryPrice);
  return profitPercent >= config.takeProfitStrategy.initialRecovery.triggerPercent;
}

// Helper to calculate trailing stop price
function calcTrailingStop(currentPrice: number): number {
  return currentPrice * (1 - config.takeProfitStrategy.trailingStopPercent);
}

// Helper to calculate how many scaled exits should have been taken
function calcScaledExits(currentPrice: number, entryPrice: number): number {
  const profitPercent = calcProfitPercent(currentPrice, entryPrice);
  const profitSinceRecovery = profitPercent - config.takeProfitStrategy.initialRecovery.triggerPercent;
  if (profitSinceRecovery < 0) return 0;
  return Math.floor(profitSinceRecovery / config.takeProfitStrategy.scaledExits.intervalPercent);
}

describe('Position Manager TP/SL Logic', () => {
  // Verify config is correct
  describe('Config Verification', () => {
    it('should have 12% stop loss', () => {
      expect(config.stopLossPercent).toBe(0.12);
    });

    it('should have 15% trailing stop', () => {
      expect(config.takeProfitStrategy.trailingStopPercent).toBe(0.15);
    });

    it('should have +50% initial recovery trigger', () => {
      expect(config.takeProfitStrategy.initialRecovery.triggerPercent).toBe(0.50);
    });

    it('should have 20% scaled exit sell percent', () => {
      expect(config.takeProfitStrategy.scaledExits.sellPercent).toBe(0.20);
    });
  });

  describe('Stop Loss', () => {
    const entryPrice = 0.001; // 0.001 SOL per token

    it('should NOT trigger at -11% loss', () => {
      const currentPrice = entryPrice * 0.89; // -11%
      expect(shouldTriggerStopLoss(currentPrice, entryPrice)).toBe(false);
    });

    it('should trigger at exactly -12% loss', () => {
      const currentPrice = entryPrice * 0.88; // -12%
      expect(shouldTriggerStopLoss(currentPrice, entryPrice)).toBe(true);
    });

    it('should trigger at -20% loss', () => {
      const currentPrice = entryPrice * 0.80; // -20%
      expect(shouldTriggerStopLoss(currentPrice, entryPrice)).toBe(true);
    });

    it('should NOT trigger when in profit', () => {
      const currentPrice = entryPrice * 1.5; // +50%
      expect(shouldTriggerStopLoss(currentPrice, entryPrice)).toBe(false);
    });
  });

  describe('Initial Recovery (+50%)', () => {
    const entryPrice = 0.001;

    it('should NOT trigger at +40%', () => {
      const currentPrice = entryPrice * 1.40;
      expect(shouldTriggerInitialRecovery(currentPrice, entryPrice, false)).toBe(false);
    });

    it('should trigger at exactly +50%', () => {
      const currentPrice = entryPrice * 1.50;
      expect(shouldTriggerInitialRecovery(currentPrice, entryPrice, false)).toBe(true);
    });

    it('should trigger at +60%', () => {
      const currentPrice = entryPrice * 1.60;
      expect(shouldTriggerInitialRecovery(currentPrice, entryPrice, false)).toBe(true);
    });

    it('should NOT trigger if already recovered', () => {
      const currentPrice = entryPrice * 1.50;
      expect(shouldTriggerInitialRecovery(currentPrice, entryPrice, true)).toBe(false);
    });
  });

  describe('Trailing Stop', () => {
    it('should calculate 15% below current price', () => {
      const currentPrice = 0.002;
      const expectedStop = 0.002 * 0.85; // 15% below
      expect(calcTrailingStop(currentPrice)).toBeCloseTo(expectedStop, 10);
    });

    it('should trigger when price drops to trailing stop', () => {
      const trailingStop = 0.0017; // Set at $0.002 * 0.85
      const currentPrice = 0.0017;
      expect(shouldTriggerTrailingStop(currentPrice, trailingStop)).toBe(true);
    });

    it('should trigger when price drops below trailing stop', () => {
      const trailingStop = 0.0017;
      const currentPrice = 0.0015;
      expect(shouldTriggerTrailingStop(currentPrice, trailingStop)).toBe(true);
    });

    it('should NOT trigger when price is above trailing stop', () => {
      const trailingStop = 0.0017;
      const currentPrice = 0.0020;
      expect(shouldTriggerTrailingStop(currentPrice, trailingStop)).toBe(false);
    });

    it('should NOT trigger if trailing stop not set', () => {
      const currentPrice = 0.0010;
      expect(shouldTriggerTrailingStop(currentPrice, undefined)).toBe(false);
    });
  });

  describe('Scaled Exits', () => {
    const entryPrice = 0.001;

    it('should have 0 exits at +50% (just recovered)', () => {
      const currentPrice = entryPrice * 1.50; // +50%
      expect(calcScaledExits(currentPrice, entryPrice)).toBe(0);
    });

    it('should have 0 exits at +90% (not yet +100%)', () => {
      const currentPrice = entryPrice * 1.90; // +90%
      expect(calcScaledExits(currentPrice, entryPrice)).toBe(0);
    });

    it('should have 1 exit at +100% (50% + 50%)', () => {
      const currentPrice = entryPrice * 2.00; // +100%
      expect(calcScaledExits(currentPrice, entryPrice)).toBe(1);
    });

    it('should have 2 exits at +150% (50% + 50% + 50%)', () => {
      const currentPrice = entryPrice * 2.50; // +150%
      expect(calcScaledExits(currentPrice, entryPrice)).toBe(2);
    });

    it('should have 3 exits at +200%', () => {
      const currentPrice = entryPrice * 3.00; // +200%
      expect(calcScaledExits(currentPrice, entryPrice)).toBe(3);
    });
  });

  describe('Full Scenario: Moon Mission', () => {
    const entryPrice = 0.001;
    const initialAmount = 1000000; // 1M tokens
    const initialInvestment = 1.0; // 1 SOL

    it('should properly handle a 3x pump', () => {
      // Start: entry at 0.001
      let currentPrice = entryPrice;
      let amount = initialAmount;
      let initialRecovered = false;
      let trailingStop: number | undefined;
      let scaledExitsTaken = 0;

      // Price pumps to +50% (1.5x)
      currentPrice = entryPrice * 1.50;
      expect(shouldTriggerStopLoss(currentPrice, entryPrice)).toBe(false);
      expect(shouldTriggerInitialRecovery(currentPrice, entryPrice, initialRecovered)).toBe(true);

      // Simulate recovery: sell enough to recover 1 SOL
      const sellAmount = initialInvestment / currentPrice; // 666,666 tokens
      amount -= sellAmount;
      initialRecovered = true;
      trailingStop = calcTrailingStop(currentPrice);

      expect(amount).toBeCloseTo(333333.33, 0);
      expect(trailingStop).toBeCloseTo(0.001275, 6);

      // Price continues to +100% (2x)
      currentPrice = entryPrice * 2.00;
      trailingStop = calcTrailingStop(currentPrice); // Update trailing
      expect(shouldTriggerTrailingStop(currentPrice, trailingStop)).toBe(false);
      expect(calcScaledExits(currentPrice, entryPrice)).toBe(1);

      // Take scaled exit: sell 20% of remaining
      const scaledSellAmount = amount * 0.20;
      amount -= scaledSellAmount;
      scaledExitsTaken++;

      expect(amount).toBeCloseTo(266666.67, 0);
      expect(scaledExitsTaken).toBe(1);

      // Price dumps to trailing stop
      trailingStop = calcTrailingStop(entryPrice * 2.00); // 0.0017
      currentPrice = 0.0016; // Below trailing stop
      expect(shouldTriggerTrailingStop(currentPrice, trailingStop)).toBe(true);
    });
  });
});
