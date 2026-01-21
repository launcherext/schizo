import { HeliusClient, TransactionResult } from '../api/helius.js';
import { Connection, PublicKey, Logs } from '@solana/web3.js';
import { createLogger } from '../lib/logger.js';
import { agentEvents } from '../events/emitter.js';

const logger = createLogger('copy-trader');

export interface CopyTraderConfig {
  walletAddresses: string[];  // Changed to array for multiple wallets
  pollIntervalMs: number;
  enabled: boolean;
}

/**
 * CopyTrader - Watches multiple wallets and copies their trades
 * Uses WebSocket subscription for real-time detection
 * "Schizo copy trades" - blindly follows trusted wallets with high confidence
 */
export class CopyTrader {
  private config: CopyTraderConfig;
  private helius: HeliusClient;
  private connection: Connection;
  private isRunning: boolean = false;
  private subscriptionIds: Map<string, number> = new Map(); // wallet -> subscriptionId
  private fallbackIntervalId?: NodeJS.Timeout;
  private lastSignatures: Map<string, string | null> = new Map(); // wallet -> lastSignature
  private isProcessing = false;
  private processedSignatures = new Set<string>();

  constructor(
    config: CopyTraderConfig,
    helius: HeliusClient,
    connection: Connection
  ) {
    this.config = config;
    this.helius = helius;
    this.connection = connection;

    logger.info({ 
      wallets: this.config.walletAddresses.length,
      enabled: this.config.enabled 
    }, `CopyTrader initialized with ${this.config.walletAddresses.length} wallets (WebSocket mode)`);
  }

  /**
   * Start watching all target wallets via WebSocket
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('CopyTrader already running');
      return;
    }

    if (!this.config.enabled || this.config.walletAddresses.length === 0) {
      logger.info('CopyTrader disabled or no wallets configured');
      return;
    }

    this.isRunning = true;

    // Subscribe to each wallet
    for (const walletAddress of this.config.walletAddresses) {
      try {
        const walletPubkey = new PublicKey(walletAddress);
        
        const subscriptionId = this.connection.onLogs(
          walletPubkey,
          (logs: Logs) => this.handleLogNotification(logs, walletAddress),
          'confirmed'
        );

        this.subscriptionIds.set(walletAddress, subscriptionId);
        this.lastSignatures.set(walletAddress, null);

        logger.info({ 
          wallet: walletAddress.slice(0, 8) + '...', 
          subscriptionId 
        }, '✅ WebSocket subscription active');

      } catch (error) {
        logger.error({ wallet: walletAddress, error }, 'Failed to subscribe to wallet');
      }
    }

    logger.info(`🎯 CopyTrader watching ${this.subscriptionIds.size} wallets`);

    // Start fallback polling
    this.startFallbackPolling();
  }

  /**
   * Start fallback polling for all wallets
   */
  private startFallbackPolling(): void {
    if (this.fallbackIntervalId) return;

    const fallbackInterval = Math.max(this.config.pollIntervalMs * 6, 30000);
    
    this.fallbackIntervalId = setInterval(() => {
      this.pollAllWallets().catch(err => {
        logger.error({ error: err }, 'Error in CopyTrader fallback poll');
      });
    }, fallbackInterval);

    logger.debug({ intervalMs: fallbackInterval }, 'Fallback polling started');
  }

  /**
   * Poll all wallets for new transactions
   */
  private async pollAllWallets(): Promise<void> {
    for (const walletAddress of this.config.walletAddresses) {
      await this.pollWallet(walletAddress);
    }
  }

  /**
   * Handle real-time log notification from WebSocket
   */
  private async handleLogNotification(logs: Logs, walletAddress: string): Promise<void> {
    if (logs.err) {
      logger.debug({ signature: logs.signature }, 'Ignoring failed transaction');
      return;
    }

    if (this.processedSignatures.has(logs.signature)) {
      return;
    }
    this.processedSignatures.add(logs.signature);

    // Limit cache size
    if (this.processedSignatures.size > 2000) {
      const entries = Array.from(this.processedSignatures);
      this.processedSignatures = new Set(entries.slice(-1000));
    }

    logger.info({ 
      signature: logs.signature, 
      wallet: walletAddress.slice(0, 8) + '...' 
    }, '⚡ Real-time transaction detected!');

    // Check if it looks like a swap
    const isLikelySwap = logs.logs.some(log => 
      log.includes('Instruction: Swap') || 
      log.includes('Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') ||
      log.includes('Program JUP') ||
      log.includes('pump')
    );

    if (!isLikelySwap) {
      logger.debug({ signature: logs.signature }, 'Not a swap transaction');
      return;
    }

    await this.analyzeTransactionBySignature(logs.signature, walletAddress);
  }

  /**
   * Stop watching all wallets
   */
  stop(): void {
    if (!this.isRunning) return;
    
    this.isRunning = false;

    // Unsubscribe from all WebSocket subscriptions
    for (const [wallet, subscriptionId] of this.subscriptionIds) {
      this.connection.removeOnLogsListener(subscriptionId).catch(err => {
        logger.warn({ error: err, wallet }, 'Failed to remove logs listener');
      });
    }
    this.subscriptionIds.clear();

    if (this.fallbackIntervalId) {
      clearInterval(this.fallbackIntervalId);
      this.fallbackIntervalId = undefined;
    }

    logger.info('CopyTrader stopped');
  }

  /**
   * Fallback poll for a single wallet
   */
  private async pollWallet(walletAddress: string): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const response = await this.helius.getTransactionsForAddress(walletAddress, {
        limit: 5
      });

      if (!response.data || response.data.length === 0) {
        return;
      }

      const lastSig = this.lastSignatures.get(walletAddress);

      for (const tx of response.data) {
        if (this.processedSignatures.has(tx.signature)) continue;
        if (tx.signature === lastSig) break;

        this.processedSignatures.add(tx.signature);
        await this.analyzeTransaction(tx, walletAddress);
      }

      if (response.data.length > 0) {
        this.lastSignatures.set(walletAddress, response.data[0].signature);
      }

    } catch (error) {
      logger.error({ error, wallet: walletAddress }, 'Failed to poll wallet');
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Analyze transaction by signature (WebSocket path)
   */
  private async analyzeTransactionBySignature(signature: string, walletAddress: string): Promise<void> {
    try {
      const parsed = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!parsed || !parsed.meta) return;

      await this.processTransaction(signature, parsed, walletAddress);
    } catch (error) {
      logger.warn({ error, signature }, 'Failed to parse transaction from WebSocket');
    }
  }

  /**
   * Analyze a transaction from Helius response (polling path)
   */
  private async analyzeTransaction(tx: TransactionResult, walletAddress: string): Promise<void> {
    if (!tx.success || tx.type !== 'SWAP') {
      return;
    }

    try {
      const parsed = await this.connection.getParsedTransaction(tx.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!parsed || !parsed.meta) return;

      await this.processTransaction(tx.signature, parsed, walletAddress);
    } catch (error) {
      logger.warn({ error, signature: tx.signature }, 'Failed to parse potential copy trade');
    }
  }

  /**
   * Process a parsed transaction to detect buy signals
   */
  private async processTransaction(signature: string, parsed: any, walletAddress: string): Promise<void> {
    const preTokenBalances = parsed.meta.preTokenBalances || [];
    const postTokenBalances = parsed.meta.postTokenBalances || [];
    const accountKeys = parsed.transaction.message.accountKeys;
    
    const walletIndex = accountKeys.findIndex((k: any) => k.pubkey.toBase58() === walletAddress);

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
      if (b.owner === walletAddress) involvedMints.add(b.mint);
    });

    for (const mint of involvedMints) {
      const pre = getBalance(preTokenBalances, mint, walletAddress);
      const post = getBalance(postTokenBalances, mint, walletAddress);
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
        solSpent: Math.abs(solChange).toFixed(4),
        sourceWallet: walletAddress.slice(0, 8) + '...'
      }, '🎯 COPY TRADE BUY SIGNAL (Real-time)');

      agentEvents.emit({
        type: 'COPY_TRADE_SIGNAL',
        timestamp: Date.now(),
        data: {
           mint: boughtMint,
           sourceWallet: walletAddress,
           signature,
           solSpent: Math.abs(solChange)
        }
      });
    }
  }
}
