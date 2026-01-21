/**
 * PumpPortal API client for trade execution
 */

import { Keypair, Connection, Transaction, VersionedTransaction } from '@solana/web3.js';
import type { TokenInfo, TradeParams, TradeResult, TradeAction } from './types.js';
import { logger } from '../lib/logger.js';

/**
 * Configuration for PumpPortal client
 */
export interface PumpPortalConfig {
  apiKey?: string;
  baseUrl: string;
  rpcUrl: string;
  maxRetries: number;
  retryDelayMs: number;
}

/**
 * PumpPortal API response for trade
 */
interface TradeResponse {
  signature?: string;
  error?: string;
}

/**
 * PumpPortal API client
 */
export class PumpPortalClient {
  private config: PumpPortalConfig;
  private wallet: Keypair;
  private connection: Connection;
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_DELAY_MS = 100; // Rate limiting: 100ms between requests
  private cachedPriorityFee: number = 0.0005; // Default 0.0005 SOL
  private lastPriorityFeeCheck: number = 0;
  private readonly PRIORITY_FEE_CACHE_MS = 30000; // Cache for 30 seconds

  constructor(config: PumpPortalConfig, wallet: Keypair) {
    this.config = config;
    this.wallet = wallet;
    this.connection = new Connection(config.rpcUrl, 'confirmed');

    logger.info({
      baseUrl: config.baseUrl,
      wallet: wallet.publicKey.toBase58(),
    }, 'PumpPortal client initialized');
  }

  /**
   * Get dynamic priority fee based on recent network activity
   * Uses getRecentPrioritizationFees to estimate appropriate fee
   */
  private async getDynamicPriorityFee(isUrgent: boolean = false): Promise<number> {
    const now = Date.now();

    // Return cached value if fresh
    if (now - this.lastPriorityFeeCheck < this.PRIORITY_FEE_CACHE_MS) {
      const fee = isUrgent ? this.cachedPriorityFee * 2 : this.cachedPriorityFee;
      return Math.min(fee, 0.01); // Cap at 0.01 SOL max
    }

    try {
      // Get recent priority fees from the network
      const recentFees = await this.connection.getRecentPrioritizationFees();

      if (recentFees.length === 0) {
        return this.cachedPriorityFee;
      }

      // Calculate median of non-zero fees
      const nonZeroFees = recentFees
        .map(f => f.prioritizationFee)
        .filter(f => f > 0)
        .sort((a, b) => a - b);

      if (nonZeroFees.length === 0) {
        // Network is quiet, use minimum fee
        this.cachedPriorityFee = 0.0001; // 0.0001 SOL (100 lamports per CU)
      } else {
        // Use 75th percentile for reliability
        const p75Index = Math.floor(nonZeroFees.length * 0.75);
        const p75Fee = nonZeroFees[p75Index] || nonZeroFees[nonZeroFees.length - 1];

        // Convert from microlamports per CU to SOL (assuming ~200k CU per tx)
        // microlamports per CU * 200000 CU / 1e12 = SOL
        this.cachedPriorityFee = Math.max(0.0001, Math.min(0.005, (p75Fee * 200000) / 1e12));
      }

      this.lastPriorityFeeCheck = now;

      logger.debug({
        priorityFee: this.cachedPriorityFee,
        sampleSize: recentFees.length,
      }, 'Dynamic priority fee calculated');

      const fee = isUrgent ? this.cachedPriorityFee * 2 : this.cachedPriorityFee;
      return Math.min(fee, 0.01); // Cap at 0.01 SOL max
    } catch (error) {
      logger.warn({ error }, 'Failed to get dynamic priority fee, using cached value');
      return this.cachedPriorityFee;
    }
  }

  /**
   * Execute a buy order
   */
  async buy(params: TradeParams): Promise<string> {
    return this.executeTrade('buy', params);
  }

  /**
   * Execute a sell order
   */
  async sell(params: TradeParams): Promise<string> {
    return this.executeTrade('sell', params);
  }

  /**
   * Get token information
   */
  async getTokenInfo(mint: string): Promise<TokenInfo> {
    this.validateMint(mint);
    await this.enforceRateLimit();

    const url = `${this.config.baseUrl}/token/${mint}`;
    
    logger.debug({ mint }, 'Fetching token info');

    try {
      const headers: Record<string, string> = {};
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(url, { headers });

      if (!response.ok) {
        throw new Error(`PumpPortal API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      return {
        mint: data.mint,
        name: data.name,
        symbol: data.symbol,
        price: data.price,
        liquidity: data.liquidity,
        holderCount: data.holder_count,
      };
    } catch (error) {
      logger.error({ mint, error }, 'Failed to fetch token info');
      throw error;
    }
  }

  /**
   * Get claimable creator fees
   * Note: pump.fun claims all creator fees at once, not per-token
   *
   * @returns Claimable fee amount in SOL (estimated from recent activity)
   */
  async getClaimableFees(): Promise<number> {
    await this.enforceRateLimit();
    logger.debug('Checking claimable creator fees');

    // Note: PumpPortal doesn't have a dedicated endpoint to check claimable fees
    // The actual claimable amount is determined on-chain when claiming
    // This method returns 0 as a placeholder - use claimFees() to attempt claiming
    logger.warn('getClaimableFees: No dedicated endpoint - use claimFees() to claim and see result');
    return 0;
  }

  /**
   * Claim all creator fees from pump.fun
   * Note: pump.fun claims ALL creator fees at once (not per-token)
   *
   * @param pool - Pool to claim from: 'pump' (default) or 'meteora-dbc'
   * @returns Transaction signature if successful
   */
  async claimFees(pool: 'pump' | 'meteora-dbc' = 'pump'): Promise<string> {
    await this.enforceRateLimit();
    logger.info({ pool }, 'Claiming creator fees');

    const url = `${this.config.baseUrl}/trade-local`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const payload = {
      publicKey: this.wallet.publicKey.toBase58(),
      action: 'collectCreatorFee',
      pool,
    };

    logger.debug({ payload }, 'Requesting fee claim transaction from PumpPortal');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`PumpPortal API error: ${response.status} ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        logger.info('No fees to claim (empty transaction)');
        return '';
      }

      const transactionBuffer = Buffer.from(arrayBuffer);

      // Deserialize and sign transaction
      let transaction: VersionedTransaction;
      try {
        transaction = VersionedTransaction.deserialize(transactionBuffer);
      } catch (error) {
        logger.error({ error }, 'Failed to deserialize fee claim transaction');
        throw new Error('Invalid transaction received from PumpPortal');
      }

      transaction.sign([this.wallet]);

      // Send transaction
      const signature = await this.connection.sendTransaction(transaction, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      logger.info({ signature, pool }, 'Fee claim transaction sent');

      // Wait for confirmation
      await this.waitForConfirmation(signature);

      logger.info({ signature }, 'Creator fees claimed successfully');
      return signature;
    } catch (error) {
      logger.error({ pool, error }, 'Failed to claim creator fees');
      throw error;
    }
  }

  /**
   * Claim Creator Rewards for a specific token (Meteora Dynamic Bonding Curve)
   * Use this after a token graduates from pump.fun to Meteora/Raydium
   * @param mint The mint address of the token you created
   */
  async claimCreatorRewards(mint: string): Promise<string | null> {
    await this.enforceRateLimit();
    logger.info({ mint }, 'Claiming creator rewards via PumpPortal API (Meteora)...');

    try {
      const url = `${this.config.baseUrl}/trade?api-key=${this.config.apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'claim',
          mint: mint,
          publicKey: this.wallet.publicKey.toBase58(),
          denominatedInSol: true, // Use boolean
          amount: 100, // Required by schema but ignored for claims
          slippage: 1, // Required by schema but ignored for claims
          priorityFee: 0.005,
          pool: 'meteora', // Target Meteora curve (graduated tokens)
        }),
      });

      if (response.status === 200) {
        const data = await response.arrayBuffer();

        if (data.byteLength === 0) {
          logger.info({ mint }, 'No rewards to claim (empty response)');
          return null;
        }

        const tx = VersionedTransaction.deserialize(new Uint8Array(data));
        tx.sign([this.wallet]);

        const signature = await this.connection.sendTransaction(tx, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });

        await this.waitForConfirmation(signature);
        logger.info({ signature, mint }, 'Creator rewards claimed successfully');
        return signature;
      } else {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText, mint }, 'Failed to claim rewards');
        return null;
      }
    } catch (error) {
      logger.error({ error, mint }, 'Error claiming creator rewards');
      return null;
    }
  }

  /**
   * Execute a trade (buy or sell)
   * Sell trades use higher priority fees (urgent) for faster exit
   */
  private async executeTrade(action: TradeAction, params: TradeParams): Promise<string> {
    // Validate parameters
    this.validateTradeParams(params);
    await this.enforceRateLimit();

    const { mint, amount, slippage } = params;
    const isUrgent = action === 'sell'; // Exits need higher priority

    logger.info({ mint, amount, slippage, isUrgent }, `Executing ${action} order`);

    let lastError: Error | null = null;

    // Retry logic
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const signature = await this.submitTrade(action, params, isUrgent);
        
        logger.info({
          mint,
          amount,
          signature,
          attempt,
        }, `${action} order successful`);

        return signature;
      } catch (error) {
        lastError = error as Error;
        
        logger.warn({
          mint,
          amount,
          error: lastError.message,
          attempt,
          maxRetries: this.config.maxRetries,
        }, `${action} order attempt ${attempt} failed`);

        // Don't retry on validation errors
        if (this.isValidationError(lastError)) {
          throw lastError;
        }

        // Wait before retry (exponential backoff)
        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
          logger.debug({ attempt }, `Retrying in ${delay}ms`);
          await this.sleep(delay);
        }
      }
    }

    // All retries failed
    logger.error({
      mint,
      amount,
      error: lastError?.message,
    }, `${action} order failed after ${this.config.maxRetries} attempts`);

    throw new Error(`Trade failed after ${this.config.maxRetries} attempts: ${lastError?.message}`);
  }

  /**
   * Submit trade to PumpPortal API (Local Trading)
   */
  private async submitTrade(action: TradeAction, params: TradeParams, isUrgent: boolean = false): Promise<string> {
    const { mint, amount, slippage } = params;

    const url = `${this.config.baseUrl}/trade-local`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    // Get dynamic priority fee based on network conditions
    const priorityFee = await this.getDynamicPriorityFee(isUrgent);

    const payload = {
      publicKey: this.wallet.publicKey.toBase58(),
      action,
      mint,
      amount,
      denominatedInSol: 'true', // Must be string per API docs
      slippage: Math.round(slippage * 100), // Integer 1-100
      priorityFee,
      pool: 'pump',
    };

    logger.debug({ priorityFee, isUrgent }, 'Using dynamic priority fee');

    logger.info({ 
      action,
      mint, 
      amount, 
      slippage: payload.slippage,
      priorityFee,
      publicKey: payload.publicKey.slice(0, 8) + '...'
    }, 'Submitting trade to PumpPortal');

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({
        action,
        mint,
        amount,
        slippage: payload.slippage,
        status: response.status,
        error: errorText,
        url
      }, 'PumpPortal API error - full details');
      throw new Error(`PumpPortal API error: ${response.status} ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
       throw new Error('Received empty transaction from PumpPortal');
    }
    
    const transactionBuffer = Buffer.from(arrayBuffer);

    // Deserialize transaction
    let transaction: VersionedTransaction;
    try {
      transaction = VersionedTransaction.deserialize(transactionBuffer);
    } catch (error) {
       logger.error({ error }, 'Failed to deserialize transaction');
       throw new Error('Invalid transaction received from PumpPortal');
    }

    // Sign transaction
    transaction.sign([this.wallet]);

    // Send transaction
    const signature = await this.connection.sendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    logger.info({ signature }, 'Transaction sent to network');

    // Wait for confirmation
    await this.waitForConfirmation(signature);

    return signature;
  }

  /**
   * Wait for transaction confirmation
   */
  private async waitForConfirmation(signature: string): Promise<void> {
    logger.debug({ signature }, 'Waiting for transaction confirmation');

    const latestBlockhash = await this.connection.getLatestBlockhash();
    
    const confirmation = await this.connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    }, 'confirmed');

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    
    logger.debug({ signature }, 'Transaction confirmed');
  }

  /**
   * Validate trade parameters
   */
  private validateTradeParams(params: TradeParams): void {
    const { mint, amount, slippage } = params;

    this.validateMint(mint);

    if (amount <= 0) {
      throw new Error(`Invalid amount: ${amount}. Amount must be greater than 0.`);
    }

    if (slippage < 0 || slippage > 1) {
      throw new Error(`Invalid slippage: ${slippage}. Slippage must be between 0 and 1.`);
    }
  }

  /**
   * Validate mint address
   */
  private validateMint(mint: string): void {
    if (!mint || mint.length < 32) {
      throw new Error(`Invalid mint address: ${mint}`);
    }
  }

  /**
   * Check if error is a validation error (should not retry)
   */
  private isValidationError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('invalid') ||
      message.includes('validation') ||
      message.includes('must be')
    );
  }

  /**
   * Enforce rate limiting between requests
   */
  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.MIN_REQUEST_DELAY_MS) {
      const delay = this.MIN_REQUEST_DELAY_MS - timeSinceLastRequest;
      await this.sleep(delay);
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
