import { EventEmitter } from 'events';
import { config, LAMPORTS_PER_SOL } from '../config/settings';
import { createChildLogger } from '../utils/logger';
import { WhaleActivity } from './types';
import { repository } from '../db/repository';

const logger = createChildLogger('whale-tracker');

interface SignatureInfo {
  signature: string;
  slot: number;
  err: null | object;
  memo: string | null;
  blockTime: number | null;
}

interface ParsedTransaction {
  signature: string;
  slot: number;
  blockTime: number;
  meta: {
    preBalances: number[];
    postBalances: number[];
    preTokenBalances: Array<{
      accountIndex: number;
      mint: string;
      owner: string;
      uiTokenAmount: { amount: string; decimals: number; uiAmount: number };
    }>;
    postTokenBalances: Array<{
      accountIndex: number;
      mint: string;
      owner: string;
      uiTokenAmount: { amount: string; decimals: number; uiAmount: number };
    }>;
    err: null | object;
  };
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean }>;
    };
  };
}

const KNOWN_WHALES: { address: string; label: string }[] = [
  // Add known whale addresses here
  // These would be discovered through on-chain analysis
];

export class WhaleTracker extends EventEmitter {
  private trackedWallets: Map<string, string> = new Map(); // address -> label
  private lastSignatures: Map<string, string> = new Map(); // address -> last signature
  private pollInterval: NodeJS.Timeout | null = null;
  private minTransactionSol = 1; // LOWERED: Minimum SOL value to track (was 10 - missed smaller trades)

  constructor() {
    super();
  }

  async start(): Promise<void> {
    // Load known whales from config/env
    if (process.env.COPY_TRADE_WALLETS) {
      const envWallets = process.env.COPY_TRADE_WALLETS.split(',').map(w => w.trim()).filter(w => w.length > 0);
      for (const wallet of envWallets) {
        if (!this.trackedWallets.has(wallet)) {
          this.addWhale(wallet, 'Env Configured');
        }
      }
      logger.info({ count: envWallets.length }, 'Loaded wallets from environment');
    }

    // Load known whales from constant
    for (const whale of KNOWN_WHALES) {
      this.trackedWallets.set(whale.address, whale.label);
      await repository.upsertWhaleWallet(whale.address, whale.label);
    }

    // Start polling
    this.pollInterval = setInterval(() => {
      this.pollWhaleActivity();
    }, 10000); // Poll every 10 seconds

    logger.info({ whaleCount: this.trackedWallets.size }, 'Whale tracker started');
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    logger.info('Whale tracker stopped');
  }

  addWhale(address: string, label?: string): void {
    this.trackedWallets.set(address, label || 'Unknown');
    repository.upsertWhaleWallet(address, label);
    logger.info({ address, label }, 'Added whale to tracking');
  }

  removeWhale(address: string): void {
    this.trackedWallets.delete(address);
    this.lastSignatures.delete(address);
    logger.info({ address }, 'Removed whale from tracking');
  }

  private async pollWhaleActivity(): Promise<void> {
    const promises = Array.from(this.trackedWallets.entries()).map(([address, label]) =>
      this.checkWalletActivity(address, label).catch((err) =>
        logger.error({ address, error: err.message }, 'Failed to check whale activity')
      )
    );

    await Promise.all(promises);
  }

  private async checkWalletActivity(address: string, label: string): Promise<void> {
    try {
      const lastSig = this.lastSignatures.get(address);

      // Get recent signatures
      const response = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getSignaturesForAddress',
            params: [
              address,
              { limit: 20, until: lastSig },
            ],
          }),
        }
      );

      const data = await response.json() as any;
      const signatures: SignatureInfo[] = data.result || [];

      if (signatures.length === 0) return;

      // Update last signature
      this.lastSignatures.set(address, signatures[0].signature);

      // Process new transactions
      for (const sig of signatures) {
        if (sig.err) continue; // Skip failed transactions

        await this.processTransaction(address, label, sig.signature);
      }
    } catch (error) {
      logger.error({ address, error }, 'Failed to check wallet activity');
    }
  }

  private async processTransaction(
    walletAddress: string,
    label: string,
    signature: string
  ): Promise<void> {
    try {
      const response = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [
              signature,
              { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
            ],
          }),
        }
      );

      const data = await response.json() as any;
      const tx: ParsedTransaction = data.result;

      if (!tx || !tx.meta) return;

      // Calculate SOL transfer
      const accountKeys = tx.transaction.message.accountKeys;
      const walletIndex = accountKeys.findIndex((k) => k.pubkey === walletAddress);

      if (walletIndex === -1) return;

      const preSol = tx.meta.preBalances[walletIndex] / LAMPORTS_PER_SOL;
      const postSol = tx.meta.postBalances[walletIndex] / LAMPORTS_PER_SOL;
      const solChange = postSol - preSol;

      // Check token transfers
      const preTokens = tx.meta.preTokenBalances?.filter(
        (t) => t.owner === walletAddress
      ) || [];
      const postTokens = tx.meta.postTokenBalances?.filter(
        (t) => t.owner === walletAddress
      ) || [];

      // Find token changes
      const tokenChanges: Map<string, { pre: number; post: number }> = new Map();

      for (const token of preTokens) {
        tokenChanges.set(token.mint, {
          pre: token.uiTokenAmount.uiAmount || 0,
          post: 0,
        });
      }

      for (const token of postTokens) {
        const existing = tokenChanges.get(token.mint);
        if (existing) {
          existing.post = token.uiTokenAmount.uiAmount || 0;
        } else {
          tokenChanges.set(token.mint, {
            pre: 0,
            post: token.uiTokenAmount.uiAmount || 0,
          });
        }
      }

      // Process significant token changes
      for (const [mint, change] of tokenChanges.entries()) {
        const tokenChange = change.post - change.pre;

        if (tokenChange === 0) continue;

        // Skip if SOL change is too small
        if (Math.abs(solChange) < this.minTransactionSol) continue;

        const action: 'buy' | 'sell' = tokenChange > 0 ? 'buy' : 'sell';

        const activity: WhaleActivity = {
          wallet: walletAddress,
          action,
          mint,
          amount: Math.abs(tokenChange),
          amountSol: Math.abs(solChange),
          timestamp: new Date(tx.blockTime! * 1000),
        };

        logger.info(
          { wallet: label, action, mint, amountSol: activity.amountSol },
          'Whale activity detected'
        );

        // Log to database
        await repository.logWhaleActivity({
          wallet: walletAddress,
          action,
          mint,
          amount: activity.amount,
          amount_sol: activity.amountSol,
          signature,
        });

        // Emit event
        this.emit('whaleActivity', activity);
      }
    } catch (error) {
      logger.error({ signature, error }, 'Failed to process transaction');
    }
  }

  async discoverWhales(mint: string, minSolVolume: number = 50): Promise<string[]> {
    try {
      // Get recent large transactions for a token
      const response = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getSignaturesForAddress',
            params: [mint, { limit: 100 }],
          }),
        }
      );

      const data = await response.json() as any;
      const signatures: SignatureInfo[] = data.result || [];

      const discoveredWhales: Set<string> = new Set();

      for (const sig of signatures.slice(0, 20)) {
        // Limit processing
        if (sig.err) continue;

        // Get transaction details and extract large traders
        // This is simplified - real implementation would analyze more deeply
        const txResponse = await fetch(
          `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getTransaction',
              params: [
                sig.signature,
                { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
              ],
            }),
          }
        );

        const txData = await txResponse.json() as any;
        const tx: ParsedTransaction = txData.result;

        if (!tx?.meta) continue;

        // Find signers with large SOL changes
        for (let i = 0; i < tx.meta.preBalances.length; i++) {
          const solChange =
            Math.abs(tx.meta.postBalances[i] - tx.meta.preBalances[i]) / LAMPORTS_PER_SOL;

          if (solChange >= minSolVolume) {
            const address = tx.transaction.message.accountKeys[i].pubkey;
            discoveredWhales.add(address);
          }
        }
      }

      const whaleList = Array.from(discoveredWhales);
      logger.info({ mint, count: whaleList.length }, 'Discovered potential whales');

      return whaleList;
    } catch (error) {
      logger.error({ mint, error }, 'Failed to discover whales');
      return [];
    }
  }
}

export const whaleTracker = new WhaleTracker();
