# Phase 1: Foundation & Security - Research

**Researched:** 2026-01-20
**Confidence:** HIGH (verified via official docs and multiple sources)

---

## Executive Summary

This phase establishes the secure foundation for a Solana trading agent: encrypted wallet management, persistent state storage, and efficient Helius API access. The research confirms all requirements are achievable with well-supported libraries. Key recommendations:

- **Wallet:** Use `@solana/web3.js` v1.x (stable) with Node.js crypto for AES-256-GCM encryption
- **Database:** `better-sqlite3` with WAL mode for high-performance local storage
- **API Client:** Helius SDK with `bottleneck` rate limiter and custom caching layer
- **Logging:** `pino` for structured JSON logs with built-in secret redaction

---

## 1. Solana Wallet Management

### Library Choice: @solana/web3.js

**Recommended Version:** `@solana/web3.js@1.x` (stable, well-documented)

**Note on v2 (Solana Kit):** Version 2.0 exists with `KeyPairSigner` and `generateKeyPairSigner()` but the ecosystem is still transitioning. For production stability, use v1.x unless you need v2-specific features.

**Installation:**
```bash
npm install @solana/web3.js@1.95.8
```

### Keypair Handling (v1.x)

```typescript
import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as fs from 'fs';

// Generate new keypair
const keypair = Keypair.generate();
console.log('Public Key:', keypair.publicKey.toBase58());
// keypair.secretKey is a Uint8Array (64 bytes)

// Load from file (Solana CLI format - JSON array of bytes)
const secretKeyArray = JSON.parse(fs.readFileSync('wallet.json', 'utf-8'));
const loadedKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));

// Load from base58 string
import bs58 from 'bs58';
const secretKeyBase58 = 'your-base58-private-key';
const keypairFromBase58 = Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
```

### Transaction Signing

```typescript
import {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  PublicKey,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';

// Create connection (use Helius for production)
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Create a simple transfer transaction
const transaction = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: new PublicKey('recipient-address'),
    lamports: 0.001 * LAMPORTS_PER_SOL,
  })
);

// Sign and send
const signature = await sendAndConfirmTransaction(
  connection,
  transaction,
  [keypair], // signers array
  { commitment: 'confirmed' }
);
```

### Devnet Testing & Airdrop

```typescript
// Request airdrop on devnet (rate limited: ~5 SOL/day)
const airdropSignature = await connection.requestAirdrop(
  keypair.publicKey,
  1 * LAMPORTS_PER_SOL
);
await connection.confirmTransaction(airdropSignature);

// Alternative faucets if rate limited:
// - https://faucet.solana.com (official, 5 SOL 2x/hour)
// - Helius faucet
// - Chainstack faucet
```

**Sources:**
- [Keypair Documentation](https://solana-foundation.github.io/solana-web3.js/classes/Keypair.html)
- [Solana Faucets Guide](https://solana.com/developers/guides/getstarted/solana-token-airdrop-and-faucets)
- [Helius Web3.js 2.0 Guide](https://www.helius.dev/blog/how-to-start-building-with-the-solana-web3-js-2-0-sdk)

---

## 2. Encryption: AES-256-GCM with PBKDF2

### Why AES-256-GCM?

- **Authenticated encryption:** Provides confidentiality AND integrity (detects tampering)
- **Built into Node.js:** No external dependencies via `crypto` module
- **Industry standard:** Widely recommended for encrypting sensitive data at rest

### Key Derivation: PBKDF2

```typescript
import * as crypto from 'crypto';

interface EncryptedData {
  salt: string;      // Base64, 64 bytes
  iv: string;        // Base64, 16 bytes
  authTag: string;   // Base64, 16 bytes
  encrypted: string; // Base64
}

const PBKDF2_ITERATIONS = 100000; // Higher = more secure, slower
const KEY_LENGTH = 32; // 256 bits for AES-256
const SALT_LENGTH = 64;
const IV_LENGTH = 16; // 96 bits recommended for GCM, but 128 bits works

function encrypt(plaintext: string, masterPassword: string): EncryptedData {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  // Derive key from password
  const key = crypto.pbkdf2Sync(
    masterPassword,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha512'
  );

  // Encrypt
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    encrypted: encrypted.toString('base64')
  };
}

function decrypt(data: EncryptedData, masterPassword: string): string {
  const salt = Buffer.from(data.salt, 'base64');
  const iv = Buffer.from(data.iv, 'base64');
  const authTag = Buffer.from(data.authTag, 'base64');
  const encrypted = Buffer.from(data.encrypted, 'base64');

  // Derive same key
  const key = crypto.pbkdf2Sync(
    masterPassword,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha512'
  );

  // Decrypt
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(encrypted) + decipher.final('utf8');
}
```

### Keystore File Format

```typescript
interface KeystoreFile {
  version: 1;
  publicKey: string;  // Base58 public key (safe to store unencrypted)
  encryptedPrivateKey: EncryptedData;
  createdAt: string;  // ISO timestamp
}

// Save keystore
function saveKeystore(
  keypair: Keypair,
  masterPassword: string,
  filepath: string
): void {
  const privateKeyBase58 = bs58.encode(keypair.secretKey);
  const encrypted = encrypt(privateKeyBase58, masterPassword);

  const keystore: KeystoreFile = {
    version: 1,
    publicKey: keypair.publicKey.toBase58(),
    encryptedPrivateKey: encrypted,
    createdAt: new Date().toISOString()
  };

  fs.writeFileSync(filepath, JSON.stringify(keystore, null, 2));
}

// Load keystore
function loadKeystore(filepath: string, masterPassword: string): Keypair {
  const keystore: KeystoreFile = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  const privateKeyBase58 = decrypt(keystore.encryptedPrivateKey, masterPassword);
  return Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
}
```

### Security Best Practices

1. **Never log the private key** - Not even partially masked
2. **Clear sensitive data from memory** - Set to null/zero after use
3. **Use high iteration count** - 100,000+ for PBKDF2 (balance security vs startup time)
4. **Random salt per encryption** - Already handled above
5. **Validate before decrypt** - Check file exists, version matches
6. **Fail fast on wrong password** - GCM auth tag will fail, throw immediately

**Sources:**
- [Node.js Crypto AES-GCM Gist](https://gist.github.com/AndiDittrich/4629e7db04819244e843)
- [Node.js Crypto Documentation](https://nodejs.org/api/crypto.html)

---

## 3. Helius API Integration

### Rate Limits by Tier

| Plan | Monthly Cost | Credits | RPC Limit | Enhanced APIs |
|------|-------------|---------|-----------|---------------|
| Free | $0 | 1M | 10 req/s | 2 req/s |
| Developer | $49 | 10M | 50 req/s | 10 req/s |
| Business | $499 | 100M | 200 req/s | 50 req/s |
| Professional | $999 | 200M | 500 req/s | 100 req/s |

**Credit Costs:**
- Standard RPC calls: 1 credit
- `getTransactionsForAddress`: 100 credits per request
- Enhanced Transactions API: 10-100 credits depending on method

### SDK Installation

```bash
npm install helius-sdk
```

### Basic Setup

```typescript
import Helius from 'helius-sdk';

const helius = new Helius('your-api-key');

// For RPC calls
const connection = helius.connection;
```

### getTransactionsForAddress API

This is the key API for tracking wallet activity. It combines `getSignaturesForAddress` and `getTransaction` into one efficient call.

**Request Format:**
```typescript
const response = await fetch('https://mainnet.helius-rpc.com/?api-key=YOUR_KEY', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getTransactionsForAddress',
    params: [
      'WALLET_ADDRESS',
      {
        transactionDetails: 'full',  // or 'signatures' for lighter response
        sortOrder: 'desc',           // 'asc' or 'desc'
        limit: 100,                  // max 100 for full, 1000 for signatures
        filters: {
          blockTime: {
            gte: 1704067200,  // Unix timestamp - filter by time range
            lte: 1735689600
          },
          status: 'succeeded'  // 'succeeded', 'failed', or 'any'
        }
      }
    ]
  })
});

const data = await response.json();
// data.result.data = array of transactions
// data.result.paginationToken = use for next page
```

**Pagination:**
```typescript
async function getAllTransactions(address: string): Promise<Transaction[]> {
  const all: Transaction[] = [];
  let paginationToken: string | null = null;

  do {
    const result = await helius.rpc.getTransactionsForAddress(address, {
      limit: 100,
      paginationToken
    });
    all.push(...result.data);
    paginationToken = result.paginationToken;
  } while (paginationToken);

  return all;
}
```

### Enhanced Transactions API

For human-readable transaction parsing (swaps, NFT sales, transfers):

```typescript
// Parse specific transactions by signature
const signatures = ['sig1', 'sig2', 'sig3'];
const parsed = await helius.parseTransactions({ transactions: signatures });

// Returns structured data:
// - type: 'SWAP', 'TRANSFER', 'NFT_SALE', etc.
// - source: 'JUPITER', 'RAYDIUM', etc.
// - tokenTransfers: detailed token movements
// - nativeTransfers: SOL movements
```

**Sources:**
- [Helius Plans and Rate Limits](https://www.helius.dev/docs/billing/plans-and-rate-limits)
- [getTransactionsForAddress Documentation](https://www.helius.dev/docs/rpc/gettransactionsforaddress)
- [Enhanced Transactions API](https://www.helius.dev/docs/enhanced-transactions)
- [Helius SDK GitHub](https://github.com/helius-labs/helius-sdk)

---

## 4. Rate Limiting with Bottleneck

### Installation

```bash
npm install bottleneck
```

### Configuration for Helius (Developer Tier Example)

```typescript
import Bottleneck from 'bottleneck';

// For Developer tier: 50 RPS for RPC, 10 RPS for Enhanced APIs
const rpcLimiter = new Bottleneck({
  maxConcurrent: 10,        // Max parallel requests
  minTime: 25,              // Min 25ms between requests = 40 RPS (safe margin)
  reservoir: 50,            // Start with 50 tokens
  reservoirRefreshAmount: 50,
  reservoirRefreshInterval: 1000  // Refill every second
});

const enhancedLimiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 120,             // ~8 RPS (safe margin under 10)
  reservoir: 10,
  reservoirRefreshAmount: 10,
  reservoirRefreshInterval: 1000
});

// Wrap API calls
const rateLimitedFetch = rpcLimiter.wrap(fetch);

// Or use schedule for more control
const result = await rpcLimiter.schedule(() =>
  fetch('https://mainnet.helius-rpc.com/?api-key=KEY', options)
);
```

### Handling 429 Errors

```typescript
rpcLimiter.on('failed', async (error, jobInfo) => {
  if (error.status === 429) {
    // Back off for 5 seconds
    console.warn('Rate limited, backing off...');
    return 5000; // Return delay in ms to retry
  }
  // Don't retry other errors
  return null;
});

rpcLimiter.on('retry', (error, jobInfo) => {
  console.log(`Retrying job ${jobInfo.options.id} after rate limit`);
});
```

**Sources:**
- [Bottleneck GitHub](https://github.com/SGrondin/bottleneck)
- [Bottleneck Rate Limiting Guide](https://dev.to/arifszn/prevent-api-overload-a-comprehensive-guide-to-rate-limiting-with-bottleneck-c2p)

---

## 5. Caching Layer

### In-Memory Cache with TTL

```typescript
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();

  constructor(private defaultTTL: number = 60000) {} // 1 minute default

  set(key: string, value: T, ttl?: number): void {
    this.cache.set(key, {
      data: value,
      expiresAt: Date.now() + (ttl ?? this.defaultTTL)
    });
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.cache.clear();
  }
}
```

### Cached Helius Client

```typescript
class CachedHeliusClient {
  private cache = new TTLCache<any>();
  private limiter: Bottleneck;

  constructor(
    private apiKey: string,
    private cacheTTL: number = 30000 // 30 seconds
  ) {
    this.limiter = new Bottleneck({
      maxConcurrent: 10,
      minTime: 25
    });
  }

  async getTransactionsForAddress(
    address: string,
    options?: { limit?: number; paginationToken?: string }
  ): Promise<any> {
    const cacheKey = `txs:${address}:${JSON.stringify(options)}`;

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Rate-limited fetch
    const result = await this.limiter.schedule(() =>
      this.fetchTransactions(address, options)
    );

    // Cache result (but not if paginating - partial results)
    if (!options?.paginationToken) {
      this.cache.set(cacheKey, result, this.cacheTTL);
    }

    return result;
  }

  private async fetchTransactions(
    address: string,
    options?: { limit?: number; paginationToken?: string }
  ): Promise<any> {
    const response = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransactionsForAddress',
          params: [address, { limit: options?.limit ?? 100, ...options }]
        })
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }
}
```

---

## 6. Exponential Backoff & Retry

### Using p-retry

```bash
npm install p-retry
```

```typescript
import pRetry from 'p-retry';

async function fetchWithRetry(url: string, options: RequestInit) {
  return pRetry(
    async () => {
      const response = await fetch(url, options);

      // Retry on rate limit or server errors
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`);
      }

      if (!response.ok) {
        // Don't retry client errors (400, 401, 403, 404)
        throw new pRetry.AbortError(`HTTP ${response.status}`);
      }

      return response.json();
    },
    {
      retries: 3,
      minTimeout: 1000,     // Start with 1s
      maxTimeout: 10000,    // Max 10s between retries
      factor: 2,            // Double each time
      onFailedAttempt: (error) => {
        console.log(
          `Attempt ${error.attemptNumber} failed. ` +
          `${error.retriesLeft} retries left.`
        );
      }
    }
  );
}
```

### Circuit Breaker with Opossum

```bash
npm install opossum
```

```typescript
import CircuitBreaker from 'opossum';

const options = {
  timeout: 10000,              // 10s timeout per call
  errorThresholdPercentage: 50, // Open after 50% failures
  resetTimeout: 30000,         // Try again after 30s
  volumeThreshold: 5           // Min calls before tripping
};

const breaker = new CircuitBreaker(fetchWithRetry, options);

breaker.on('open', () => {
  console.error('Circuit breaker OPEN - API appears down');
});

breaker.on('halfOpen', () => {
  console.log('Circuit breaker testing...');
});

breaker.on('close', () => {
  console.log('Circuit breaker CLOSED - API recovered');
});

// Use the breaker
try {
  const result = await breaker.fire(url, options);
} catch (error) {
  if (error.message === 'Breaker is open') {
    // Handle circuit open - use cached data or fail gracefully
  }
}
```

**Sources:**
- [p-retry GitHub](https://github.com/sindresorhus/p-retry)
- [Opossum Circuit Breaker](https://github.com/nodeshift/opossum)
- [Exponential Backoff Best Practices](https://hackernoon.com/the-token-bucket-algorithm-for-api-rate-limiting-in-nodejs-a-simple-guide)

---

## 7. SQLite with better-sqlite3

### Why better-sqlite3?

- **Synchronous API** - Simpler code, no callback hell
- **2-15x faster** than node-sqlite3
- **Full transaction support**
- **WAL mode** for better concurrent performance

### Installation

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

### Database Setup

```typescript
import Database from 'better-sqlite3';

const db = new Database('agent.db');

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Enable foreign keys
db.pragma('foreign_keys = ON');
```

### Schema for Trades & P&L

```typescript
function initializeSchema(db: Database.Database): void {
  db.exec(`
    -- Configuration table
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    -- Trades table
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT UNIQUE NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,           -- 'BUY' | 'SELL'
      token_mint TEXT NOT NULL,
      token_symbol TEXT,
      amount_tokens REAL NOT NULL,
      amount_sol REAL NOT NULL,
      price_per_token REAL NOT NULL,
      fee_sol REAL DEFAULT 0,
      status TEXT DEFAULT 'CONFIRMED',
      metadata TEXT,                -- JSON for extra data
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
    CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_mint);

    -- P&L snapshots
    CREATE TABLE IF NOT EXISTS pnl_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      total_value_sol REAL NOT NULL,
      realized_pnl_sol REAL NOT NULL,
      unrealized_pnl_sol REAL NOT NULL,
      token_holdings TEXT NOT NULL, -- JSON object
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_pnl_timestamp ON pnl_snapshots(timestamp);

    -- Analysis cache
    CREATE TABLE IF NOT EXISTS analysis_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      analysis_type TEXT NOT NULL,
      result TEXT NOT NULL,         -- JSON
      expires_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(address, analysis_type)
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_expires ON analysis_cache(expires_at);

    -- Agent state (for recovery)
    CREATE TABLE IF NOT EXISTS agent_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `);
}
```

### Trade Operations

```typescript
interface Trade {
  signature: string;
  timestamp: number;
  type: 'BUY' | 'SELL';
  tokenMint: string;
  tokenSymbol?: string;
  amountTokens: number;
  amountSol: number;
  pricePerToken: number;
  feeSol?: number;
  metadata?: Record<string, any>;
}

class TradeRepository {
  private insertStmt: Database.Statement;
  private getBySignatureStmt: Database.Statement;
  private getRecentStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO trades
        (signature, timestamp, type, token_mint, token_symbol,
         amount_tokens, amount_sol, price_per_token, fee_sol, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getBySignatureStmt = db.prepare(
      'SELECT * FROM trades WHERE signature = ?'
    );

    this.getRecentStmt = db.prepare(
      'SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?'
    );
  }

  insert(trade: Trade): void {
    this.insertStmt.run(
      trade.signature,
      trade.timestamp,
      trade.type,
      trade.tokenMint,
      trade.tokenSymbol ?? null,
      trade.amountTokens,
      trade.amountSol,
      trade.pricePerToken,
      trade.feeSol ?? 0,
      trade.metadata ? JSON.stringify(trade.metadata) : null
    );
  }

  getBySignature(signature: string): Trade | undefined {
    const row = this.getBySignatureStmt.get(signature) as any;
    return row ? this.mapRow(row) : undefined;
  }

  getRecent(limit: number = 100): Trade[] {
    const rows = this.getRecentStmt.all(limit) as any[];
    return rows.map(this.mapRow);
  }

  private mapRow(row: any): Trade {
    return {
      signature: row.signature,
      timestamp: row.timestamp,
      type: row.type,
      tokenMint: row.token_mint,
      tokenSymbol: row.token_symbol,
      amountTokens: row.amount_tokens,
      amountSol: row.amount_sol,
      pricePerToken: row.price_per_token,
      feeSol: row.fee_sol,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    };
  }
}
```

### Transaction Support

```typescript
// Batch insert with transaction
const insertMany = db.transaction((trades: Trade[]) => {
  for (const trade of trades) {
    tradeRepo.insert(trade);
  }
});

insertMany(tradesArray); // All-or-nothing
```

**Sources:**
- [better-sqlite3 GitHub](https://github.com/WiseLibs/better-sqlite3)
- [better-sqlite3 npm](https://www.npmjs.com/package/better-sqlite3)

---

## 8. Structured Logging with Pino

### Why Pino?

- **5x faster** than Winston
- **JSON output by default** - perfect for structured logs
- **Built-in secret redaction**
- **Low overhead** - won't slow down your agent

### Installation

```bash
npm install pino pino-pretty
```

### Setup with Secret Redaction

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',

  // Redact sensitive fields
  redact: {
    paths: [
      'privateKey',
      'secretKey',
      'password',
      'masterPassword',
      'apiKey',
      '*.privateKey',
      '*.secretKey'
    ],
    censor: '[REDACTED]'
  },

  // Pretty print in development
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty' }
    : undefined
});

// Child loggers for context
const tradeLogger = logger.child({ module: 'trades' });
const apiLogger = logger.child({ module: 'helius' });

// Usage
tradeLogger.info({
  signature: 'abc123',
  type: 'BUY',
  amount: 100
}, 'Trade executed');

apiLogger.warn({
  endpoint: 'getTransactionsForAddress',
  responseTime: 1234
}, 'Slow API response');

// This will be redacted
logger.info({ privateKey: 'secret123' }, 'Test');
// Output: { privateKey: '[REDACTED]', msg: 'Test' }
```

### Error Logging

```typescript
try {
  // risky operation
} catch (error) {
  logger.error({
    err: error,          // Pino serializes Error objects
    context: { ... }     // Add context
  }, 'Operation failed');
}
```

**Sources:**
- [Pino Logger Guide 2026](https://signoz.io/guides/pino-logger/)
- [Pino GitHub](https://github.com/pinojs/pino)

---

## 9. Recommended Package List

### Production Dependencies

```json
{
  "dependencies": {
    "@solana/web3.js": "^1.95.8",
    "bs58": "^5.0.0",
    "better-sqlite3": "^11.0.0",
    "bottleneck": "^2.19.5",
    "helius-sdk": "^2.0.0",
    "opossum": "^8.1.3",
    "p-retry": "^6.2.0",
    "pino": "^9.0.0"
  }
}
```

### Development Dependencies

```json
{
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.0.0",
    "pino-pretty": "^11.0.0",
    "typescript": "^5.0.0"
  }
}
```

---

## 10. Pitfalls to Avoid

### Security Pitfalls

| Pitfall | Prevention |
|---------|------------|
| Logging private keys | Use Pino redaction, review all log statements |
| Storing keys in env vars | Use encrypted keystore file, load at runtime |
| Hardcoding API keys | Use environment variables for API keys (not private keys) |
| Weak encryption | Use AES-256-GCM with PBKDF2 (100k+ iterations) |

### API Pitfalls

| Pitfall | Prevention |
|---------|------------|
| Rate limit errors | Use Bottleneck with conservative limits |
| No retry on transient errors | Use p-retry with exponential backoff |
| Infinite retries | Set max retries (3), use circuit breaker |
| Stale cache | Set appropriate TTL, invalidate on writes |

### Database Pitfalls

| Pitfall | Prevention |
|---------|------------|
| Slow writes | Enable WAL mode: `db.pragma('journal_mode = WAL')` |
| Lost data on crash | Use transactions for related writes |
| No indexes | Add indexes for timestamp, token_mint queries |
| Integer overflow | Use REAL for amounts, store lamports as INTEGER |

### Solana Pitfalls

| Pitfall | Prevention |
|---------|------------|
| Wrong network | Always verify connection cluster before signing |
| Insufficient SOL for fees | Check balance before transactions |
| Expired blockhash | Fetch fresh blockhash close to send time |
| Unconfirmed transactions | Always wait for confirmation before updating state |

---

## 11. Implementation Checklist

### FOUND-01: Encrypted Keystore

- [ ] Implement AES-256-GCM encrypt/decrypt functions
- [ ] Create KeystoreFile format with version
- [ ] Add loadKeystore/saveKeystore functions
- [ ] Test encryption/decryption roundtrip
- [ ] Verify no plaintext keys in logs
- [ ] Add password validation (min length, etc.)

### FOUND-02: SQLite State Store

- [ ] Set up better-sqlite3 with WAL mode
- [ ] Create schema (trades, pnl_snapshots, analysis_cache, agent_state)
- [ ] Implement TradeRepository with prepared statements
- [ ] Add transaction support for batch operations
- [ ] Test recovery: close DB, reopen, verify state
- [ ] Add database backup function

### FOUND-03: Rate-Limited Helius Client

- [ ] Configure Bottleneck for your Helius tier
- [ ] Implement TTLCache for API responses
- [ ] Wrap getTransactionsForAddress with rate limiting + cache
- [ ] Add p-retry for transient error handling
- [ ] Add Opossum circuit breaker
- [ ] Test under load: verify no 429 errors
- [ ] Add metrics: cache hits, API calls, latency

### Integration Test: Devnet Transaction

- [ ] Load wallet from encrypted keystore
- [ ] Connect to Solana devnet via Helius
- [ ] Request airdrop if needed
- [ ] Create, sign, and submit test transaction
- [ ] Confirm transaction
- [ ] Save trade record to SQLite
- [ ] Verify state persists after restart

---

## Summary

This research confirms Phase 1 is achievable with well-supported, production-ready libraries:

| Requirement | Solution | Confidence |
|-------------|----------|------------|
| Encrypted keystore | Node.js crypto (AES-256-GCM + PBKDF2) | HIGH |
| SQLite state store | better-sqlite3 with WAL mode | HIGH |
| Rate-limited Helius client | Bottleneck + TTL cache + p-retry + Opossum | HIGH |
| Structured logging | Pino with redaction | HIGH |

**Key insight:** The Helius `getTransactionsForAddress` API costs 100 credits per request. With a Developer tier (10M credits/month), you can make ~100,000 requests/month, or ~3,300/day. Caching is essential for frequent address monitoring.
