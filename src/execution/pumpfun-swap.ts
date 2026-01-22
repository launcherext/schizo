import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createChildLogger } from '../utils/logger';
import { config, LAMPORTS_PER_SOL } from '../config/settings';
import { SwapResult } from './types';

const logger = createChildLogger('pumpfun-swap');

const PUMPPORTAL_API_URL = 'https://pumpportal.fun/api';

interface PumpPortalTradeRequest {
  publicKey: string;
  action: 'buy' | 'sell';
  mint: string;
  amount: number;
  denominatedInSol: 'true' | 'false';
  slippage: number;
  priorityFee: number;
  pool: 'pump' | 'raydium' | 'auto';
}

interface PumpPortalTradeResponse {
  transaction?: string;
  error?: string;
}

export class PumpFunSwap {
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
        logger.info({ publicKey: this.wallet.publicKey.toBase58() }, 'PumpFun wallet initialized');
      } catch (error) {
        logger.error({ error }, 'Failed to initialize PumpFun wallet');
      }
    }
  }

  async buy(
    tokenMint: string,
    amountSol: number,
    slippagePct: number = config.defaultSlippageBps / 100,  // Convert bps to %
    priorityFee: number = config.priorityFeeSol
  ): Promise<SwapResult> {
    if (!this.wallet) {
      return this.errorResult(amountSol * LAMPORTS_PER_SOL, 'Wallet not initialized');
    }

    // Paper trading simulation
    if (config.paperTrading) {
      return this.simulateBuy(tokenMint, amountSol, slippagePct);
    }

    try {
      logger.info({ mint: tokenMint, amountSol, slippage: slippagePct }, 'Executing PumpFun buy');

      const response = await fetch(`${PUMPPORTAL_API_URL}/trade-local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: this.wallet.publicKey.toBase58(),
          action: 'buy',
          mint: tokenMint,
          amount: amountSol,
          denominatedInSol: 'true',
          slippage: slippagePct,
          priorityFee: priorityFee,
          pool: 'pump', // Use bonding curve
        } as PumpPortalTradeRequest),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'PumpPortal trade request failed');
        return this.errorResult(amountSol * LAMPORTS_PER_SOL, `Trade request failed: ${response.status}`);
      }

      // PumpPortal returns raw transaction bytes directly, not JSON
      const arrayBuffer = await response.arrayBuffer();
      const txData = new Uint8Array(arrayBuffer);

      // Check if response is actually JSON error
      if (txData.length < 100) {
        const text = new TextDecoder().decode(txData);
        try {
          const jsonError = JSON.parse(text);
          if (jsonError.error) {
            return this.errorResult(amountSol * LAMPORTS_PER_SOL, jsonError.error);
          }
        } catch {
          // Not JSON, continue with deserialization
        }
      }

      logger.debug({ bytes: txData.length }, 'Received raw transaction bytes');

      // Deserialize and sign
      const transaction = VersionedTransaction.deserialize(txData);
      transaction.sign([this.wallet]);

      // Send transaction
      const signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        { skipPreflight: true, maxRetries: 3 }
      );

      logger.info({ signature }, 'PumpFun buy transaction sent');

      // Confirm
      const latestBlockhash = await this.connection.getLatestBlockhash();
      const confirmation = await this.connection.confirmTransaction(
        { signature, ...latestBlockhash },
        'confirmed'
      );

      if (confirmation.value.err) {
        return this.errorResult(
          amountSol * LAMPORTS_PER_SOL,
          `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
          signature
        );
      }

      // Parse transaction to get actual token amount received from postTokenBalances
      let outputAmount = 0;
      try {
        const txDetails = await this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (txDetails?.meta?.postTokenBalances) {
          const walletAddress = this.wallet.publicKey.toBase58();
          // Find the token balance entry for our wallet and the purchased token
          const tokenBalance = txDetails.meta.postTokenBalances.find(
            (balance) =>
              balance.owner === walletAddress &&
              balance.mint === tokenMint
          );

          if (tokenBalance?.uiTokenAmount?.uiAmount) {
            outputAmount = tokenBalance.uiTokenAmount.uiAmount;
            logger.info({
              signature,
              outputAmount,
              decimals: tokenBalance.uiTokenAmount.decimals,
            }, 'Parsed token amount from transaction postTokenBalances');
          }
        }
      } catch (parseError) {
        logger.warn({ signature, error: parseError }, 'Failed to parse transaction for token amount');
      }

      logger.info({ signature, amountSol, outputAmount }, 'PumpFun buy successful');

      return {
        success: true,
        signature,
        inputAmount: amountSol * LAMPORTS_PER_SOL,
        outputAmount,
        priceImpact: 0,
        fees: {
          platformFee: amountSol * LAMPORTS_PER_SOL * 0.01, // 1% pump.fun fee
          networkFee: 5000,
          priorityFee: priorityFee * LAMPORTS_PER_SOL,
          totalFee: amountSol * LAMPORTS_PER_SOL * 0.01 + 5000 + priorityFee * LAMPORTS_PER_SOL,
        },
        timestamp: new Date(),
      };
    } catch (error: any) {
      logger.error({ error: error.message }, 'PumpFun buy failed');
      return this.errorResult(amountSol * LAMPORTS_PER_SOL, error.message);
    }
  }

  async sell(
    tokenMint: string,
    amountTokens: number,
    slippagePct: number = config.defaultSlippageBps / 100,  // Convert bps to %
    priorityFee: number = config.priorityFeeSol
  ): Promise<SwapResult> {
    if (!this.wallet) {
      return this.errorResult(0, 'Wallet not initialized');
    }

    // Paper trading simulation
    if (config.paperTrading) {
      return this.simulateSell(tokenMint, amountTokens, slippagePct);
    }

    try {
      logger.info({ mint: tokenMint, amountTokens, slippage: slippagePct }, 'Executing PumpFun sell');

      const response = await fetch(`${PUMPPORTAL_API_URL}/trade-local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: this.wallet.publicKey.toBase58(),
          action: 'sell',
          mint: tokenMint,
          amount: amountTokens,
          denominatedInSol: 'false',
          slippage: slippagePct,
          priorityFee: priorityFee,
          pool: 'auto', // Auto-detect if on bonding curve or Raydium
        } as PumpPortalTradeRequest),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'PumpPortal sell request failed');
        return this.errorResult(0, `Sell request failed: ${response.status}`);
      }

      // PumpPortal returns raw transaction bytes directly, not JSON
      const arrayBuffer = await response.arrayBuffer();
      const txData = new Uint8Array(arrayBuffer);

      // Check if response is actually JSON error
      if (txData.length < 100) {
        const text = new TextDecoder().decode(txData);
        try {
          const jsonError = JSON.parse(text);
          if (jsonError.error) {
            return this.errorResult(0, jsonError.error);
          }
        } catch {
          // Not JSON, continue with deserialization
        }
      }

      logger.debug({ bytes: txData.length }, 'Received raw transaction bytes');

      // Deserialize and sign
      const transaction = VersionedTransaction.deserialize(txData);
      transaction.sign([this.wallet]);

      // Send transaction
      const signature = await this.connection.sendRawTransaction(
        transaction.serialize(),
        { skipPreflight: true, maxRetries: 3 }
      );

      logger.info({ signature }, 'PumpFun sell transaction sent');

      // Confirm
      const latestBlockhash = await this.connection.getLatestBlockhash();
      const confirmation = await this.connection.confirmTransaction(
        { signature, ...latestBlockhash },
        'confirmed'
      );

      if (confirmation.value.err) {
        return this.errorResult(
          0,
          `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
          signature
        );
      }

      logger.info({ signature, amountTokens }, 'PumpFun sell successful');

      return {
        success: true,
        signature,
        inputAmount: amountTokens,
        outputAmount: 0, // SOL received, will be calculated
        priceImpact: 0,
        fees: {
          platformFee: 0, // Calculated based on output
          networkFee: 5000,
          priorityFee: priorityFee * LAMPORTS_PER_SOL,
          totalFee: 5000 + priorityFee * LAMPORTS_PER_SOL,
        },
        timestamp: new Date(),
      };
    } catch (error: any) {
      logger.error({ error: error.message }, 'PumpFun sell failed');
      return this.errorResult(0, error.message);
    }
  }

  private async simulateBuy(
    tokenMint: string,
    amountSol: number,
    slippagePct: number
  ): Promise<SwapResult> {
    // Simulate buying on bonding curve
    // In reality, tokens received depends on bonding curve state
    const estimatedTokens = amountSol * 1_000_000; // Rough estimate for new tokens

    logger.info({
      mode: 'PAPER',
      action: 'buy',
      mint: tokenMint,
      amountSol,
      estimatedTokens,
    }, 'Paper PumpFun buy');

    return {
      success: true,
      signature: `PAPER_PUMP_BUY_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      inputAmount: amountSol * LAMPORTS_PER_SOL,
      outputAmount: estimatedTokens,
      priceImpact: 0.5, // Estimate
      fees: {
        platformFee: amountSol * LAMPORTS_PER_SOL * 0.01,
        networkFee: 5000,
        priorityFee: 0,
        totalFee: amountSol * LAMPORTS_PER_SOL * 0.01 + 5000,
      },
      timestamp: new Date(),
    };
  }

  private async simulateSell(
    tokenMint: string,
    amountTokens: number,
    slippagePct: number
  ): Promise<SwapResult> {
    // Simulate selling on bonding curve
    const estimatedSol = amountTokens / 1_000_000; // Rough estimate

    logger.info({
      mode: 'PAPER',
      action: 'sell',
      mint: tokenMint,
      amountTokens,
      estimatedSol,
    }, 'Paper PumpFun sell');

    return {
      success: true,
      signature: `PAPER_PUMP_SELL_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      inputAmount: amountTokens,
      outputAmount: estimatedSol * LAMPORTS_PER_SOL,
      priceImpact: 0.5,
      fees: {
        platformFee: estimatedSol * LAMPORTS_PER_SOL * 0.01,
        networkFee: 5000,
        priorityFee: 0,
        totalFee: estimatedSol * LAMPORTS_PER_SOL * 0.01 + 5000,
      },
      timestamp: new Date(),
    };
  }

  private errorResult(inputAmount: number, error: string, signature?: string): SwapResult {
    return {
      success: false,
      signature,
      inputAmount,
      outputAmount: 0,
      priceImpact: 0,
      fees: { platformFee: 0, networkFee: 0, priorityFee: 0, totalFee: 0 },
      error,
      timestamp: new Date(),
    };
  }

  getWalletAddress(): string | null {
    return this.wallet?.publicKey.toBase58() || null;
  }
}

export const pumpFunSwap = new PumpFunSwap();
