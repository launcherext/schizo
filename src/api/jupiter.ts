/**
 * Jupiter API client for token swaps on Solana.
 *
 * Uses the official @jup-ag/api SDK for:
 * - Getting swap quotes across all Solana DEXs
 * - Executing optimized swaps with best routing
 * - Price lookups
 *
 * Use Jupiter for tokens that have GRADUATED from pump.fun to Raydium.
 * For active pump.fun bonding curve tokens, use PumpPortal instead.
 *
 * Optimized with Helius smart transactions (Jan 2026):
 * - Smart retry with polling and rebroadcast
 * - Better transaction confirmation
 */

import { createJupiterApiClient, QuoteResponse } from '@jup-ag/api';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { createLogger } from '../lib/logger.js';
import { SmartTransactionSender, createSmartTransactionSender } from './smart-transaction.js';

const logger = createLogger('jupiter');

// SOL mint address (wrapped SOL)
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Swap quote with human-readable values
 */
export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: number;       // Human readable (e.g., 1.5 SOL)
  outputAmount: number;      // Human readable
  inputAmountRaw: string;    // Raw lamports/smallest unit
  outputAmountRaw: string;   // Raw lamports/smallest unit
  priceImpactPct: number;    // e.g., 0.5 for 0.5%
  slippageBps: number;
  routePlan: string[];       // DEXs used in route
  otherAmountThreshold: string;
  rawQuote: QuoteResponse;   // Original SDK response for swap execution
}

/**
 * Swap result
 */
export interface SwapResult {
  signature: string;
  inputAmount: number;
  outputAmount: number;
  priceImpactPct: number;
}

/**
 * Jupiter client configuration
 */
export interface JupiterClientConfig {
  connection: Connection;
  wallet: Keypair;
  defaultSlippageBps?: number;  // Default: 50 (0.5%)
  maxPriceImpactPct?: number;   // Default: 5 (5%)
  /** Helius API key for smart transactions (recommended) */
  heliusApiKey?: string;
  /** Enable smart transaction sending (default: true if heliusApiKey provided) */
  enableSmartTx?: boolean;
}

/**
 * Jupiter API client for graduated token swaps.
 */
export class JupiterClient {
  private jupiter: ReturnType<typeof createJupiterApiClient>;
  private connection: Connection;
  private wallet: Keypair;
  private defaultSlippageBps: number;
  private maxPriceImpactPct: number;
  private smartTxSender: SmartTransactionSender | null = null;

  constructor(config: JupiterClientConfig) {
    this.jupiter = createJupiterApiClient();
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.defaultSlippageBps = config.defaultSlippageBps ?? 50; // 0.5%
    this.maxPriceImpactPct = config.maxPriceImpactPct ?? 5;    // 5%

    // Initialize smart transaction sender if Helius API key provided
    if (config.heliusApiKey && config.enableSmartTx !== false) {
      this.smartTxSender = createSmartTransactionSender(config.heliusApiKey, config.wallet, {
        enableJitoTips: false, // Jupiter already handles tips via prioritizationFeeLamports
        timeoutMs: 60000,
      });
      logger.info('Smart transaction sender enabled for Jupiter swaps');
    }

    logger.info({
      defaultSlippageBps: this.defaultSlippageBps,
      maxPriceImpactPct: this.maxPriceImpactPct,
      smartTxEnabled: !!this.smartTxSender,
    }, 'JupiterClient initialized');
  }

  /**
   * Get a swap quote for buying a token with SOL.
   */
  async getQuoteBuy(
    outputMint: string,
    solAmount: number,
    slippageBps?: number
  ): Promise<SwapQuote> {
    const inputAmountLamports = Math.floor(solAmount * 1e9);

    logger.debug({
      outputMint,
      solAmount,
      inputAmountLamports,
    }, 'Getting buy quote');

    const quote = await this.jupiter.quoteGet({
      inputMint: SOL_MINT,
      outputMint,
      amount: inputAmountLamports,
      slippageBps: slippageBps ?? this.defaultSlippageBps,
      swapMode: 'ExactIn',
    });

    return this.formatQuote(quote, SOL_MINT, outputMint);
  }

  /**
   * Get a swap quote for selling a token for SOL.
   */
  async getQuoteSell(
    inputMint: string,
    tokenAmount: number,
    decimals: number = 6,
    slippageBps?: number
  ): Promise<SwapQuote> {
    const inputAmountRaw = Math.floor(tokenAmount * Math.pow(10, decimals));

    logger.debug({
      inputMint,
      tokenAmount,
      decimals,
      inputAmountRaw,
    }, 'Getting sell quote');

    const quote = await this.jupiter.quoteGet({
      inputMint,
      outputMint: SOL_MINT,
      amount: inputAmountRaw,
      slippageBps: slippageBps ?? this.defaultSlippageBps,
      swapMode: 'ExactIn',
    });

    return this.formatQuote(quote, inputMint, SOL_MINT, decimals);
  }

  /**
   * Format SDK quote response to our interface.
   */
  private formatQuote(
    quote: QuoteResponse,
    inputMint: string,
    outputMint: string,
    inputDecimals: number = 9,
    outputDecimals: number = inputMint === SOL_MINT ? 6 : 9
  ): SwapQuote {
    // Determine decimals based on which side is SOL
    const inDecimals = inputMint === SOL_MINT ? 9 : inputDecimals;
    const outDecimals = outputMint === SOL_MINT ? 9 : outputDecimals;

    const inputAmount = parseInt(quote.inAmount) / Math.pow(10, inDecimals);
    const outputAmount = parseInt(quote.outAmount) / Math.pow(10, outDecimals);

    // Extract route plan (DEXs used)
    const routePlan = quote.routePlan?.map(r => r.swapInfo?.label || 'Unknown') || [];

    return {
      inputMint,
      outputMint,
      inputAmount,
      outputAmount,
      inputAmountRaw: quote.inAmount,
      outputAmountRaw: quote.outAmount,
      priceImpactPct: parseFloat(quote.priceImpactPct || '0'),
      slippageBps: quote.slippageBps,
      routePlan,
      otherAmountThreshold: quote.otherAmountThreshold,
      rawQuote: quote,
    };
  }

  /**
   * Execute a swap from a quote.
   *
   * @param quote - Quote from getQuoteBuy or getQuoteSell
   * @param options - Execution options
   */
  async executeSwap(
    quote: SwapQuote,
    options?: {
      skipPriceImpactCheck?: boolean;
    }
  ): Promise<SwapResult> {
    // Check price impact
    if (!options?.skipPriceImpactCheck && quote.priceImpactPct > this.maxPriceImpactPct) {
      throw new Error(
        `Price impact too high: ${quote.priceImpactPct.toFixed(2)}% > ${this.maxPriceImpactPct}% max`
      );
    }

    logger.info({
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inputAmount: quote.inputAmount,
      outputAmount: quote.outputAmount,
      priceImpactPct: quote.priceImpactPct,
      route: quote.routePlan.join(' -> '),
    }, 'Executing Jupiter swap');

    // Get swap transaction with auto priority fees
    const swapResult = await this.jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote.rawQuote,
        userPublicKey: this.wallet.publicKey.toString(),
        dynamicComputeUnitLimit: true,
      },
    });

    // Deserialize transaction
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(swapResult.swapTransaction, 'base64')
    );

    // Sign transaction
    transaction.sign([this.wallet]);

    // Send transaction using smart sender if available (includes retry, polling)
    let signature: string;
    if (this.smartTxSender) {
      logger.debug('Sending Jupiter swap via smart transaction sender');
      signature = await this.smartTxSender.sendExternalTransaction(transaction, {
        urgent: false, // Jupiter swaps can use normal priority
        skipPreflight: false,
      });
      logger.info({ signature, smartTx: true }, 'Jupiter swap confirmed via smart sender');
    } else {
      // Fallback to regular send
      signature = await this.connection.sendTransaction(transaction, {
        skipPreflight: false,
        maxRetries: 3,
      });

      // Wait for confirmation
      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');

      if (confirmation.value.err) {
        throw new Error(`Swap failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      logger.info({
        signature,
        inputAmount: quote.inputAmount,
        outputAmount: quote.outputAmount,
      }, 'Jupiter swap executed successfully');
    }

    return {
      signature,
      inputAmount: quote.inputAmount,
      outputAmount: quote.outputAmount,
      priceImpactPct: quote.priceImpactPct,
    };
  }

  /**
   * Buy a token with SOL in one call.
   * Convenience method that gets quote and executes.
   */
  async buy(
    tokenMint: string,
    solAmount: number,
    options?: {
      slippageBps?: number;
      skipPriceImpactCheck?: boolean;
    }
  ): Promise<SwapResult> {
    const quote = await this.getQuoteBuy(tokenMint, solAmount, options?.slippageBps);
    return this.executeSwap(quote, options);
  }

  /**
   * Sell a token for SOL in one call.
   * Convenience method that gets quote and executes.
   */
  async sell(
    tokenMint: string,
    tokenAmount: number,
    decimals: number = 6,
    options?: {
      slippageBps?: number;
      skipPriceImpactCheck?: boolean;
    }
  ): Promise<SwapResult> {
    const quote = await this.getQuoteSell(tokenMint, tokenAmount, decimals, options?.slippageBps);
    return this.executeSwap(quote, options);
  }

  /**
   * Get token price in SOL.
   */
  async getPrice(tokenMint: string): Promise<number | null> {
    try {
      // Get a small quote to determine price
      const quote = await this.jupiter.quoteGet({
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: 1e9, // 1 SOL
        slippageBps: 100,
        swapMode: 'ExactIn',
      });

      const outputAmount = parseInt(quote.outAmount);
      if (outputAmount === 0) return null;

      // Price = SOL per token = 1 / tokens received per SOL
      const tokensPerSol = outputAmount / 1e6; // Assuming 6 decimals
      const priceInSol = 1 / tokensPerSol;

      return priceInSol;
    } catch (error) {
      logger.debug({ tokenMint, error }, 'Failed to get Jupiter price');
      return null;
    }
  }

  /**
   * Check if a token is tradeable on Jupiter (has liquidity on DEXs).
   */
  async isTokenTradeable(tokenMint: string): Promise<boolean> {
    try {
      const quote = await this.jupiter.quoteGet({
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: 1e8, // 0.1 SOL test
        slippageBps: 500, // High slippage for testing
        swapMode: 'ExactIn',
      });

      // If we get a quote with some output, it's tradeable
      return parseInt(quote.outAmount) > 0;
    } catch (error) {
      // No route found = not tradeable on Jupiter
      return false;
    }
  }

  /**
   * Check if token has graduated from pump.fun (tradeable on Raydium via Jupiter).
   * Returns true if token can be swapped via Jupiter with reasonable liquidity.
   */
  async hasGraduated(tokenMint: string): Promise<boolean> {
    try {
      const quote = await this.jupiter.quoteGet({
        inputMint: SOL_MINT,
        outputMint: tokenMint,
        amount: 1e9, // 1 SOL
        slippageBps: 100,
        swapMode: 'ExactIn',
      });

      // Check if route goes through Raydium
      const usesRaydium = quote.routePlan?.some(
        r => r.swapInfo?.label?.toLowerCase().includes('raydium')
      );

      // Check price impact is reasonable (< 10% for 1 SOL)
      const priceImpact = parseFloat(quote.priceImpactPct || '0');
      const hasLiquidity = priceImpact < 10;

      return usesRaydium && hasLiquidity;
    } catch (error) {
      return false;
    }
  }
}

export { SOL_MINT };
