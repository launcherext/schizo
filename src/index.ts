import { logger, createLogger } from './lib/logger.js';
import { encrypt, decrypt, createKeystore, saveKeystore, loadKeystore } from './keystore/index.js';
import { createDatabase } from './db/database.js';
import { TradeRepository } from './db/repositories/trades.js';
import { StateRepository } from './db/repositories/state.js';
import { TTLCache } from './api/cache.js';
import { createRateLimiter, getConfigForTier } from './api/rate-limiter.js';
import * as fs from 'fs';

// Create module-specific logger
const log = createLogger('main');

// Log startup
logger.info('Agent starting...');

// Test redaction - privateKey should show as [REDACTED]
logger.info({
  wallet: {
    publicKey: 'ABC123xyz...',
    privateKey: 'THIS_SHOULD_BE_REDACTED'
  }
}, 'Testing secret redaction');

// Also test direct privateKey field
logger.info({
  privateKey: 'ALSO_SHOULD_BE_REDACTED',
  secretKey: 'SECRET_REDACTED_TOO',
  password: 'PASSWORD_HIDDEN',
  normalField: 'this is visible'
}, 'Direct field redaction test');

// === Test AES-256-GCM Encryption ===
log.info('Testing encryption module...');

const testSecret = 'test-secret';
const testPassword = 'test-password';
const wrongPassword = 'wrong-password';

// Test 1: Encrypt and decrypt roundtrip
const encrypted = encrypt(testSecret, testPassword);
log.info({
  hasAllFields: !!(encrypted.salt && encrypted.iv && encrypted.authTag && encrypted.encrypted)
}, 'Encrypted data created');

const decrypted = decrypt(encrypted, testPassword);
if (decrypted === testSecret) {
  log.info('Encryption/decryption roundtrip: PASSED');
} else {
  log.error('Encryption/decryption roundtrip: FAILED');
  process.exit(1);
}

// Test 2: Wrong password should throw
try {
  decrypt(encrypted, wrongPassword);
  log.error('Wrong password test: FAILED (should have thrown)');
  process.exit(1);
} catch (error) {
  if (error instanceof Error && error.message.includes('invalid password')) {
    log.info('Wrong password detection: PASSED');
  } else {
    log.error({ error }, 'Wrong password test: FAILED (wrong error)');
    process.exit(1);
  }
}

// ===========================================
// Keystore Tests
// ===========================================
const TEST_KEYSTORE_PATH = 'test-keystore.json';
log.info('Starting keystore tests...');

// Test 1: Create new keystore
const keystorePassword = 'test-keystore-password';
const { keypair: originalKeypair, keystore } = createKeystore(keystorePassword);
log.info({ publicKey: originalKeypair.publicKey.toBase58() }, 'Keystore created');

// Test 2: Save keystore to file
saveKeystore(keystore, TEST_KEYSTORE_PATH);
log.info('Keystore saved to file');

// Test 3: Verify file exists and contains encrypted data (no plaintext key)
const keystoreContent = fs.readFileSync(TEST_KEYSTORE_PATH, 'utf8');
const keystoreJson = JSON.parse(keystoreContent);
if (keystoreJson.version !== 1) {
  throw new Error('Keystore version mismatch');
}
if (!keystoreJson.encryptedPrivateKey || !keystoreJson.encryptedPrivateKey.salt) {
  throw new Error('Keystore missing encrypted data');
}
// Verify no plaintext key in file
if (keystoreContent.includes(originalKeypair.secretKey.toString())) {
  throw new Error('Keystore contains plaintext private key!');
}
log.info('Keystore file contains only encrypted data: PASSED');

// Test 4: Load keystore with correct password
const loadedKeypair = loadKeystore(TEST_KEYSTORE_PATH, keystorePassword);
if (loadedKeypair.publicKey.toBase58() !== originalKeypair.publicKey.toBase58()) {
  throw new Error('Loaded keypair public key mismatch');
}
log.info('Keystore load with correct password: PASSED');

// Test 5: Verify loaded keypair has same secret key (can sign)
const originalSecretStr = originalKeypair.secretKey.toString();
const loadedSecretStr = loadedKeypair.secretKey.toString();
if (originalSecretStr !== loadedSecretStr) {
  throw new Error('Loaded keypair secret key mismatch');
}
log.info('Loaded keypair secret key matches: PASSED');

// Test 6: Wrong password should fail
try {
  loadKeystore(TEST_KEYSTORE_PATH, 'wrong-password');
  log.error('Wrong password should have thrown');
  process.exit(1);
} catch (error) {
  if (error instanceof Error && error.message.includes('invalid password')) {
    log.info('Keystore wrong password detection: PASSED');
  } else {
    log.error({ error }, 'Wrong error for wrong password');
    process.exit(1);
  }
}

// Cleanup test keystore
fs.unlinkSync(TEST_KEYSTORE_PATH);
log.info('Test keystore cleaned up');

// ===========================================
// Database Tests
// ===========================================
const TEST_DB_PATH = 'test-agent.db';

log.info('Starting database tests...');

// Test 1: Create database with WAL mode
const db = createDatabase(TEST_DB_PATH);

// Verify WAL mode is enabled
const journalMode = db.pragma('journal_mode', { simple: true });
log.info({ journalMode }, 'Journal mode check');
if (journalMode !== 'wal') {
  throw new Error(`Expected WAL mode, got: ${journalMode}`);
}
log.info('WAL mode verified');

// Test 2: Verify all tables exist
const tables = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type='table' AND name NOT LIKE 'sqlite_%'
  ORDER BY name
`).all() as { name: string }[];

const tableNames = tables.map(t => t.name);
log.info({ tables: tableNames }, 'Tables found');

const expectedTables = ['agent_state', 'analysis_cache', 'config', 'pnl_snapshots', 'trades'];
for (const expected of expectedTables) {
  if (!tableNames.includes(expected)) {
    throw new Error(`Missing table: ${expected}`);
  }
}
log.info('All 5 tables verified');

// Test 3: Verify indexes exist
const indexes = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type='index' AND name NOT LIKE 'sqlite_%'
  ORDER BY name
`).all() as { name: string }[];

const indexNames = indexes.map(i => i.name);
log.info({ indexes: indexNames }, 'Indexes found');

// Test 4: Test TradeRepository
const tradeRepo = new TradeRepository(db);

const testTrade = {
  signature: 'test-sig-123',
  timestamp: Math.floor(Date.now() / 1000),
  type: 'BUY' as const,
  tokenMint: 'So11111111111111111111111111111111111111112',
  tokenSymbol: 'SOL',
  amountTokens: 100,
  amountSol: 1.5,
  pricePerToken: 0.015,
  feeSol: 0.000005,
  metadata: { source: 'test', note: 'Test trade' }
};

tradeRepo.insert(testTrade);
log.info('Trade inserted');

const retrieved = tradeRepo.getBySignature('test-sig-123');
if (!retrieved || retrieved.tokenMint !== testTrade.tokenMint) {
  throw new Error('Trade retrieval failed');
}
log.info({ trade: retrieved }, 'Trade retrieved successfully');

// Test 5: Test StateRepository
const stateRepo = new StateRepository(db);

stateRepo.setState('last_run', new Date().toISOString());
const lastRun = stateRepo.getState('last_run');
if (!lastRun) {
  throw new Error('State retrieval failed');
}
log.info({ lastRun }, 'State set and retrieved');

// Test 6: Test P&L snapshot with JSON token holdings
const pnlSnapshot = {
  timestamp: Math.floor(Date.now() / 1000),
  totalValueSol: 10.5,
  realizedPnlSol: 0.5,
  unrealizedPnlSol: 0.3,
  tokenHoldings: {
    'So11111111111111111111111111111111111111112': 100,
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 500
  }
};

stateRepo.savePnLSnapshot(pnlSnapshot);
const latestSnapshot = stateRepo.getLatestPnLSnapshot();
if (!latestSnapshot || Object.keys(latestSnapshot.tokenHoldings).length !== 2) {
  throw new Error('P&L snapshot with JSON failed');
}
log.info({ snapshot: latestSnapshot }, 'P&L snapshot saved and retrieved with JSON');

// Test 7: Close and reopen to verify persistence
db.close();
log.info('Database closed');

const db2 = createDatabase(TEST_DB_PATH);
const tradeRepo2 = new TradeRepository(db2);
const stateRepo2 = new StateRepository(db2);

const persistedTrade = tradeRepo2.getBySignature('test-sig-123');
const persistedState = stateRepo2.getState('last_run');
const persistedSnapshot = stateRepo2.getLatestPnLSnapshot();

if (!persistedTrade || !persistedState || !persistedSnapshot) {
  throw new Error('Data did not persist after close/reopen');
}
log.info('Data persisted across database close/reopen');

// Cleanup
db2.close();
fs.unlinkSync(TEST_DB_PATH);
try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
log.info('Test database cleaned up');

// ===========================================
// Cache and Rate Limiter Tests
// ===========================================
log.info('Starting cache and rate limiter tests...');

// Test 1: TTLCache with 100ms TTL
const cache = new TTLCache<string>(100); // 100ms TTL
cache.set('test-key', 'test-value');

const immediateValue = cache.get('test-key');
if (immediateValue !== 'test-value') {
  throw new Error('Cache immediate retrieval failed');
}
log.info('Cache immediate retrieval: PASSED');

// Test 2: Cache expiration after 150ms
await new Promise(resolve => setTimeout(resolve, 150));
const expiredValue = cache.get('test-key');
if (expiredValue !== undefined) {
  throw new Error('Cache expiration failed - should be undefined');
}
log.info('Cache TTL expiration: PASSED');

// Test 3: Cache statistics
const stats = cache.getStats();
log.info({ stats }, 'Cache stats');
if (stats.hits !== 1 || stats.misses !== 1) {
  throw new Error(`Cache stats unexpected: hits=${stats.hits}, misses=${stats.misses}`);
}
log.info('Cache statistics tracking: PASSED');

// Test 4: Rate limiter configuration for developer tier
const tierConfig = getConfigForTier('developer');
log.info({ tierConfig }, 'Developer tier configuration');
if (tierConfig.rpc.maxConcurrent !== 10 || tierConfig.enhanced.maxConcurrent !== 5) {
  throw new Error('Tier configuration unexpected');
}
log.info('Tier configuration: PASSED');

// Test 5: Create rate limiter and schedule concurrent tasks
const limiter = createRateLimiter(tierConfig.rpc, 'test-rpc');

const startTime = Date.now();
const results = await Promise.all([
  limiter.schedule(() => Promise.resolve('task-1')),
  limiter.schedule(() => Promise.resolve('task-2')),
  limiter.schedule(() => Promise.resolve('task-3')),
  limiter.schedule(() => Promise.resolve('task-4')),
  limiter.schedule(() => Promise.resolve('task-5')),
]);

const duration = Date.now() - startTime;
log.info({ duration, results }, 'Rate limiter concurrent tasks completed');

if (results.length !== 5 || results[0] !== 'task-1') {
  throw new Error('Rate limiter task execution failed');
}
log.info('Rate limiter concurrent execution: PASSED');

// Log completion
log.info('Agent initialized');
logger.info('All tests passed - startup complete');
