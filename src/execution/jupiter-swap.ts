import {
  Connection,
  PublicKey,
  VersionedTransaction,
  Keypair,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { createChildLogger } from '../utils/logger';
import { config, SOL_MINT, LAMPORTS_PER_SOL } from '../config/settings';
import { SwapQuote, SwapResult, SwapFees } from './types';

const logger = createChildLogger('jupiter-swap');

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
  contextSlot: number;
  timeTaken: number;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

export class JupiterSwap {
  private connection: Connection;
  private wallet: Keypair | null = null;

  constructor() {
    this.connection = new Connection(config.solanaRpcUrl, 'confirmed');
  }

  initialize(): void {
    if (config.privateKey) {
      try {
        const secretKey = bs58.decode(config.privateKey);
        this.wallet = Keypair.fromSecretKey(secretKey);
        logger.info({ publicKey: this.wallet.publicKey.toBase58() }, 'Wallet initialized');
      } catch (error) {
        logger.error({ error }, 'Failed to initialize wallet');
      }
    }
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: number,
    slippageBps: number = 50
  ): Promise<SwapQuote | null> {
    try {
      const url = new URL(config.jupiterQuoteApi);
      url.searchParams.set('inputMint', inputMint);
      url.searchParams.set('outputMint', outputMint);
      url.searchParams.set('amount', amountLamports.toString());
      url.searchParams.set('slippageBps', slippageBps.toString());

      const response = await fetch(url.toString());

      if (!response.ok) {
        logger.error({ status: response.status }, 'Jupiter quote failed');
        return null;
      }

      const data = await response.json() as JupiterQuoteResponse;

      const quote: SwapQuote = {
        inputMint: data.inputMint,
        outputMint: data.outputMint,
        inputAmount: parseInt(data.inAmount),
        outputAmount: parseInt(data.outAmount),
        priceImpact: parseFloat(data.priceImpactPct),
        slippageBps,
        route: data.routePlan.map((r) => ({
          dex: r.swapInfo.label,
          poolAddress: r.swapInfo.ammKey,
          inputMint: r.swapInfo.inputMint,
          outputMint: r.swapInfo.outputMint,
          inputAmount: parseInt(r.swapInfo.inAmount),
          outputAmount: parseInt(r.swapInfo.outAmount),
        })),
        fees: {
          platformFee: 0,
          networkFee: 5000, // Estimate
          priorityFee: 0,
          totalFee: 5000,
        },
      };

      logger.debug({
        inputMint,
        outputMint,
        inputAmount: amountLamports / LAMPORTS_PER_SOL,
        outputAmount: quote.outputAmount,
        priceImpact: quote.priceImpact,
      }, 'Quote received');

      return quote;
    } catch (error) {
      logger.error({ error, inputMint, outputMint }, 'Failed to get quote');
      return null;
    }
  }

  async executeSwap(
    inputMint: string,
    outputMint: string,
    amountLamports: number,
    slippageBps: number = 50
  ): Promise<SwapResult> {
    if (!this.wallet) {
      return {
        success: false,
        inputAmount: amountLamports,
        outputAmount: 0,
        priceImpact: 0,
        fees: { platformFee: 0, networkFee: 0, priorityFee: 0, totalFee: 0 },
        error: 'Wallet not initialized',
        timestamp: new Date(),
      };
    }

    // Check for paper trading mode
    if (config.paperTrading) {
      return this.simulateSwap(inputMint, outputMint, amountLamports, slippageBps);
    }

    try {
      // Get quote first
      const quote = await this.getQuote(inputMint, outputMint, amountLamports, slippageBps);

      if (!quote) {
        return {
          success: false,
          inputAmount: amountLamports,
          outputAmount: 0,
          priceImpact: 0,
          fees: { platformFee: 0, networkFee: 0, priorityFee: 0, totalFee: 0 },
          error: 'Failed to get quote',
          timestamp: new Date(),
        };
      }

      // Get swap transaction
      const swapResponse = await fetch(config.jupiterSwapApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      });

      if (!swapResponse.ok) {
        const errorText = await swapResponse.text();
        logger.error({ status: swapResponse.status, error: errorText }, 'Swap request failed');
        return {
          success: false,
          inputAmount: amountLamports,
          outputAmount: 0,
          priceImpact: quote.priceImpact,
          fees: quote.fees,
          error: `Swap request failed: ${swapResponse.status}`,
          timestamp: new Date(),
        };
      }

      const swapData = await swapResponse.json() as JupiterSwapResponse;

      // Deserialize and sign transaction
      const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

      transaction.sign([this.wallet]);

      // Send transaction
      const signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        {
          skipPreflight: true,
          maxRetries: 3,
        }
      );

      logger.info({ signature }, 'Swap transaction sent');

      // Confirm transaction
      const confirmation = await this.connection.confirmTransaction(
        {
          signature,
          blockhash: transaction.message.recentBlockhash,
          lastValidBlockHeight: swapData.lastValidBlockHeight,
        },
        'confirmed'
      );

      if (confirmation.value.err) {
        return {
          success: false,
          signature,
          inputAmount: amountLamports,
          outputAmount: 0,
          priceImpact: quote.priceImpact,
          fees: quote.fees,
          error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
          timestamp: new Date(),
        };
      }

      logger.info(
        { signature, inputAmount: amountLamports / LAMPORTS_PER_SOL, outputAmount: quote.outputAmount },
        'Swap successful'
      );

      return {
        success: true,
        signature,
        inputAmount: amountLamports,
        outputAmount: quote.outputAmount,
        priceImpact: quote.priceImpact,
        fees: {
          ...quote.fees,
          priorityFee: swapData.prioritizationFeeLamports,
          totalFee: quote.fees.networkFee + swapData.prioritizationFeeLamports,
        },
        timestamp: new Date(),
      };
    } catch (error: any) {
      logger.error({ error: error.message }, 'Swap execution failed');
      return {
        success: false,
        inputAmount: amountLamports,
        outputAmount: 0,
        priceImpact: 0,
        fees: { platformFee: 0, networkFee: 0, priorityFee: 0, totalFee: 0 },
        error: error.message,
        timestamp: new Date(),
      };
    }
  }

  private async simulateSwap(
    inputMint: string,
    outputMint: string,
    amountLamports: number,
    slippageBps: number
  ): Promise<SwapResult> {
    // Get quote for realistic simulation
    const quote = await this.getQuote(inputMint, outputMint, amountLamports, slippageBps);

    if (!quote) {
      return {
        success: false,
        inputAmount: amountLamports,
        outputAmount: 0,
        priceImpact: 0,
        fees: { platformFee: 0, networkFee: 0, priorityFee: 0, totalFee: 0 },
        error: 'Failed to get quote for simulation',
        timestamp: new Date(),
      };
    }

    // Simulate slippage
    const slippageMultiplier = 1 - (Math.random() * slippageBps / 10000);
    const simulatedOutput = Math.floor(quote.outputAmount * slippageMultiplier);

    logger.info(
      {
        mode: 'PAPER',
        inputMint,
        outputMint,
        inputAmount: amountLamports / LAMPORTS_PER_SOL,
        outputAmount: simulatedOutput,
      },
      'Paper trade executed'
    );

    return {
      success: true,
      signature: `PAPER_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      inputAmount: amountLamports,
      outputAmount: simulatedOutput,
      priceImpact: quote.priceImpact,
      fees: quote.fees,
      timestamp: new Date(),
    };
  }

  async buy(
    tokenMint: string,
    amountSol: number,
    slippageBps: number = 100
  ): Promise<SwapResult> {
    const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    return this.executeSwap(SOL_MINT, tokenMint, amountLamports, slippageBps);
  }

  async sell(
    tokenMint: string,
    amountTokens: number,
    decimals: number,
    slippageBps: number = 100
  ): Promise<SwapResult> {
    const amountRaw = Math.floor(amountTokens * Math.pow(10, decimals));
    return this.executeSwap(tokenMint, SOL_MINT, amountRaw, slippageBps);
  }

  getWalletAddress(): string | null {
    return this.wallet?.publicKey.toBase58() || null;
  }

  async getBalance(): Promise<number> {
    if (!this.wallet) return 0;

    try {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      logger.error({ error }, 'Failed to get balance');
      return 0;
    }
  }

  async getTokenBalance(mint: string): Promise<number> {
    if (!this.wallet) return 0;

    try {
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: new PublicKey(mint) }
      );

      if (tokenAccounts.value.length === 0) return 0;

      const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
      return balance || 0;
    } catch (error) {
      logger.error({ mint, error }, 'Failed to get token balance');
      return 0;
    }
  }
}

export const jupiterSwap = new JupiterSwap();
