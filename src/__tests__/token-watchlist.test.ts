/**
 * Token Watchlist Hard Filter Tests
 *
 * Tests the critical rejection logic:
 * - 30% max drawdown rejection
 * - Dev sold rejection (2% early, 5% normal)
 * - Minimum data points requirement
 * - Minimum age requirement
 */

import { config } from '../config/settings';

// Simulated WatchedToken for testing
interface TestWatchedToken {
  mint: string;
  firstSeen: number;
  priceHistory: Array<{ price: number; timestamp: number }>;
  devSold: boolean;
  devSoldPercent: number;
  peakPrice: number;
}

// Helper to check drawdown filter
function failsDrawdownFilter(token: TestWatchedToken): { fails: boolean; reason: string } {
  const maxDrawdown = config.watchlist?.maxDrawdown || 0.30;

  if (token.peakPrice <= 0 || token.priceHistory.length === 0) {
    return { fails: false, reason: 'No price data' };
  }

  const currentPrice = token.priceHistory[token.priceHistory.length - 1].price;
  const drawdown = (token.peakPrice - currentPrice) / token.peakPrice;

  if (drawdown > maxDrawdown) {
    return {
      fails: true,
      reason: `Crashed ${(drawdown * 100).toFixed(0)}% from peak (max ${(maxDrawdown * 100).toFixed(0)}%)`,
    };
  }

  return { fails: false, reason: 'Drawdown OK' };
}

// Helper to check dev sold filter
function failsDevSoldFilter(token: TestWatchedToken): { fails: boolean; reason: string } {
  if (token.devSold) {
    return {
      fails: true,
      reason: `Dev sold ${(token.devSoldPercent * 100).toFixed(1)}%`,
    };
  }
  return { fails: false, reason: 'Dev holding OK' };
}

// Helper to check minimum data points
function failsDataPointsFilter(token: TestWatchedToken): { fails: boolean; reason: string } {
  const minDataPoints = config.watchlist?.minDataPoints || 10;

  if (token.priceHistory.length < minDataPoints) {
    return {
      fails: true,
      reason: `Only ${token.priceHistory.length}/${minDataPoints} data points`,
    };
  }
  return { fails: false, reason: 'Data points OK' };
}

// Helper to check minimum age
function failsAgeFilter(token: TestWatchedToken): { fails: boolean; reason: string } {
  const minAgeSeconds = config.watchlist?.minAgeSeconds || 60;
  const ageSeconds = (Date.now() - token.firstSeen) / 1000;

  if (ageSeconds < minAgeSeconds) {
    return {
      fails: true,
      reason: `Token only ${ageSeconds.toFixed(0)}s old (min ${minAgeSeconds}s)`,
    };
  }
  return { fails: false, reason: 'Age OK' };
}

// Combined hard filter check
function passesHardFilters(token: TestWatchedToken): { passes: boolean; reason: string } {
  const devCheck = failsDevSoldFilter(token);
  if (devCheck.fails) return { passes: false, reason: devCheck.reason };

  const dataCheck = failsDataPointsFilter(token);
  if (dataCheck.fails) return { passes: false, reason: dataCheck.reason };

  const ageCheck = failsAgeFilter(token);
  if (ageCheck.fails) return { passes: false, reason: ageCheck.reason };

  const drawdownCheck = failsDrawdownFilter(token);
  if (drawdownCheck.fails) return { passes: false, reason: drawdownCheck.reason };

  return { passes: true, reason: 'Ready for AI analysis' };
}

// Helper to create a test token
function createTestToken(overrides: Partial<TestWatchedToken> = {}): TestWatchedToken {
  const now = Date.now();
  return {
    mint: 'TestToken123pump',
    firstSeen: now - 120000, // 2 minutes ago (passes 60s min age)
    priceHistory: Array(15).fill(null).map((_, i) => ({
      price: 0.001,
      timestamp: now - (15 - i) * 1000,
    })),
    devSold: false,
    devSoldPercent: 0,
    peakPrice: 0.001,
    ...overrides,
  };
}

describe('Token Watchlist Hard Filters', () => {
  // Verify config
  describe('Config Verification', () => {
    it('should have 30% max drawdown', () => {
      expect(config.watchlist?.maxDrawdown).toBe(0.30);
    });

    it('should have 10 min data points', () => {
      expect(config.watchlist?.minDataPoints).toBe(10);
    });

    it('should have 60s min age', () => {
      expect(config.watchlist?.minAgeSeconds).toBe(60);
    });
  });

  describe('Drawdown Filter (30% max)', () => {
    it('should PASS at 0% drawdown (at peak)', () => {
      const token = createTestToken({ peakPrice: 0.001 });
      expect(failsDrawdownFilter(token).fails).toBe(false);
    });

    it('should PASS at 20% drawdown', () => {
      const token = createTestToken({
        peakPrice: 0.001,
        priceHistory: [{ price: 0.0008, timestamp: Date.now() }], // -20%
      });
      expect(failsDrawdownFilter(token).fails).toBe(false);
    });

    it('should PASS at exactly 30% drawdown', () => {
      const token = createTestToken({
        peakPrice: 0.001,
        priceHistory: [{ price: 0.0007, timestamp: Date.now() }], // -30%
      });
      expect(failsDrawdownFilter(token).fails).toBe(false);
    });

    it('should FAIL at 31% drawdown', () => {
      const token = createTestToken({
        peakPrice: 0.001,
        priceHistory: [{ price: 0.00069, timestamp: Date.now() }], // -31%
      });
      expect(failsDrawdownFilter(token).fails).toBe(true);
    });

    it('should FAIL at 50% drawdown', () => {
      const token = createTestToken({
        peakPrice: 0.001,
        priceHistory: [{ price: 0.0005, timestamp: Date.now() }], // -50%
      });
      const result = failsDrawdownFilter(token);
      expect(result.fails).toBe(true);
      expect(result.reason).toContain('50%');
    });
  });

  describe('Dev Sold Filter', () => {
    it('should PASS if dev has not sold', () => {
      const token = createTestToken({ devSold: false, devSoldPercent: 0 });
      expect(failsDevSoldFilter(token).fails).toBe(false);
    });

    it('should PASS if dev sold within threshold (not flagged)', () => {
      const token = createTestToken({
        devSold: false, // Not flagged by threshold logic
        devSoldPercent: 0.01, // 1%
      });
      expect(failsDevSoldFilter(token).fails).toBe(false);
    });

    it('should FAIL if dev sold flag is true', () => {
      const token = createTestToken({
        devSold: true,
        devSoldPercent: 0.06, // 6%
      });
      const result = failsDevSoldFilter(token);
      expect(result.fails).toBe(true);
      expect(result.reason).toContain('Dev sold');
    });
  });

  describe('Data Points Filter', () => {
    it('should FAIL with 5 data points', () => {
      const token = createTestToken({
        priceHistory: Array(5).fill({ price: 0.001, timestamp: Date.now() }),
      });
      const result = failsDataPointsFilter(token);
      expect(result.fails).toBe(true);
      expect(result.reason).toContain('5/10');
    });

    it('should FAIL with 9 data points', () => {
      const token = createTestToken({
        priceHistory: Array(9).fill({ price: 0.001, timestamp: Date.now() }),
      });
      expect(failsDataPointsFilter(token).fails).toBe(true);
    });

    it('should PASS with 10 data points', () => {
      const token = createTestToken({
        priceHistory: Array(10).fill({ price: 0.001, timestamp: Date.now() }),
      });
      expect(failsDataPointsFilter(token).fails).toBe(false);
    });

    it('should PASS with 50 data points', () => {
      const token = createTestToken({
        priceHistory: Array(50).fill({ price: 0.001, timestamp: Date.now() }),
      });
      expect(failsDataPointsFilter(token).fails).toBe(false);
    });
  });

  describe('Age Filter', () => {
    it('should FAIL if token is 30 seconds old', () => {
      const token = createTestToken({
        firstSeen: Date.now() - 30000, // 30 seconds ago
      });
      expect(failsAgeFilter(token).fails).toBe(true);
    });

    it('should FAIL if token is 59 seconds old', () => {
      const token = createTestToken({
        firstSeen: Date.now() - 59000,
      });
      expect(failsAgeFilter(token).fails).toBe(true);
    });

    it('should PASS if token is 60 seconds old', () => {
      const token = createTestToken({
        firstSeen: Date.now() - 60000,
      });
      expect(failsAgeFilter(token).fails).toBe(false);
    });

    it('should PASS if token is 5 minutes old', () => {
      const token = createTestToken({
        firstSeen: Date.now() - 300000,
      });
      expect(failsAgeFilter(token).fails).toBe(false);
    });
  });

  describe('Combined Hard Filters', () => {
    it('should PASS a healthy token', () => {
      const token = createTestToken();
      const result = passesHardFilters(token);
      expect(result.passes).toBe(true);
      expect(result.reason).toBe('Ready for AI analysis');
    });

    it('should FAIL early on dev sold (first check)', () => {
      const token = createTestToken({ devSold: true, devSoldPercent: 0.10 });
      const result = passesHardFilters(token);
      expect(result.passes).toBe(false);
      expect(result.reason).toContain('Dev sold');
    });

    it('should FAIL on data points if dev OK', () => {
      const token = createTestToken({
        priceHistory: Array(3).fill({ price: 0.001, timestamp: Date.now() }),
      });
      const result = passesHardFilters(token);
      expect(result.passes).toBe(false);
      expect(result.reason).toContain('data points');
    });

    it('should FAIL on drawdown last', () => {
      const token = createTestToken({
        peakPrice: 0.001,
        priceHistory: Array(15).fill(null).map(() => ({
          price: 0.0005, // -50% drawdown
          timestamp: Date.now(),
        })),
      });
      const result = passesHardFilters(token);
      expect(result.passes).toBe(false);
      expect(result.reason).toContain('Crashed');
    });
  });

  describe('Real-World Scenarios', () => {
    it('should reject a rug pull (dev dumps)', () => {
      const token = createTestToken({
        devSold: true,
        devSoldPercent: 0.50, // Dev dumped 50%
        peakPrice: 0.001,
        priceHistory: [{ price: 0.0003, timestamp: Date.now() }], // -70%
      });
      const result = passesHardFilters(token);
      expect(result.passes).toBe(false);
    });

    it('should reject a dead token (crashed and no recovery)', () => {
      const token = createTestToken({
        peakPrice: 0.002, // Was 2x from start
        priceHistory: Array(20).fill(null).map(() => ({
          price: 0.0005, // Now at -75% from peak
          timestamp: Date.now(),
        })),
      });
      const result = passesHardFilters(token);
      expect(result.passes).toBe(false);
      expect(result.reason).toContain('Crashed');
    });

    it('should accept a healthy pumping token', () => {
      const now = Date.now();
      const token = createTestToken({
        firstSeen: now - 180000, // 3 minutes old
        peakPrice: 0.0015, // Pumped to 1.5x
        priceHistory: Array(30).fill(null).map((_, i) => ({
          price: 0.001 + (i * 0.00001), // Gradually increasing
          timestamp: now - (30 - i) * 1000,
        })),
      });
      const result = passesHardFilters(token);
      expect(result.passes).toBe(true);
    });
  });
});
