import { HeliusClient, TransactionResult } from '../api/helius.js';
import { Connection } from '@solana/web3.js';
import { createLogger } from '../lib/logger.js';
import { agentEvents } from '../events/emitter.js';

const logger = createLogger('copy-trader');

export interface CopyTraderConfig {
  walletAddress: string;
  pollIntervalMs: number;
  enabled: boolean;
}

/**
 * CopyTrader - Watches a specific wallet and copies their trades
 * "Schizo copy trades" - blindly follows the target with high confidence
 */
export class CopyTrader {
  private config: CopyTraderConfig;
  private helius: HeliusClient;
  private connection: Connection;
  private isRunning: boolean = false;
  private intervalId?: NodeJS.Timeout;
  private lastSignature: string | null = null;
  private isProcessing = false;

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
    }, 'CopyTrader initialized');
  }

  /**
   * Start watching the target wallet
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
    logger.info(`Started watching wallet: ${this.config.walletAddress}`);

    // Initial fetch to get the latest signature so we don't process old trades
    try {
      const response = await this.helius.getTransactionsForAddress(this.config.walletAddress, {
        limit: 1
      });
      if (response.data && response.data.length > 0) {
        this.lastSignature = response.data[0].signature;
        logger.debug({ lastSignature: this.lastSignature }, 'Set initial sync point');
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to get initial transaction history');
    }

    // Start polling
    this.intervalId = setInterval(() => {
      this.pollWallet().catch(err => {
        logger.error({ error: err }, 'Error in CopyTrader poll');
      });
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    logger.info('CopyTrader stopped');
  }

  /**
   * Poll for new transactions
   */
  private async pollWallet(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Fetch latest transactions
      const response = await this.helius.getTransactionsForAddress(this.config.walletAddress, {
        limit: 10 // Checking last 10 should be enough for 5s intervals
      });

      if (!response.data || response.data.length === 0) {
        return;
      }

      // Filter for new transactions Since last check
      const newTransactions: TransactionResult[] = [];
      
      // If we have a last signature, find strictly newer ones
      if (this.lastSignature) {
        for (const tx of response.data) {
          if (tx.signature === this.lastSignature) {
            break; // Reached known history
          }
          newTransactions.push(tx);
        }
      } else {
        // First run (shouldn't really happen due to start() logic, but safe fallback)
        // Just take the single most recent one to avoid spamming old history
        if (response.data.length > 0) {
           // On very first blind poll, maybe just mark the latest and don't trade it to be safe?
           // Or just trade the very latest. Let's just track it for now.
           this.lastSignature = response.data[0].signature;
           return; 
        }
      }

      // Update last signature if we found new stuff
      if (response.data.length > 0) {
        this.lastSignature = response.data[0].signature;
      }

      // Process new transactions (oldest first to preserve order)
      for (const tx of newTransactions.reverse()) {
        await this.analyzeTransaction(tx);
      }

    } catch (error) {
      logger.error({ error }, 'Failed to poll copy trade wallet');
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Analyze a transaction to see if it's a buy we should copy
   */
  private async analyzeTransaction(tx: TransactionResult): Promise<void> {
    // Only care about successful SWAP transactions
    if (!tx.success || tx.type !== 'SWAP') {
      return;
    }

    logger.info({ signature: tx.signature }, 'Analyzing potential copy trade');

    // We need to parse details to see if it was a BUY (SOL -> Token)
    // The Helius simplified response doesn't give us balance changes,
    // so we use our TransactionParser locally or rely on enhanced Helius data if we had it.
    // Since HeliusClient.getTransactionsForAddress returns basic info, we might need to fetch parsed tx
    // OR, if we trust the "SWAP" type, we can try to guess.
    // BUT, we need the MINT to copy trade.
    
    // We'll use the TransactionParser which fetches the full parsed tx from RPC (Connection).
    // Note: This adds RPC load.
    
    try {
      const parsed = await this.connection.getParsedTransaction(tx.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!parsed || !parsed.meta) return;

      // Check balance changes for this wallet
      const preTokenBalances = parsed.meta.preTokenBalances || [];
      const postTokenBalances = parsed.meta.postTokenBalances || [];
      const accountKeys = parsed.transaction.message.accountKeys;
      
      const walletPubkey = this.config.walletAddress;
      const walletIndex = accountKeys.findIndex((k: any) => k.pubkey.toBase58() === walletPubkey);

      if (walletIndex === -1) return;

      // Check SOL change (Spend SOL = Buy)
      const preSol = parsed.meta.preBalances[walletIndex];
      const postSol = parsed.meta.postBalances[walletIndex];
      const solChange = (postSol - preSol) / 1e9;

      // Check Token changes
      // Find a token account owned by this wallet that INCREASED in balance
      let boughtMint: string | undefined;
      let boughtAmount = 0;

      // Helper to get balance
      const getBalance = (balances: any[], mint: string, owner: string) => {
        const b = balances.find(x => x.mint === mint && x.owner === owner);
        return b ? parseFloat(b.uiTokenAmount.uiAmountString || '0') : 0;
      };

      // Identify all mints involved for this owner
      const involvedMints = new Set<string>();
      [...preTokenBalances, ...postTokenBalances].forEach(b => {
        if (b.owner === walletPubkey) involvedMints.add(b.mint);
      });

      for (const mint of involvedMints) {
        const pre = getBalance(preTokenBalances, mint, walletPubkey);
        const post = getBalance(postTokenBalances, mint, walletPubkey);
        if (post > pre) {
          // Balance increased -> They BOUGHT (or received)
          boughtMint = mint;
          boughtAmount = post - pre;
          break; // Assume single token swap for simplicity
        }
      }

      // Logic:
      // If SOL decreased significantly AND Token increased -> BUY
      // If Token decreased AND SOL increased -> SELL (we might want to sell too? For now just Copy BUY)
      
      const isBuy = solChange < -0.001 && !!boughtMint; // Approx check, allowing for fees
      
      if (isBuy && boughtMint) {
        logger.info({ 
          signature: tx.signature, 
          mint: boughtMint, 
          solSpent: Math.abs(solChange).toFixed(4)
        }, '🎯 DETECTED COPY TRADE BUY SIGNAL');

        // Emit signal for TradingEngine
        agentEvents.emit({
          type: 'COPY_TRADE_SIGNAL',
          timestamp: Date.now(),
          data: {
             mint: boughtMint,
             sourceWallet: this.config.walletAddress,
             signature: tx.signature,
             solSpent: Math.abs(solChange)
          }
        });

      } else {
        logger.debug({ signature: tx.signature }, 'Transaction was not a clear buy');
      }

    } catch (error) {
      logger.warn({ error, signature: tx.signature }, 'Failed to parse potential copy trade');
    }
  }
}
