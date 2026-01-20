/**
 * SCHIZO Agent - Entry Point with Trading Loop
 */

import 'dotenv/config';
import { Connection, Keypair } from '@solana/web3.js';
import { logger, createLogger } from './lib/logger.js';
import { runDevnetTest } from './test-devnet.js';
import { createDatabase } from './db/database.js';
import { createDatabaseWithRepositories } from './db/database-with-repos.js';
import { HeliusClient } from './api/helius.js';
import { TokenSafetyAnalyzer } from './analysis/token-safety.js';
import { SmartMoneyTracker } from './analysis/smart-money.js';
import { TradingEngine } from './trading/trading-engine.js';
import { TradingLoop, DEFAULT_TRADING_LOOP_CONFIG } from './trading/trading-loop.js';
import { ClaudeClient, DEFAULT_CLAUDE_CONFIG } from './personality/claude-client.js';
import { DeepgramTTS, VoiceNarrator } from './personality/deepgram-tts.js';
import { TwitterClient } from './personality/twitter-client.js';
import { MarketWatcher } from './analysis/market-watcher.js';
import { PumpPortalClient } from './trading/pumpportal-client.js';
import { agentEvents } from './events/emitter.js';

const log = createLogger('main');
let db: ReturnType<typeof createDatabase> | null = null;

async function main(): Promise<void> {
  log.info('===========================================');
  log.info('$SCHIZO Agent v1.0.0');
  log.info('Paranoid AI Trading Agent');
  log.info('===========================================');

  const isTestMode = process.argv.includes('--test');

  if (isTestMode) {
    log.info('Running devnet integration test...');
    log.info('');
    await runDevnetTest();
  } else {
    // Initialize database
    log.info('Initializing database...');
    db = createDatabase('schizo-agent.db');
    const dbWithRepos = createDatabaseWithRepositories(db);

    // Initialize Helius client
    const heliusApiKey = process.env.HELIUS_API_KEY;
    if (!heliusApiKey) {
      throw new Error('HELIUS_API_KEY is required');
    }
    const helius = new HeliusClient({ apiKey: heliusApiKey } as any);

    // Initialize Solana connection
    const connection = new Connection('https://api.mainnet-beta.solana.com');

    // Initialize analysis modules
    log.info('Initializing analysis modules...');
    const { WalletAnalyzer } = await import('./analysis/wallet-analyzer.js');
    const walletAnalyzer = new WalletAnalyzer(helius, dbWithRepos.analysisCache);
    const tokenSafety = new TokenSafetyAnalyzer(helius, dbWithRepos.analysisCache);
    const smartMoney = new SmartMoneyTracker(walletAnalyzer, dbWithRepos.analysisCache);

    // Initialize Claude client (optional)
    let claude: ClaudeClient | undefined;
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicApiKey && anthropicApiKey !== 'your-anthropic-api-key-here') {
      log.info('Initializing Claude client...');
      claude = new ClaudeClient({
        ...DEFAULT_CLAUDE_CONFIG,
        apiKey: anthropicApiKey,
      });
    } else {
      log.warn('ANTHROPIC_API_KEY not configured - running without AI personality');
    }

    // Initialize Deepgram TTS (optional)
    let tts: DeepgramTTS | undefined;
    let narrator: VoiceNarrator | undefined;
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    if (deepgramApiKey && deepgramApiKey !== 'your-deepgram-api-key-here') {
      log.info('Initializing Deepgram TTS...');
      tts = new DeepgramTTS({
        apiKey: deepgramApiKey,
        model: process.env.DEEPGRAM_MODEL || 'aura-2-aries-en',
      });
      narrator = new VoiceNarrator(tts);
      log.info('Voice narration enabled');
    } else {
      log.warn('DEEPGRAM_API_KEY not configured - running without voice');
    }

    // Initialize Twitter Client (optional)
    let twitter: TwitterClient | undefined;
    const twitterApiKey = process.env.TWITTER_API_KEY;
    if (twitterApiKey) {
      log.info('Initializing Twitter client...');
      twitter = new TwitterClient({
        apiKey: process.env.TWITTER_API_KEY!,
        apiSecret: process.env.TWITTER_API_SECRET!,
        accessToken: process.env.TWITTER_ACCESS_TOKEN!,
        accessSecret: process.env.TWITTER_ACCESS_SECRET!,
        maxTweetsPerDay: 50,
      }, claude);

      // Set up Event Listeners for Tweeting
      agentEvents.onAny((event) => {
        if (!twitter) return;

        if (event.type === 'TRADE_EXECUTED' && event.data.type === 'BUY') {
          // Tweet about Buys
          const amount = event.data.amount as number;
          const mint = event.data.mint as string;
          // We can fetch reasoning if available, or just post the generic update for now
          twitter.postTradeUpdate('BUY', mint, amount);
        }
      });
      
      log.info('Twitter bot active 🐦');
    } else {
        log.warn('TWITTER_API_KEY not configured - running without auto-tweets');
    }

    // Initialize wallet (if private key provided)
    let wallet: Keypair | undefined;
    const walletPrivateKey = process.env.WALLET_PRIVATE_KEY;
    if (walletPrivateKey) {
      try {
        // Try base58 first (Phantom export format), then base64
        let privateKeyBytes: Uint8Array;
        try {
          const bs58 = await import('bs58');
          privateKeyBytes = bs58.default.decode(walletPrivateKey);
        } catch {
          privateKeyBytes = Uint8Array.from(Buffer.from(walletPrivateKey, 'base64'));
        }
        wallet = Keypair.fromSecretKey(privateKeyBytes);
        log.info({ publicKey: wallet.publicKey.toBase58() }, 'Wallet loaded');
      } catch (error) {
        log.warn({ error }, 'Failed to load wallet from WALLET_PRIVATE_KEY');
      }
    }

    // Initialize PumpPortal client (requires wallet)
    let pumpPortal: PumpPortalClient | undefined;
    const pumpPortalApiKey = process.env.PUMPPORTAL_API_KEY; // Optional for local trading
    
    if (wallet) {
      pumpPortal = new PumpPortalClient({
        apiKey: pumpPortalApiKey, // Can be undefined
        baseUrl: process.env.PUMPPORTAL_BASE_URL || 'https://pumpportal.fun/api',
        rpcUrl: 'https://api.mainnet-beta.solana.com', // Add default RPC
        maxRetries: 3,
        retryDelayMs: 1000,
      } as any, wallet!); // Cast to any to bypass strict config check if types outdated
      
      log.info({ 
        hasApiKey: !!pumpPortalApiKey, 
        wallet: wallet.publicKey.toBase58() 
      }, 'PumpPortal client initialized (Local Trading)');
    } else {
      log.warn('Wallet not configured - Trading Engine disabled');
    }

    // Initialize Trading Engine (if we have PumpPortal)
    let tradingEngine: TradingEngine | undefined;
    let tradingLoop: TradingLoop | undefined;

    if (pumpPortal && wallet) {
      tradingEngine = new TradingEngine(
        {
          basePositionSol: parseFloat(process.env.BASE_POSITION_SOL || '0.1'),
          maxPositionSol: parseFloat(process.env.MAX_POSITION_SOL || '1.0'),
          maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '5'),
          maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || '20'),
          circuitBreakerDailyLoss: parseFloat(process.env.CIRCUIT_BREAKER_DAILY_LOSS || '-5.0'),
          circuitBreakerConsecutiveLosses: parseInt(process.env.CIRCUIT_BREAKER_CONSECUTIVE_LOSSES || '3'),
          minLiquiditySol: parseFloat(process.env.MIN_LIQUIDITY_SOL || '10'),
          slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE || '0.05'),
          stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT || '0.2'), // Default -20%
          takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT || '0.5'), // Default +50%
        },
        pumpPortal,
        tokenSafety,
        smartMoney,
        dbWithRepos,
        connection,
        wallet.publicKey.toBase58(),
        helius,
        claude
      );
      log.info('Trading Engine initialized with smart money detection & transaction parsing');
    } else {
      log.warn('Trading Engine not available - wallet not configured');
    }

    // Initialize Trading Loop (can run analysis-only without trading engine)
    tradingLoop = new TradingLoop(
      {
        ...DEFAULT_TRADING_LOOP_CONFIG,
        runLoop: true, // Always run the loop for analysis/dashboard
        enableTrading: process.env.TRADING_ENABLED === 'true' && !!tradingEngine,
      },
      connection,
      dbWithRepos,
      tokenSafety,
      smartMoney,
      tradingEngine!, // May be undefined - loop handles this
      claude,
      wallet?.publicKey // Pass wallet public key for balance tracking
    );

    // Start WebSocket server (Railway uses PORT, fallback to WEBSOCKET_PORT or 8080)
    const websocketPort = parseInt(process.env.PORT || process.env.WEBSOCKET_PORT || '8080');
    let wss: any = null;
    let marketWatcher: MarketWatcher | undefined;

    try {
      const { createWebSocketServer } = await import('./server/websocket.js');
      const { agentEvents } = await import('./events/emitter.js');

      log.info({ port: websocketPort }, 'Starting WebSocket server...');
      wss = createWebSocketServer(websocketPort, agentEvents, claude, narrator);

      // Set WebSocket on narrator if available
      if (narrator) {
        narrator.setWebSocket(wss);
      }

      // Initialize Market Watcher
      marketWatcher = new MarketWatcher(
        {
          observationInterval: 30000, // 30 seconds
          learningInterval: 300000, // 5 minutes
          voiceEnabled: !!narrator,
          commentaryEnabled: !!claude,
        },
        claude,
        narrator,
        dbWithRepos
      );

      // Shutdown handlers
      const shutdown = () => {
        log.info('Shutting down...');
        if (marketWatcher) marketWatcher.stop();
        if (tradingLoop) tradingLoop.stop();
        if (wss) wss.close();
        if (db) db.close();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      log.info('');
      log.info('🚀 $SCHIZO Agent is LIVE!');
      log.info('');
      log.info(`📡 WebSocket: ws://localhost:${websocketPort}`);
      log.info(`🌐 Dashboard: Open public/index.html in your browser`);
      log.info('');
      log.info('Systems Status:');
      log.info('  ✅ Phase 1: Database, Keystore, Helius API');
      log.info('  ✅ Phase 2: Token Safety, Wallet Analysis, Smart Money');
      log.info(`  ${tradingEngine ? '✅' : '⚠️'} Phase 3: Trading Engine ${tradingEngine ? '(READY)' : '(DISABLED)'}`);
      log.info(`  ${claude ? '✅' : '⚠️'} Phase 4: AI Personality ${claude ? '(ACTIVE)' : '(DISABLED)'}`);
      log.info(`  ${narrator ? '✅' : '⚠️'} Voice: Deepgram TTS ${narrator ? '(ACTIVE)' : '(DISABLED)'}`);
      log.info(`  ✅ Market Watcher: Learning from trades`);
      log.info('');

      // Start market watcher
      marketWatcher.start();
      log.info('🧠 Market Watcher started - Learning patterns...');

      // Voice announcements for trade events
      if (narrator) {
        agentEvents.onAny(async (event) => {
          try {
            let speech: string | null = null;

            if (event.type === 'TRADE_EXECUTED') {
              const { type, amount, mint } = event.data;
              const shortMint = mint.slice(0, 6);
              if (claude) {
                speech = await claude.generateCommentary({
                  type: 'TRADE_EXECUTED',
                  data: { type, amount, mint },
                  timestamp: Date.now(),
                });
              } else {
                speech = type === 'BUY'
                  ? `Buying in on ${shortMint}. ${amount.toFixed(2)} SOL. Let's see if the whales know something.`
                  : `Selling ${shortMint}. Taking ${amount.toFixed(2)} SOL off the table.`;
              }
            } else if (event.type === 'STOP_LOSS') {
              const { mint, lossPercent } = event.data;
              speech = `Stop loss triggered. Down ${lossPercent.toFixed(1)} percent on ${mint.slice(0, 6)}. The patterns lied to me.`;
            } else if (event.type === 'TAKE_PROFIT') {
              const { mint, profitPercent } = event.data;
              speech = `Taking profit. Up ${profitPercent.toFixed(1)} percent on ${mint.slice(0, 6)}. The voices were right this time.`;
            } else if (event.type === 'BUYBACK_TRIGGERED') {
              const { amount, profit } = event.data;
              speech = `Buyback triggered. ${amount.toFixed(2)} SOL going back into SCHIZO. Profit was ${profit.toFixed(2)} SOL.`;
            }

            if (speech) {
              await narrator.say(speech);
            }
          } catch (error) {
            log.error({ error }, 'Failed to voice trade event');
          }
        });
        log.info('🔊 Voice announcements enabled for trades');
      }

      // Start trading loop logic
      if (tradingLoop) {
        log.info('🤖 Starting Analysis Loop...');
        tradingLoop.start();

        if (process.env.TRADING_ENABLED === 'true') {
          log.info('⚠️  LIVE TRADING ENABLED - Agent will execute real trades!');
        } else {
          log.info('👀 ANALYSIS MODE - Monitoring tokens without trading');
        }
      }

      // Generate initial greeting and periodic idle thoughts
      if (claude && narrator) {
        // Initial greeting
        try {
          const greeting = await claude.generateIdleThought();
          await narrator.say(greeting);
          agentEvents.emit({
            type: 'SCHIZO_SPEAKS',
            timestamp: Date.now(),
            data: { text: greeting },
          });
        } catch (error) {
          log.error({ error }, 'Failed to generate initial greeting');
        }

        // Random idle thoughts every 2-5 minutes
        const speakRandomly = async () => {
          try {
            const thought = await claude.generateIdleThought();
            await narrator.say(thought);
            agentEvents.emit({
              type: 'SCHIZO_SPEAKS',
              timestamp: Date.now(),
              data: { text: thought },
            });
          } catch (error) {
            log.error({ error }, 'Failed to generate idle thought');
          }

          // Schedule next thought in 2-5 minutes
          const nextDelay = 120000 + Math.random() * 180000;
          setTimeout(speakRandomly, nextDelay);
        };

        // Start idle thoughts after initial delay
        setTimeout(speakRandomly, 120000 + Math.random() * 60000);
        log.info('💭 Random thoughts enabled (every 2-5 minutes)');

        // Random commentary on new tokens (30% chance)
        let lastTokenCommentTime = 0;
        const TOKEN_COMMENT_COOLDOWN = 15000; // 15 second cooldown between comments

        agentEvents.onAny(async (event) => {
          if (event.type !== 'TOKEN_DISCOVERED') return;

          const now = Date.now();
          // Skip if commented too recently
          if (now - lastTokenCommentTime < TOKEN_COMMENT_COOLDOWN) return;

          // 30% chance to comment on a token
          if (Math.random() > 0.3) return;

          lastTokenCommentTime = now;

          try {
            const token = event.data;
            const commentary = await claude.generateTokenCommentary({
              symbol: token.symbol,
              name: token.name,
              marketCapSol: token.marketCapSol,
              liquidity: token.liquidity,
              priceChange5m: token.priceChange5m,
            });

            // Emit commentary event for dashboard
            agentEvents.emit({
              type: 'TOKEN_COMMENTARY',
              timestamp: Date.now(),
              data: {
                mint: token.mint,
                symbol: token.symbol,
                commentary,
              },
            });

            // Speak the commentary
            await narrator.say(commentary);

            log.debug({ symbol: token.symbol, commentary: commentary.slice(0, 50) }, 'Token commentary generated');
          } catch (error) {
            log.error({ error }, 'Failed to generate token commentary');
          }
        });

        log.info('🎤 Token commentary enabled (30% of new tokens)');
      }

      log.info('');
      log.info('💬 Chat enabled - Send messages via WebSocket');
      log.info('Press Ctrl+C to exit.');

    } catch (error) {
      log.error({ error }, 'Failed to start WebSocket server');
    }

    // Keep running
    await new Promise(() => {});
  }
}

main().catch((error) => {
  logger.error({ error: (error as Error).message }, 'Fatal error');
  process.exit(1);
});
