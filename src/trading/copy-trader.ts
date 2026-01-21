import { HeliusClient, TransactionResult } from '../api/helius.js';
import { Connection, PublicKey, Logs } from '@solana/web3.js';
import { createLogger } from '../lib/logger.js';
import { agentEvents } from '../events/emitter.js';

const logger = createLogger('copy-trader');

export interface CopyTraderConfig {
  walletAddress: string;
  pollIntervalMs: number; // Kept for fallback polling
  enabled: boolean;
}

/**
 * CopyTrader - Watches a specific wallet and copies their trades
 * Uses WebSocket subscription for real-time detection
 */
export class CopyTrader {
  private config: CopyTraderConfig;
  private helius: HeliusClient;
  private connection: Connection;
  private isRunning: boolean = false;
  private subscriptionId: number | null = null;
  private fallbackIntervalId?: NodeJS.Timeout;
  private lastSignature: string | null = null;
  private isProcessing = false;
  private processedSignatures = new Set<string>(); // Prevent duplicate processing

  constructor(
    config: CopyTraderConfig,
    helius: HeliusClient,
    connection: Connection
  ) {
    this.config = config;
    this.helius = helius;
    this.connection = connection;

    logger.info({ 
      wallet: this.config.walletAddress, 
      enabled: this.config.enabled 
    }, 'CopyTrader initialized (WebSocket mode)');
  }

  /**
   * Start watching the target wallet via WebSocket
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('CopyTrader already running');
      return;
    }

    if (!this.config.enabled || !this.config.walletAddress) {
      logger.info('CopyTrader disabled or no wallet configured');
      return;
    }

    this.isRunning = true;
    logger.info(`🔌 Starting CopyTrader WebSocket for: ${this.config.walletAddress}`);

    // Subscribe to logs for the target wallet
    try {
      const walletPubkey = new PublicKey(this.config.walletAddress);
      
      this.subscriptionId = this.connection.onLogs(
        walletPubkey,
        (logs: Logs) => this.handleLogNotification(logs),
        'confirmed'
      );

      logger.info({ subscriptionId: this.subscriptionId }, '✅ WebSocket subscription active');
    } catch (error) {
      logger.error({ error }, 'Failed to subscribe to wallet logs, falling back to polling');
      this.startFallbackPolling();
    }

    // Also start fallback polling as backup (less frequent)
    this.startFallbackPolling();
  }

  /**
   * Start fallback polling (slower interval as backup)
   */
  private startFallbackPolling(): void {
    if (this.fallbackIntervalId) return;

    // Poll every 30 seconds as a fallback (not the primary method)
    const fallbackInterval = Math.max(this.config.pollIntervalMs * 6, 30000);
    
    this.fallbackIntervalId = setInterval(() => {
      this.pollWallet().catch(err => {
        logger.error({ error: err }, 'Error in CopyTrader fallback poll');
      });
    }, fallbackInterval);

    logger.debug({ intervalMs: fallbackInterval }, 'Fallback polling started');
  }

  /**
   * Handle real-time log notification from WebSocket
   */
  private async handleLogNotification(logs: Logs): Promise<void> {
    if (logs.err) {
      logger.debug({ signature: logs.signature }, 'Ignoring failed transaction');
      return;
    }

    // Skip if already processed
    if (this.processedSignatures.has(logs.signature)) {
      return;
    }
    this.processedSignatures.add(logs.signature);

    // Limit cache size
    if (this.processedSignatures.size > 1000) {
      const entries = Array.from(this.processedSignatures);
      this.processedSignatures = new Set(entries.slice(-500));
    }

    logger.info({ signature: logs.signature }, '⚡ Real-time transaction detected!');

    // Check if it looks like a swap (common program logs)
    const isLikelySwap = logs.logs.some(log => 
      log.includes('Instruction: Swap') || 
      log.includes('Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') || // Raydium
      log.includes('Program JUP') || // Jupiter
      log.includes('pump') // Pump.fun
    );

    if (!isLikelySwap) {
      logger.debug({ signature: logs.signature }, 'Not a swap transaction');
      return;
    }

    // Analyze the transaction
    await this.analyzeTransactionBySignature(logs.signature);
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (!this.isRunning) return;
    
    this.isRunning = false;

    // Unsubscribe from WebSocket
    if (this.subscriptionId !== null) {
      this.connection.removeOnLogsListener(this.subscriptionId).catch(err => {
        logger.warn({ error: err }, 'Failed to remove logs listener');
      });
      this.subscriptionId = null;
    }

    // Stop fallback polling
    if (this.fallbackIntervalId) {
      clearInterval(this.fallbackIntervalId);
      this.fallbackIntervalId = undefined;
    }

    logger.info('CopyTrader stopped');
  }

  /**
   * Fallback poll for new transactions (slower, as backup)
   */
  private async pollWallet(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const response = await this.helius.getTransactionsForAddress(this.config.walletAddress, {
        limit: 5
      });

      if (!response.data || response.data.length === 0) {
        return;
      }

      // Filter for new transactions
      for (const tx of response.data) {
        if (this.processedSignatures.has(tx.signature)) continue;
        if (tx.signature === this.lastSignature) break;

        this.processedSignatures.add(tx.signature);
        await this.analyzeTransaction(tx);
      }

      if (response.data.length > 0) {
        this.lastSignature = response.data[0].signature;
      }

    } catch (error) {
      logger.error({ error }, 'Failed to poll copy trade wallet');
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Analyze transaction by signature (for WebSocket path)
   */
  private async analyzeTransactionBySignature(signature: string): Promise<void> {
    try {
      const parsed = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!parsed || !parsed.meta) return;

      await this.processTransaction(signature, parsed);
    } catch (error) {
      logger.warn({ error, signature }, 'Failed to parse transaction from WebSocket');
    }
  }

  /**
   * Analyze a transaction from Helius response (for polling path)
   */
  private async analyzeTransaction(tx: TransactionResult): Promise<void> {
    if (!tx.success || tx.type !== 'SWAP') {
      return;
    }

    try {
      const parsed = await this.connection.getParsedTransaction(tx.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!parsed || !parsed.meta) return;

      await this.processTransaction(tx.signature, parsed);
    } catch (error) {
      logger.warn({ error, signature: tx.signature }, 'Failed to parse potential copy trade');
    }
  }

  /**
   * Process a parsed transaction to detect buy signals
   */
  private async processTransaction(signature: string, parsed: any): Promise<void> {
    const preTokenBalances = parsed.meta.preTokenBalances || [];
    const postTokenBalances = parsed.meta.postTokenBalances || [];
    const accountKeys = parsed.transaction.message.accountKeys;
    
    const walletPubkey = this.config.walletAddress;
    const walletIndex = accountKeys.findIndex((k: any) => k.pubkey.toBase58() === walletPubkey);

    if (walletIndex === -1) return;

    // Check SOL change
    const preSol = parsed.meta.preBalances[walletIndex];
    const postSol = parsed.meta.postBalances[walletIndex];
    const solChange = (postSol - preSol) / 1e9;

    // Check Token changes
    let boughtMint: string | undefined;

    const getBalance = (balances: any[], mint: string, owner: string) => {
      const b = balances.find(x => x.mint === mint && x.owner === owner);
      return b ? parseFloat(b.uiTokenAmount.uiAmountString || '0') : 0;
    };

    const involvedMints = new Set<string>();
    [...preTokenBalances, ...postTokenBalances].forEach(b => {
      if (b.owner === walletPubkey) involvedMints.add(b.mint);
    });

    for (const mint of involvedMints) {
      const pre = getBalance(preTokenBalances, mint, walletPubkey);
      const post = getBalance(postTokenBalances, mint, walletPubkey);
      if (post > pre) {
        boughtMint = mint;
        break;
      }
    }

    const isBuy = solChange < -0.001 && !!boughtMint;
    
    if (isBuy && boughtMint) {
      logger.info({ 
        signature, 
        mint: boughtMint, 
        solSpent: Math.abs(solChange).toFixed(4)
      }, '🎯 COPY TRADE BUY SIGNAL (Real-time)');

      agentEvents.emit({
        type: 'COPY_TRADE_SIGNAL',
        timestamp: Date.now(),
        data: {
           mint: boughtMint,
           sourceWallet: this.config.walletAddress,
           signature,
           solSpent: Math.abs(solChange)
        }
      });
    }
  }
}

