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
import { EntertainmentMode } from './trading/entertainment-mode.js';
import { ClaudeClient, DEFAULT_CLAUDE_CONFIG } from './personality/claude-client.js';
import { MoodSystem } from './personality/mood-system.js';
import { CommentarySystem } from './personality/commentary-system.js';
import { DeepgramTTS, VoiceNarrator } from './personality/deepgram-tts.js';
import { TwitterClient } from './personality/twitter-client.js';
import { MarketWatcher } from './analysis/market-watcher.js';
import { PumpPortalClient } from './trading/pumpportal-client.js';
import { SniperPipeline } from './trading/sniper-pipeline.js';
import { JupiterClient } from './api/jupiter.js';
import { agentEvents } from './events/emitter.js';
import { detectSillyName } from './personality/name-analyzer.js';
import type { RiskProfile } from './trading/types.js';
import { LearningEngine } from './analysis/learning-engine.js';
import { RewardClaimer } from './rewards/reward-claimer.js';

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
    // Initialize database - use volume path on Railway for persistence
    const dbPath = process.env.RAILWAY_ENVIRONMENT
      ? '/app/data/schizo-agent.db'
      : 'schizo-agent.db';
    log.info({ dbPath }, 'Initializing database...');
    db = createDatabase(dbPath);
    const dbWithRepos = createDatabaseWithRepositories(db);

    // Clear stale sync trades on startup
    const deletedCount = dbWithRepos.trades.clearSyncTrades();
    if (deletedCount > 0) {
      log.info({ deletedCount }, 'Cleared stale sync trades from database');
    }

    // Clean up known phantom positions (tokens no longer in wallet)
    // These positions show in DB but wallet has 0 tokens - causing incorrect P&L
    const phantomMints = [
      'G9tnG6Z4KDrNepi2fYQUZYEhuBtfwg6TwbzekxWMpump', // doge
      'C4br6g4C', // HonorPump (partial mint)
      'DPypP1iY', // FaPEPE
      '9R4zqfea', // RyanAir
      'VTCQxY6b', // CITY
      'DRtvTCzf', // ChiefPussy
      '96zMCM9n', // HUGGI
      'HKWqwDuU', // XEPE
      'X8vikGpF', // LAUDE
    ];
    let totalPhantomDeleted = 0;
    for (const mint of phantomMints) {
      // Use LIKE for partial mints
      const deleted = mint.length < 20
        ? dbWithRepos.db.prepare("DELETE FROM trades WHERE token_mint LIKE ?").run(`${mint}%`).changes
        : dbWithRepos.trades.deleteByTokenMint(mint);
      if (deleted > 0) {
        log.info({ mint, deleted }, 'Cleaned up phantom position');
        totalPhantomDeleted += deleted;
      }
    }
    if (totalPhantomDeleted > 0) {
      log.info({ totalPhantomDeleted }, 'Total phantom positions cleaned');
    }

    // Historical IMPOSTOR trade - CLOSED (user sold manually at +73%)
    // Buy entry
    const historicalBuy = {
      signature: 'iwgr8DTfM7STpQ1N21mHNRvC4DNrN5ms7aSAKYw27PukjTq9dmA95j4NY6x1gh5MwZWaeQJEH5tHWRg6Wryc6uq',
      tokenMint: 'Kvqx8QeAXyjQJULbAX7LnWxfym5U51we9Eft51oBAGS',
      tokenSymbol: 'IMPOSTOR',
      type: 'BUY' as const,
      amountSol: 0.026412,
      amountTokens: 107358.911004,
      pricePerToken: 0.000000246014,
      timestamp: 1769028771000,
      metadata: { tokenName: 'Impostor', source: 'PUMP_FUN', importedFromHistory: true },
    };
    // Manual sell exit (user sold at +73% because bot couldn't track graduated token)
    const historicalSell = {
      signature: 'manual-sell-impostor-2026-01-21',
      tokenMint: 'Kvqx8QeAXyjQJULbAX7LnWxfym5U51we9Eft51oBAGS',
      tokenSymbol: 'IMPOSTOR',
      type: 'SELL' as const,
      amountSol: 0.046, // ~$3.46 at SOL ~$170 = +73% from $1.99 entry
      amountTokens: 107358.911004,
      pricePerToken: 0.000000428, // Exit price ~73% higher
      timestamp: 1769030000000, // Approximate manual sell time
      metadata: { tokenName: 'Impostor', source: 'MANUAL', importedFromHistory: true, reason: 'Manual sell - bot missed take-profit on graduated token' },
    };
    if (!dbWithRepos.trades.getBySignature(historicalBuy.signature)) {
      dbWithRepos.trades.insert(historicalBuy);
    }
    if (!dbWithRepos.trades.getBySignature(historicalSell.signature)) {
      dbWithRepos.trades.insert(historicalSell);
      log.info('Historical IMPOSTOR position closed (manual sell imported)');
    }

    // Initialize Helius client
    const heliusApiKey = process.env.HELIUS_API_KEY;
    if (!heliusApiKey) {
      throw new Error('HELIUS_API_KEY is required');
    }
    const helius = new HeliusClient({ apiKey: heliusApiKey } as any);

    // Use Helius RPC for reliable connection (public RPC has heavy rate limits)
    const connection = helius.getConnection();
    log.info('Using Helius RPC for Solana connection');

    // Load Risk Profile early for safety analyzer configuration
    const riskProfile = (process.env.RISK_PROFILE || 'BALANCED') as RiskProfile;
    log.info({ riskProfile }, 'Loading Risk Profile');

    // Initialize analysis modules with risk-aware holder thresholds
    log.info('Initializing analysis modules...');
    const { WalletAnalyzer } = await import('./analysis/wallet-analyzer.js');
    const walletAnalyzer = new WalletAnalyzer(helius, dbWithRepos.analysisCache);
    
    // Risk-based holder distribution thresholds
    const holderThresholds = {
      CONSERVATIVE: { maxTopHolderPercent: 20, maxTop10HoldersPercent: 40, minHolderCount: 50 },
      BALANCED: { maxTopHolderPercent: 30, maxTop10HoldersPercent: 50, minHolderCount: 20 },
      AGGRESSIVE: { maxTopHolderPercent: 40, maxTop10HoldersPercent: 60, minHolderCount: 10 },
      ENTERTAINMENT: { maxTopHolderPercent: 99, maxTop10HoldersPercent: 100, minHolderCount: 1 }, // Effectively disabled - full degen mode
    };
    
    const tokenSafety = new TokenSafetyAnalyzer(
      helius, 
      dbWithRepos.analysisCache,
      holderThresholds[riskProfile]
    );
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
        maxRetries: 5,
        retryDelayMs: 2000,
      } as any, wallet!); // Cast to any to bypass strict config check if types outdated
      
      log.info({ 
        hasApiKey: !!pumpPortalApiKey, 
        wallet: wallet.publicKey.toBase58() 
      }, 'PumpPortal client initialized (Local Trading)');
    } else {
      log.warn('Wallet not configured - Trading Engine disabled');
    }

    // Initialize Jupiter Client (for graduated tokens)
    let jupiter: JupiterClient | undefined;
    if (wallet) {
      try {
        jupiter = new JupiterClient({
          connection,
          wallet,
        });
        log.info('Jupiter client initialized (for graduated tokens)');
      } catch (error) {
        log.warn({ error }, 'Failed to initialize Jupiter client');
      }
    }



// ... (Rest of imports)

    // Initialize Learning Engine (learns from trade outcomes)
    const learningEngine = new LearningEngine(dbWithRepos);
    log.info('Learning Engine initialized - will learn from trade outcomes');

    // Initialize Trading Engine (if we have PumpPortal)
    let tradingEngine: TradingEngine | undefined;
    let tradingLoop: TradingLoop | undefined;
    let rewardClaimer: RewardClaimer | undefined;

    if (pumpPortal && wallet) {
      tradingEngine = new TradingEngine(
        {
          riskProfile, // Pass risk profile
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
        claude,
        jupiter, // Pass initialized Jupiter client
        learningEngine
      );
      log.info('Trading Engine initialized with smart money detection, transaction parsing & learning');
      
      // Sync positions from on-chain data
      log.info('Syncing positions from on-chain data...');
      await tradingEngine.syncPositions();

    } else {
      log.warn('Trading Engine not available - wallet not configured');
    }

    // Initialize Sniper Pipeline (Filter-First Architecture)
    let sniperPipeline: SniperPipeline | undefined;
    
    if (tradingEngine || process.env.TRADING_ENABLED === 'false') {
        const validationDelay = parseInt(process.env.VALIDATION_DELAY_MS || '0'); // Default to 0 (auto-risk)
        log.info({ delayMs: validationDelay, riskProfile }, 'Initializing Sniper Pipeline...');
        
        sniperPipeline = new SniperPipeline(
            {
                riskProfile,
                validationDelayMs: validationDelay,
                enableTrading: process.env.TRADING_ENABLED === 'true',
            },
            {
                // Let Validator use defaults from Risk Profile
                minLiquidityUsd: process.env.MIN_LIQUIDITY_USD ? parseFloat(process.env.MIN_LIQUIDITY_USD) : undefined,
                minVolume1hUsd: process.env.MIN_VOLUME_1H_USD ? parseFloat(process.env.MIN_VOLUME_1H_USD) : undefined,
            },
            tradingEngine,
            tokenSafety
        );
        
        await sniperPipeline.start();
        log.info('🎯 Sniper Pipeline started - Listening for new tokens w/ dynamic delay');
    }

    // Initialize Entertainment Systems (Phase 4)
    const entertainmentEnabled = process.env.ENTERTAINMENT_MODE !== 'false';
    log.info({ entertainmentEnabled }, 'Entertainment mode configuration');

    // MoodSystem - tracks agent emotional state
    const moodSystem = new MoodSystem({
      quietPeriodMs: 5 * 60 * 1000,    // 5 min to restlessness
      maniacChance: 0.08,               // 8% degen moments
      moodDecayMs: 10 * 60 * 1000,      // 10 min mood decay
    });
    log.info('MoodSystem initialized');

    // EntertainmentMode - degen trading decisions
    const entertainmentMode = new EntertainmentMode({
      enabled: entertainmentEnabled,
      minPositionSol: 0.01,             // $2 min bet
      maxPositionSol: 0.05,             // $10 max bet
      quietPeriodMs: 5 * 60 * 1000,     // 5 min pressure start
      maxQuietPeriodMs: 15 * 60 * 1000, // 15 min max pressure
      degenChance: 0.08,                // 8% random ape
      cooldownMs: 5 * 60 * 1000,        // 5 min between trades
      maxTradesPerHour: 6,              // Rate limit
    }, moodSystem);
    log.info({ enabled: entertainmentEnabled }, 'EntertainmentMode initialized');

    // CommentarySystem - controls speech timing
    const commentarySystem = new CommentarySystem(moodSystem, {
      minSpeechGapMs: 15000,            // 15 second minimum
      maxSpeechGapMs: 60000,            // 60 second max before musing
      maxQueueSize: 3,                  // Priority queue size
    });
    if (claude) {
      commentarySystem.setClaudeClient(claude);
    }

    // Hook up commentary to narrator for TTS
    if (narrator) {
      commentarySystem.onSpeech(async (text, beat) => {
        await narrator.say(text);
        agentEvents.emit({
          type: 'SCHIZO_SPEAKS',
          timestamp: Date.now(),
          data: { text },
        });
      });
    }

    // Start commentary system
    commentarySystem.start();
    log.info('CommentarySystem initialized and started');

    // Listen for mood changes and emit events
    // Mood changes happen internally via MoodSystem.setMood which emits MOOD_CHANGE

    // Initialize Trading Loop (Handles Position Management + Trending Tokens)
    tradingLoop = new TradingLoop(
      {
        ...DEFAULT_TRADING_LOOP_CONFIG,
        runLoop: true, // Always run the loop for positions/trending
        enableTrading: process.env.TRADING_ENABLED === 'true' && !!tradingEngine,
        entertainmentMode: entertainmentEnabled,
      },
      connection,
      dbWithRepos,
      tokenSafety,
      smartMoney,
      tradingEngine!, // May be undefined - loop handles this
      claude,
      wallet?.publicKey, // Pass wallet public key for balance tracking
      moodSystem,
      entertainmentMode,
      commentarySystem
    );

    // Initialize Copy Trader (supports multiple wallets)
    let copyTrader: any = null;
    const copyTradeWallets = process.env.COPY_TRADE_WALLETS || process.env.COPY_TRADE_WALLET;
    if (copyTradeWallets && wallet) {
      const walletList = copyTradeWallets.split(',').map(w => w.trim()).filter(w => w.length > 0);
      log.info({ walletCount: walletList.length }, 'Initializing Private Copy Trader...');
      
      const { CopyTrader } = await import('./trading/copy-trader.js');
      copyTrader = new CopyTrader(
        {
          walletAddresses: walletList,
          pollIntervalMs: 2000,
          enabled: true
        },
        helius,
        connection
      );

      copyTrader.start();

      // Listen for copy signals
      agentEvents.onAny(async (event) => {
        if (event.type === 'COPY_TRADE_SIGNAL' && tradingEngine) {
           const { mint, sourceWallet, solSpent } = event.data;
           log.info(`⚡ COPY SIGNAL: ${sourceWallet} bought ${mint} (${solSpent} SOL)`);
           
           if (process.env.TRADING_ENABLED === 'true') {
             await tradingEngine.executeCopyTrade(mint, sourceWallet, solSpent);
             
             // Voice it!
             if (narrator) {
               await narrator.say(`Copying the master. Buying ${mint.slice(0,6)}.`);
             }
           } else {
             log.info('Trading disabled - skipping copy trade execution');
           }
        }
      });
    }

    // Initialize Shill Queue (viewer-submitted token shills via $SCHIZO burns)
    let shillQueue: any = null;
    let shillWatcher: any = null;
    const shillQueueEnabled = process.env.SHILL_QUEUE_ENABLED === 'true';
    const schizoTokenMint = process.env.SCHIZO_TOKEN_MINT;

    if (shillQueueEnabled && schizoTokenMint) {
      log.info('Initializing Shill Queue...');

      const { ShillQueue, ShillQueueWatcher, DEFAULT_SHILL_QUEUE_CONFIG, DEFAULT_SHILL_WATCHER_CONFIG } = await import('./shill-queue/index.js');

      shillQueue = new ShillQueue(
        {
          ...DEFAULT_SHILL_QUEUE_CONFIG,
          lottoPositionSol: parseFloat(process.env.SHILL_LOTTO_SIZE || '0.02'),
        },
        tradingEngine,
        tokenSafety,
        claude,
        narrator,
        commentarySystem
      );

      shillWatcher = new ShillQueueWatcher(
        {
          ...DEFAULT_SHILL_WATCHER_CONFIG,
          burnWalletAddress: process.env.SHILL_BURN_WALLET || 'GvV8bXgQTYSGHnfNF9vgodshgQ4P2fcichGFLqBd73kr',
          schizoTokenMint,
          minShillAmountTokens: parseInt(process.env.MIN_SHILL_AMOUNT || '1000'),
          cooldownPerWalletMs: parseInt(process.env.SHILL_COOLDOWN_MS || '300000'),
          enabled: true,
        },
        connection,
        shillQueue
      );

      await shillWatcher.start();
      log.info({
        burnWallet: process.env.SHILL_BURN_WALLET || 'GvV8bXgQTYSGHnfNF9vgodshgQ4P2fcichGFLqBd73kr',
        minAmount: process.env.MIN_SHILL_AMOUNT || '1000',
        lottoSize: process.env.SHILL_LOTTO_SIZE || '0.02',
      }, '🎤 Shill Queue active - viewers can burn $SCHIZO to shill tokens');
    } else if (shillQueueEnabled && !schizoTokenMint) {
      log.warn('SHILL_QUEUE_ENABLED=true but SCHIZO_TOKEN_MINT not set - shill queue disabled');
    }

    // Start WebSocket server (Railway uses PORT, fallback to WEBSOCKET_PORT or 8080)
    const websocketPort = parseInt(process.env.PORT || process.env.WEBSOCKET_PORT || '8080');
    let wss: any = null;
    let marketWatcher: MarketWatcher | undefined;

    try {
      const { createWebSocketServer } = await import('./server/websocket.js');
      const { agentEvents } = await import('./events/emitter.js');

      log.info({ port: websocketPort }, 'Starting WebSocket server...');
      wss = createWebSocketServer(
        websocketPort,
        agentEvents,
        claude,
        narrator,
        tradingEngine,
        tokenSafety,
        process.env.TRADING_ENABLED === 'true'
      );

      // Set WebSocket on narrator if available
      if (narrator) {
        narrator.setWebSocket(wss);
      }

      // Initialize $SCHIZO Token Tracker (live price display on dashboard)
      let schizoTokenTracker: any = null;
      if (schizoTokenMint && schizoTokenMint !== 'your-schizo-token-mint-here') {
        const { createSchizoTokenTracker } = await import('./services/schizo-token-tracker.js');
        schizoTokenTracker = createSchizoTokenTracker(agentEvents);
        schizoTokenTracker.start();
        log.info({ mint: schizoTokenMint }, '💎 $SCHIZO Token Tracker active');
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
        if (schizoTokenTracker) schizoTokenTracker.stop();
        if (shillWatcher) shillWatcher.stop();
        if (rewardClaimer) rewardClaimer.stop();
        if (commentarySystem) commentarySystem.stop();
        if (marketWatcher) marketWatcher.stop();
        if (sniperPipeline) sniperPipeline.stop();
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
      log.info(`  ${entertainmentEnabled ? '✅' : '⚠️'} Entertainment Mode ${entertainmentEnabled ? '(ACTIVE - Degen trading)' : '(DISABLED)'}`);
      log.info(`  ${shillWatcher ? '✅' : '⚠️'} Shill Queue ${shillWatcher ? '(ACTIVE - burn $SCHIZO to shill)' : '(DISABLED)'}`);
      log.info(`  ${schizoTokenTracker ? '✅' : '⚠️'} $SCHIZO Token Tracker ${schizoTokenTracker ? '(ACTIVE - live price on dashboard)' : '(DISABLED - set SCHIZO_TOKEN_MINT)'}`);
      log.info(`  ✅ Market Watcher: Learning from trades`);
      log.info('');

      // Start market watcher
      marketWatcher.start();
      log.info('🧠 Market Watcher started - Learning patterns...');

      // Voice announcements for analysis and trade events
      // NOTE: When entertainmentMode is enabled, speech goes through CommentarySystem
      // This handler is for backwards compat and non-commentary events
      if (narrator) {
        agentEvents.onAny(async (event) => {
          try {
            let speech: string | null = null;

            // ANALYSIS_THOUGHT events - SCHIZO thinking out loud during analysis
            // Skip if commentarySystem is handling speech
            if (event.type === 'ANALYSIS_THOUGHT' && !entertainmentEnabled) {
              speech = event.data.thought;
            }
            // Trade executed events - only voice if not using commentary system
            else if (event.type === 'TRADE_EXECUTED' && !entertainmentEnabled) {
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
              // Update mood on loss
              moodSystem.recordTradeResult(false, -lossPercent);
              speech = `Stop loss triggered. Down ${lossPercent.toFixed(1)} percent on ${mint.slice(0, 6)}. The patterns lied to me.`;
            } else if (event.type === 'TAKE_PROFIT') {
              const { mint, profitPercent } = event.data;
              // Update mood on win
              moodSystem.recordTradeResult(true, profitPercent);
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

      // Initialize Reward Claimer - handles automatic fee claiming
      if (pumpPortal && process.env.TRADING_ENABLED === 'true') {
        rewardClaimer = new RewardClaimer(pumpPortal, {
          enabled: true,
          claimIntervalMs: 5 * 60 * 1000,    // 5 minutes
          minClaimThreshold: 0.001,          // 0.001 SOL minimum
          maxRetries: 3,
          retryDelayMs: 5000,
          claimPumpCreator: true,            // Enable creator fees
          claimPumpReferral: false,          // Disabled by default
          claimMeteoraDbc: false,            // Disabled by default
        });

        rewardClaimer.start();
        log.info('💰 RewardClaimer started - automatic fee claiming enabled');

        // Voice successful claims
        agentEvents.onAny(async (event) => {
          if (event.type === 'REWARD_CLAIMED' && narrator) {
            try {
              const amount = event.data.amountSol?.toFixed(4) || 'some';
              await narrator.say(`Creator fees claimed. ${amount} SOL. The flywheel keeps spinning.`);
            } catch (error) {
              log.error({ error }, 'Failed to voice reward claim');
            }
          }
        });
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

        // Smart token commentary - comment on interesting tokens, not random ones
        let lastTokenCommentTime = 0;
        const TOKEN_COMMENT_COOLDOWN = 15000; // 15 second cooldown between comments

        // Track trading context for chat responses
        agentEvents.onAny(async (event) => {
          // Update trading context for chat
          if (event.type === 'ANALYSIS_THOUGHT' && event.data.stage === 'scanning') {
            claude.updateTradingContext({
              currentlyAnalyzing: event.data.symbol,
            });
          }

          if (event.type === 'ANALYSIS_THOUGHT' && event.data.stage === 'decision') {
            claude.updateTradingContext({
              currentlyAnalyzing: undefined,
              tokensAnalyzed: [
                ...([] as Array<{symbol: string; verdict: string}>),
                {
                  symbol: event.data.symbol,
                  verdict: event.data.details?.shouldTrade ? 'potential' : 'skip',
                }
              ],
            });
          }

          if (event.type === 'TRADE_EXECUTED') {
            claude.updateTradingContext({
              lastTrade: {
                symbol: event.data.mint.slice(0, 8),
                type: event.data.type,
                time: Date.now(),
              },
            });
          }
        });

        // Comment on tokens entering analysis pipeline (passed initial filters)
        agentEvents.onAny(async (event) => {
          // Only comment on tokens entering analysis (they have potential)
          if (event.type !== 'ANALYSIS_THOUGHT') return;
          if (event.data.stage !== 'scanning') return;

          const now = Date.now();
          // Skip if commented too recently
          if (now - lastTokenCommentTime < TOKEN_COMMENT_COOLDOWN) return;

          const token = event.data;

          // Check if it has a silly name worth roasting
          const sillyCategory = detectSillyName(token.symbol || '', token.name || '');

          // Always roast silly names, otherwise 50% chance for interesting tokens
          if (!sillyCategory && Math.random() > 0.5) return;

          lastTokenCommentTime = now;

          try {
            let commentary: string;

            if (sillyCategory) {
              // Generate a roast for the silly name
              commentary = await claude.generateSillyNameRoast(
                {
                  symbol: token.symbol,
                  name: token.name || token.symbol,
                  marketCapSol: token.marketCapSol,
                },
                sillyCategory
              );
              log.debug({ symbol: token.symbol, category: sillyCategory }, 'Silly name detected - roasting');
            } else {
              // Generate standard commentary for interesting token
              commentary = await claude.generateTokenCommentary({
                symbol: token.symbol,
                name: token.name || token.symbol,
                marketCapSol: token.marketCapSol,
                liquidity: token.liquidity,
                priceChange5m: token.priceChange5m,
              });
            }

            // Emit commentary event for dashboard
            agentEvents.emit({
              type: 'TOKEN_COMMENTARY',
              timestamp: Date.now(),
              data: {
                mint: token.mint,
                symbol: token.symbol,
                commentary,
                isSillyName: !!sillyCategory,
                sillyCategory: sillyCategory || undefined,
              },
            });

            // Speak the commentary
            await narrator.say(commentary);

            log.debug({ symbol: token.symbol, commentary: commentary.slice(0, 50) }, 'Token commentary generated');
          } catch (error) {
            log.error({ error }, 'Failed to generate token commentary');
          }
        });

        log.info('🎤 Smart token commentary enabled (50% of interesting tokens, 100% of silly names)');
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
