import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { createChildLogger } from '../utils/logger';
import { config, LAMPORTS_PER_SOL } from '../config/settings';
import { JitoBundleResult } from './types';

const logger = createChildLogger('jito-bundle');

interface JitoTipAccount {
  address: string;
}

export class JitoBundle {
  private connection: Connection;
  private wallet: Keypair | null = null;
  private tipAccounts: string[] = [];

  constructor() {
    this.connection = new Connection(config.solanaRpcUrl, 'confirmed');
  }

  async initialize(): Promise<void> {
    if (config.privateKey) {
      try {
        const secretKey = bs58.decode(config.privateKey);
        this.wallet = Keypair.fromSecretKey(secretKey);
      } catch (error) {
        logger.error({ error }, 'Failed to initialize wallet');
      }
    }

    // Fetch tip accounts
    await this.fetchTipAccounts();
  }

  private async fetchTipAccounts(): Promise<void> {
    try {
      const response = await fetch(`${config.jitoBundleApi}/tip_accounts`);

      if (!response.ok) {
        throw new Error(`Failed to fetch tip accounts: ${response.status}`);
      }

      const data = await response.json() as string[];
      this.tipAccounts = data;

      logger.info({ count: this.tipAccounts.length }, 'Tip accounts loaded');
    } catch (error) {
      logger.error({ error }, 'Failed to fetch tip accounts');
      // Fallback tip accounts
      this.tipAccounts = [
        '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
        'HFqU5x63VTqvQss8hp11i4bVmkdzGR3EXvgWyqD7njDr',
        'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
        'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
        'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
      ];
    }
  }

  getRandomTipAccount(): string {
    const index = Math.floor(Math.random() * this.tipAccounts.length);
    return this.tipAccounts[index];
  }

  async createTipTransaction(tipLamports: number): Promise<VersionedTransaction | null> {
    if (!this.wallet) {
      logger.error('Wallet not initialized');
      return null;
    }

    try {
      const tipAccount = this.getRandomTipAccount();
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();

      const tipInstruction = SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: tipLamports,
      });

      const messageV0 = new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [tipInstruction],
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([this.wallet]);

      return transaction;
    } catch (error) {
      logger.error({ error }, 'Failed to create tip transaction');
      return null;
    }
  }

  async sendBundle(transactions: VersionedTransaction[]): Promise<JitoBundleResult> {
    if (!config.enableJito) {
      return {
        success: false,
        signatures: [],
        tipAmount: 0,
        error: 'Jito disabled',
      };
    }

    try {
      // Create tip transaction
      const tipTx = await this.createTipTransaction(config.jitoTipLamports);

      if (!tipTx) {
        return {
          success: false,
          signatures: [],
          tipAmount: config.jitoTipLamports,
          error: 'Failed to create tip transaction',
        };
      }

      // Add tip transaction to bundle
      const bundleTxs = [...transactions, tipTx];

      // Serialize transactions
      const encodedTransactions = bundleTxs.map((tx) =>
        bs58.encode(tx.serialize())
      );

      // Send bundle
      const response = await fetch(config.jitoBundleApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [encodedTransactions],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Bundle submission failed');
        return {
          success: false,
          signatures: [],
          tipAmount: config.jitoTipLamports,
          error: `Bundle submission failed: ${response.status}`,
        };
      }

      const data = await response.json() as any;

      if (data.error) {
        return {
          success: false,
          signatures: [],
          tipAmount: config.jitoTipLamports,
          error: data.error.message,
        };
      }

      const bundleId = data.result;

      logger.info({ bundleId }, 'Bundle submitted');

      // Poll for bundle status
      const result = await this.pollBundleStatus(bundleId);

      return {
        ...result,
        tipAmount: config.jitoTipLamports,
      };
    } catch (error: any) {
      logger.error({ error: error.message }, 'Bundle execution failed');
      return {
        success: false,
        signatures: [],
        tipAmount: config.jitoTipLamports,
        error: error.message,
      };
    }
  }

  private async pollBundleStatus(bundleId: string): Promise<JitoBundleResult> {
    const maxAttempts = 30;
    const pollInterval = 500;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(config.jitoBundleApi, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          }),
        });

        const data = await response.json() as any;

        if (data.result?.value?.[0]) {
          const status = data.result.value[0];

          if (status.confirmation_status === 'finalized' || status.confirmation_status === 'confirmed') {
            logger.info({ bundleId, status: status.confirmation_status, slot: status.slot }, 'Bundle landed');

            return {
              success: true,
              bundleId,
              signatures: status.transactions || [],
              tipAmount: config.jitoTipLamports,
              landedSlot: status.slot,
            };
          }

          if (status.err) {
            return {
              success: false,
              bundleId,
              signatures: [],
              tipAmount: config.jitoTipLamports,
              error: `Bundle failed: ${JSON.stringify(status.err)}`,
            };
          }
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } catch (error) {
        logger.debug({ bundleId, attempt, error }, 'Poll attempt failed');
      }
    }

    return {
      success: false,
      bundleId,
      signatures: [],
      tipAmount: config.jitoTipLamports,
      error: 'Bundle status poll timeout',
    };
  }

  async getBundleStatus(bundleId: string): Promise<any> {
    try {
      const response = await fetch(config.jitoBundleApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        }),
      });

      const data = await response.json() as any;
      return data.result?.value?.[0] || null;
    } catch (error) {
      logger.error({ bundleId, error }, 'Failed to get bundle status');
      return null;
    }
  }

  isEnabled(): boolean {
    return config.enableJito && this.tipAccounts.length > 0;
  }

  getRecommendedTip(): number {
    // Could be dynamic based on network conditions
    return config.jitoTipLamports;
  }
}

export const jitoBundle = new JitoBundle();
