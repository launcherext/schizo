// Test setup - mock environment variables
process.env.HELIUS_API_KEY = 'test-api-key';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.PAPER_TRADING = 'true';
process.env.INITIAL_CAPITAL_SOL = '1.0';

// Suppress logger output during tests
jest.mock('../utils/logger', () => ({
  createChildLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
