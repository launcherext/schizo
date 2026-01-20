# Technology Stack: $SCHIZO - Paranoid AI Trading Agent

**Project:** Solana AI Trading Agent with Helius Data + PumpPortal Execution
**Researched:** 2026-01-20
**Overall Confidence:** HIGH

---

## Executive Summary

This stack is built around three anchors already decided: **Helius** (data), **PumpPortal** (execution), and **Claude** (AI reasoning). The supporting stack optimizes for:
- TypeScript-first development (type safety for financial operations)
- Real-time streaming architecture (WebSocket for market data, reasoning streams)
- Minimal dependencies (security-critical for wallet operations)
- Modern Solana tooling (web3.js 2.x via Helius SDK 2.0)

---

## Recommended Stack

### Core Runtime

| Technology | Version | Purpose | Confidence | Rationale |
|------------|---------|---------|------------|-----------|
| **Node.js** | 22.x LTS | Runtime | HIGH | Native .env support (v20.6+), ES modules, async/await for agent loops |
| **TypeScript** | 5.5+ | Language | HIGH | Type safety critical for trading amounts, wallet operations. Zod 4 requires 5.5+ |
| **pnpm** | 9.x | Package manager | HIGH | Faster installs, strict dependency resolution, monorepo-ready |

**Why Node.js 22 LTS:** Native environment variable loading eliminates dotenv dependency for production secrets. Event loop model is ideal for concurrent WebSocket streams (market data, reasoning output).

### Solana Infrastructure

| Technology | Version | Purpose | Confidence | Rationale |
|------------|---------|---------|------------|-----------|
| **helius-sdk** | 2.0.5 | Helius API client | HIGH | Rewritten for @solana/kit, includes DAS API, getTransactionsForAddress |
| **@solana/web3.js** | 2.x | Blockchain interaction | HIGH | Included via helius-sdk, tree-shakable, zero external deps, full TypeScript |
| **bs58** | 6.x | Base58 encoding | HIGH | Required for keypair handling, standard Solana tool |

**Why Helius SDK 2.0:** The v2.0 rewrite uses @solana/kit (successor to web3.js 1.x) under the hood. You get modern Solana primitives without managing the migration yourself. The SDK provides:
- `getTransactionsForAddress()` - Your forensic analysis core (100 credits/call)
- `getAssetsByOwner()` - Wallet token holdings via DAS API
- Webhooks for event-driven architecture

**Code Example - Helius Setup:**
```typescript
import { Helius } from 'helius-sdk';

const helius = new Helius(process.env.HELIUS_API_KEY);

// Forensic wallet analysis
const transactions = await helius.rpc.getTransactionsForAddress(
  suspiciousWallet,
  {
    transactionDetails: 'full',
    sortOrder: 'desc',
    limit: 100,
    filters: {
      status: 'succeeded',
      tokenAccounts: 'balanceChanged'
    }
  }
);

// Token holdings via DAS
const assets = await helius.getAssetsByOwner({
  ownerAddress: targetWallet,
  displayOptions: { showFungible: true }
});
```

### Trading Execution (PumpPortal)

| Technology | Version | Purpose | Confidence | Rationale |
|------------|---------|---------|------------|-----------|
| **PumpPortal Lightning API** | Current | Fast trade execution | HIGH | 0.5-1% fee, Jito bundles, dedicated nodes |
| **PumpPortal Local API** | Current | Custom RPC execution | HIGH | Full signing control, lower fees (0.5%) |
| **PumpPortal WebSocket** | Current | Real-time market data | HIGH | Token launches, trades, migrations |

**API Decision: Lightning vs Local**

Use **Local Transaction API** for $SCHIZO because:
1. Full control over signing (security)
2. Lower fees (0.5% vs 1%)
3. Can use your own RPC (Helius) for confirmation
4. Required for paranoid personality - "trust no one with my keys"

**Code Example - PumpPortal Trading:**
```typescript
// Local API for full control
async function executeTrade(action: 'buy' | 'sell', mint: string, amountSol: number) {
  const response = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: wallet.publicKey.toBase58(),
      action,
      mint,
      amount: amountSol,
      denominatedInSol: 'true',
      slippage: 15, // High slippage for memecoins
      priorityFee: 0.0001,
      pool: 'auto'
    })
  });

  const { transaction } = await response.json();
  // Deserialize, sign locally, send via Helius RPC
  const tx = Transaction.from(Buffer.from(transaction, 'base64'));
  tx.sign(wallet);
  const sig = await helius.connection.sendRawTransaction(tx.serialize());
  return sig;
}

// Creator fee claiming
async function claimCreatorFees() {
  const response = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: wallet.publicKey.toBase58(),
      action: 'collectCreatorFee',
      priorityFee: 0.000001,
      pool: 'pump' // or 'meteora-dbc'
    })
  });
  // Sign and send...
}
```

**Code Example - PumpPortal WebSocket:**
```typescript
import WebSocket from 'ws';

const ws = new WebSocket('wss://pumpportal.fun/api/data');

ws.on('open', () => {
  // Subscribe to new token launches
  ws.send(JSON.stringify({ method: 'subscribeNewToken' }));

  // Subscribe to trades on specific tokens
  ws.send(JSON.stringify({
    method: 'subscribeTokenTrade',
    keys: [tokenMintAddress]
  }));

  // Subscribe to migrations (bonding curve -> Raydium)
  ws.send(JSON.stringify({ method: 'subscribeMigration' }));
});

ws.on('message', (data) => {
  const event = JSON.parse(data.toString());
  // Route to analysis pipeline
});
```

### AI Reasoning (Claude)

| Technology | Version | Purpose | Confidence | Rationale |
|------------|---------|---------|------------|-----------|
| **@anthropic-ai/sdk** | Latest | Claude API client | HIGH | Official SDK, streaming support, tool use |
| **zod** | 4.x | Schema validation | HIGH | Type-safe tool definitions, required by Anthropic SDK |

**Why Claude + Streaming:** The paranoid degen personality needs to "think out loud" on pump.fun. Claude's streaming API lets you pipe reasoning tokens directly to the pump.fun chat as they generate.

**Code Example - Claude Trading Decision:**
```typescript
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

const anthropic = new Anthropic();

const TradeDecision = z.object({
  action: z.enum(['buy', 'sell', 'hold', 'investigate']),
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
  redFlags: z.array(z.string()),
  targetAmount: z.number().optional()
});

async function* analyzeAndStream(walletData: WalletAnalysis, tokenData: TokenData) {
  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-5-20250514',
    max_tokens: 1024,
    system: `You are $SCHIZO, a paranoid AI trading agent. You see patterns others miss.
    You're deeply suspicious of rugs, insider wallets, and coordinated dumps.
    Express your analysis with paranoid energy - but back it up with data.
    Format: Think out loud, then give your verdict.`,
    messages: [{
      role: 'user',
      content: `Analyze this potential trade:

Token: ${tokenData.symbol}
Mint: ${tokenData.mint}
Current holders: ${tokenData.holderCount}
Top 10 wallet concentration: ${tokenData.topHolderPercent}%

Suspicious wallet activity I found:
${JSON.stringify(walletData.suspiciousPatterns, null, 2)}

Recent transactions:
${JSON.stringify(walletData.recentTxs.slice(0, 10), null, 2)}

Should I ape in, or is this a trap?`
    }]
  });

  // Stream reasoning tokens for pump.fun chat
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }

  // Parse final decision
  const finalMessage = await stream.finalMessage();
  return parseDecision(finalMessage.content[0].text);
}
```

### Dashboard (Optional - Phase 2+)

| Technology | Version | Purpose | Confidence | Rationale |
|------------|---------|---------|------------|-----------|
| **Next.js** | 15.x | Dashboard framework | HIGH | App Router, React 19, SSR for SEO |
| **Tailwind CSS** | 4.x | Styling | HIGH | Utility-first, fast iteration |
| **Tremor** | 3.x | Dashboard components | MEDIUM | Chart components, built on Recharts |
| **@solana/wallet-adapter-react** | 0.15.x | Wallet connection | HIGH | Standard for Solana dApps |

**Why Next.js 15:** Server components reduce client bundle, App Router enables streaming UI for live reasoning display, built-in API routes for agent control endpoints.

### Supporting Libraries

| Library | Version | Purpose | Confidence |
|---------|---------|---------|------------|
| **ws** | 8.x | WebSocket client (Node) | HIGH |
| **node-cron** | 3.x | Scheduled tasks (fee claiming) | MEDIUM |
| **pino** | 9.x | Structured logging | HIGH |
| **nanoid** | 5.x | ID generation | HIGH |

---

## Agent Architecture Pattern

**Recommended: Event-Driven Agent Loop**

```
                    +------------------+
                    |  PumpPortal WS   |
                    | (market events)  |
                    +--------+---------+
                             |
                             v
+----------------+    +------+-------+    +------------------+
|   Helius WS    +--->|  Event       +--->| Analysis Queue   |
| (tx webhooks)  |    |  Router      |    | (priority queue) |
+----------------+    +------+-------+    +--------+---------+
                             ^                     |
                             |                     v
                    +--------+-------+    +--------+---------+
                    |  Cron Jobs     |    |  Claude Analysis |
                    | (fee claims)   |    |  (streaming)     |
                    +----------------+    +--------+---------+
                                                   |
                                                   v
                                          +--------+---------+
                                          |  Trade Executor  |
                                          | (PumpPortal)     |
                                          +--------+---------+
                                                   |
                                                   v
                                          +--------+---------+
                                          |  Pump.fun Chat   |
                                          | (reasoning stream)|
                                          +------------------+
```

**Core Loop Structure:**
```typescript
// agent/core/loop.ts
export class AgentLoop {
  private eventQueue: PriorityQueue<AgentEvent>;
  private isProcessing = false;

  constructor(
    private helius: Helius,
    private pumpPortal: PumpPortalClient,
    private claude: Anthropic,
    private pumpFunChat: PumpFunChatClient
  ) {}

  async start() {
    // Initialize WebSocket connections
    this.initMarketDataStream();
    this.initHeliusWebhooks();

    // Start processing loop
    this.processLoop();

    // Schedule recurring tasks
    this.scheduleFeeClaims();
    this.scheduleBuybacks();
  }

  private async processLoop() {
    while (true) {
      const event = await this.eventQueue.dequeue();

      try {
        switch (event.type) {
          case 'NEW_TOKEN':
            await this.handleNewToken(event);
            break;
          case 'SUSPICIOUS_WALLET':
            await this.handleSuspiciousActivity(event);
            break;
          case 'TRADE_SIGNAL':
            await this.executeTrade(event);
            break;
        }
      } catch (error) {
        this.logger.error({ event, error }, 'Event processing failed');
      }
    }
  }
}
```

---

## Installation

```bash
# Create project
mkdir schizo-agent && cd schizo-agent
pnpm init

# Core dependencies
pnpm add helius-sdk @anthropic-ai/sdk zod bs58 ws pino nanoid

# Dev dependencies
pnpm add -D typescript @types/node @types/ws tsx

# Optional: Dashboard (Phase 2)
pnpm add next@15 react react-dom @solana/wallet-adapter-react @solana/wallet-adapter-react-ui tailwindcss tremor
```

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

**Environment Variables (.env):**
```bash
# Required
HELIUS_API_KEY=your-helius-developer-key
ANTHROPIC_API_KEY=your-claude-api-key
PUMPPORTAL_API_KEY=your-pumpportal-key
WALLET_PRIVATE_KEY=base58-encoded-private-key

# Optional
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
LOG_LEVEL=info
```

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| **Solana SDK** | helius-sdk 2.0 | @solana/web3.js directly | Helius SDK wraps web3.js + adds DAS, gTFA, webhooks |
| **AI Model** | Claude Sonnet 4.5 | GPT-4o | Claude better at structured reasoning, lower hallucination for trading |
| **Trade Execution** | PumpPortal Local | PumpPortal Lightning | Local = lower fees, full signing control |
| **Framework** | Next.js 15 | Remix, SvelteKit | Next.js has best Solana wallet adapter ecosystem |
| **Validation** | Zod 4 | Yup, Joi | Zod required by Anthropic SDK for tools, TypeScript-native |
| **WebSocket** | ws | socket.io | ws is lighter, no need for socket.io features |
| **Logging** | Pino | Winston | Pino is 5x faster, JSON-native |

---

## Version Pinning Strategy

**Pin major versions, allow minor updates:**

```json
{
  "dependencies": {
    "helius-sdk": "^2.0.0",
    "@anthropic-ai/sdk": "^0.30.0",
    "zod": "^4.0.0",
    "bs58": "^6.0.0",
    "ws": "^8.0.0",
    "pino": "^9.0.0"
  }
}
```

**Security Note:** The Solana web3.js package had a compromised version incident in December 2024 (versions 1.95.6 and 1.95.7). Using helius-sdk 2.0 avoids this entirely as it uses @solana/kit internally.

---

## Confidence Assessment

| Component | Confidence | Notes |
|-----------|------------|-------|
| helius-sdk 2.0 | HIGH | Verified via official docs, npm, recent release |
| PumpPortal API | HIGH | Verified via official docs, active development |
| @anthropic-ai/sdk | HIGH | Official Anthropic SDK, actively maintained |
| Zod 4 | HIGH | Verified latest release July 2025 |
| Next.js 15 | HIGH | Stable, widely adopted |
| Agent loop pattern | MEDIUM | Based on industry patterns, needs validation |

---

## Sources

### Official Documentation
- [Helius SDK GitHub](https://github.com/helius-labs/helius-sdk)
- [Helius getTransactionsForAddress Docs](https://www.helius.dev/docs/rpc/gettransactionsforaddress)
- [Helius DAS API Docs](https://www.helius.dev/docs/api-reference/das)
- [PumpPortal Trading API](https://pumpportal.fun/trading-api/)
- [PumpPortal Local Transaction API](https://pumpportal.fun/local-trading-api/trading-api/)
- [PumpPortal Creator Fee Claiming](https://pumpportal.fun/creator-fee/)
- [PumpPortal Real-Time WebSocket](https://pumpportal.fun/data-api/real-time/)
- [Anthropic Client SDKs](https://docs.claude.com/en/api/client-sdks)
- [Solana web3.js 2.0 Announcement](https://www.anza.xyz/blog/solana-web3-js-2-release)
- [Zod Documentation](https://zod.dev/)

### Community Resources
- [Solana Trading Bot Architecture Guide](https://rpcfast.com/blog/solana-trading-bot-guide)
- [TypeScript AI Agent Frameworks 2026](https://techwithibrahim.medium.com/top-5-typescript-ai-agent-frameworks-you-should-know-in-2026-5a2a0710f4a0)
- [Node.js for AI Agentic Architecture](https://www.amplework.com/blog/nodejs-for-ai-agentic-systems-architecture/)
