import { createChildLogger } from '../utils/logger';
import { TokenInfo, HolderInfo, LiquidityPool } from '../data/types';
import { RugScore } from './types';
import { config } from '../config/settings';

const logger = createChildLogger('rug-detector');

export class RugDetector {
  private bundledBuysCache: Map<string, boolean> = new Map();

  constructor() {}

  async analyzeToken(
    mint: string,
    tokenInfo: TokenInfo | null,
    holderInfo: HolderInfo | null,
    lpInfo: LiquidityPool | null
  ): Promise<RugScore> {
    const details: string[] = [];
    let total = 0;

    // Check if this is a Pump.fun token (program controls mint/freeze)
    const isPumpFunToken = mint.endsWith('pump');

    // Mint authority check (25 points)
    let mintAuthorityScore = 0;
    if (tokenInfo?.mintAuthorityRevoked) {
      mintAuthorityScore = 25;
      details.push('✓ Mint authority revoked (+25)');
    } else if (isPumpFunToken) {
      // Pump.fun program controls mint authority - inherently safe
      mintAuthorityScore = 25;
      details.push('✓ Pump.fun token - mint controlled by program (+25)');
    } else {
      details.push('✗ Mint authority NOT revoked (0)');
    }
    total += mintAuthorityScore;

    // Freeze authority check (20 points)
    let freezeAuthorityScore = 0;
    if (tokenInfo?.freezeAuthorityRevoked) {
      freezeAuthorityScore = 20;
      details.push('✓ Freeze authority revoked (+20)');
    } else if (isPumpFunToken) {
      // Pump.fun program controls freeze authority - inherently safe
      freezeAuthorityScore = 20;
      details.push('✓ Pump.fun token - freeze controlled by program (+20)');
    } else {
      details.push('✗ Freeze authority NOT revoked (0)');
    }
    total += freezeAuthorityScore;

    // LP locked check (25 points)
    let lpLockedScore = 0;
    if (lpInfo?.lpLocked) {
      lpLockedScore = 25;
      details.push(`✓ LP locked (${(lpInfo.lpLockedPercent * 100).toFixed(1)}%) (+25)`);
    } else if (lpInfo) {
      // Partial points for high liquidity
      const liquidityScore = Math.min((lpInfo.liquiditySol / 100) * 10, 10);
      lpLockedScore = liquidityScore;
      details.push(`~ LP not locked, but ${lpInfo.liquiditySol.toFixed(1)} SOL liquidity (+${liquidityScore.toFixed(0)})`);
    } else {
      details.push('✗ No LP info available (0)');
    }
    total += lpLockedScore;

    // Top 10 concentration check (15 points)
    let concentrationScore = 0;
    if (holderInfo) {
      const concentration = holderInfo.top10Concentration;
      if (concentration <= 0.30) {
        concentrationScore = 15;
        details.push(`✓ Top 10 hold ${(concentration * 100).toFixed(1)}% (<30%) (+15)`);
      } else if (concentration <= 0.50) {
        concentrationScore = 10;
        details.push(`~ Top 10 hold ${(concentration * 100).toFixed(1)}% (30-50%) (+10)`);
      } else if (concentration <= 0.70) {
        concentrationScore = 5;
        details.push(`! Top 10 hold ${(concentration * 100).toFixed(1)}% (50-70%) (+5)`);
      } else {
        details.push(`✗ Top 10 hold ${(concentration * 100).toFixed(1)}% (>70%) (0)`);
      }
    } else {
      details.push('✗ No holder info available (0)');
    }
    total += concentrationScore;

    // Bundled buys check (15 points)
    let bundledBuysScore = 0;
    const hasBundledBuys = await this.checkBundledBuys(mint);
    if (!hasBundledBuys) {
      bundledBuysScore = 15;
      details.push('✓ No suspicious bundled buys detected (+15)');
    } else {
      details.push('✗ Bundled buys detected - potential coordinated buying (0)');
    }
    total += bundledBuysScore;

    const rugScore: RugScore = {
      total,
      mintAuthorityScore,
      freezeAuthorityScore,
      lpLockedScore,
      concentrationScore,
      bundledBuysScore,
      details,
    };

    logger.info({ mint, score: total }, 'Rug score calculated');

    return rugScore;
  }

  isSafe(rugScore: RugScore): boolean {
    return rugScore.total >= config.minRugScore;
  }

  private async checkBundledBuys(mint: string): Promise<boolean> {
    // Check cache first
    if (this.bundledBuysCache.has(mint)) {
      return this.bundledBuysCache.get(mint)!;
    }

    try {
      // Fetch recent transactions and analyze for bundled patterns
      const response = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getSignaturesForAddress',
            params: [mint, { limit: 50 }],
          }),
        }
      );

      const data = await response.json() as any;
      const signatures = data.result || [];

      // Group transactions by block slot
      const slotGroups: Map<number, number> = new Map();
      for (const sig of signatures) {
        const count = slotGroups.get(sig.slot) || 0;
        slotGroups.set(sig.slot, count + 1);
      }

      // Check for bundled transactions (multiple in same slot)
      let bundledCount = 0;
      for (const count of slotGroups.values()) {
        if (count >= 3) {
          bundledCount++;
        }
      }

      // Flag if >20% of slots have bundled transactions
      const hasBundledBuys = bundledCount > slotGroups.size * 0.2;

      this.bundledBuysCache.set(mint, hasBundledBuys);
      return hasBundledBuys;
    } catch (error) {
      logger.error({ mint, error }, 'Failed to check bundled buys');
      return false; // Assume safe on error
    }
  }

  async checkCreatorHistory(creator: string): Promise<{
    tokenCount: number;
    rugCount: number;
    successRate: number;
  }> {
    try {
      // This would analyze creator's history of token launches
      // Simplified implementation
      const response = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getSignaturesForAddress',
            params: [creator, { limit: 100 }],
          }),
        }
      );

      const data = await response.json() as any;
      const signatures = data.result || [];

      // Count unique token interactions (simplified)
      const uniqueTokens = new Set<string>();
      // Would need to parse transactions to extract token mints

      return {
        tokenCount: uniqueTokens.size,
        rugCount: 0, // Would need historical analysis
        successRate: 0.5, // Default neutral
      };
    } catch (error) {
      logger.error({ creator, error }, 'Failed to check creator history');
      return { tokenCount: 0, rugCount: 0, successRate: 0.5 };
    }
  }

  getQuickSafetyFlags(tokenInfo: TokenInfo | null, mint?: string): {
    isSafe: boolean;
    flags: string[];
  } {
    const flags: string[] = [];
    let isSafe = true;

    // Pump.fun tokens (ending in "pump") are inherently safe from mint/freeze authority
    // The Pump.fun program controls these - creators cannot mint or freeze
    const isPumpFunToken = mint?.endsWith('pump');

    if (!tokenInfo) {
      if (isPumpFunToken) {
        // Pump.fun tokens are safe by design - skip token info check
        flags.push('INFO: Pump.fun token - inherently safe');
        return { isSafe: true, flags };
      }
      return { isSafe: false, flags: ['No token info available'] };
    }

    if (!tokenInfo.mintAuthorityRevoked && !isPumpFunToken) {
      flags.push('WARN: Mint authority not revoked');
      isSafe = false;
    }

    if (!tokenInfo.freezeAuthorityRevoked && !isPumpFunToken) {
      flags.push('WARN: Freeze authority not revoked');
      // Not critical but noteworthy
    }

    return { isSafe, flags };
  }

  clearCache(mint?: string): void {
    if (mint) {
      this.bundledBuysCache.delete(mint);
    } else {
      this.bundledBuysCache.clear();
    }
  }

  /**
   * Check if LP tokens are locked/burned for a token
   * Returns LiquidityPool info with lpLocked status
   */
  async checkLpLocked(mint: string, poolAddress?: string): Promise<{
    lpLocked: boolean;
    lpLockedPercent: number;
    liquiditySol: number;
    reason: string;
  }> {
    try {
      // Known burn addresses for Solana
      const BURN_ADDRESSES = [
        '1111111111111111111111111111111111111111111',  // System program (null address)
        '1nc1nerator11111111111111111111111111111111',  // Incinerator
        '11111111111111111111111111111111',              // Short burn address
      ];

      // Known lock protocols on Solana
      const LOCK_PROTOCOLS = [
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // SPL Token
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
        // Streamflow vesting
        'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m',
        // Squads multisig (often used for lock)
        'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu',
      ];

      // Try to get LP pool info from DexScreener
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { headers: { 'Accept': 'application/json' } }
      );

      if (!response.ok) {
        logger.debug({ mint }, 'Failed to fetch DexScreener data for LP check');
        return { lpLocked: false, lpLockedPercent: 0, liquiditySol: 0, reason: 'Failed to fetch data' };
      }

      const data = await response.json() as any;
      const pairs = data.pairs || [];

      if (pairs.length === 0) {
        return { lpLocked: false, lpLockedPercent: 0, liquiditySol: 0, reason: 'No pairs found' };
      }

      // Get the main pair (usually Raydium or Orca)
      const mainPair = pairs.find((p: any) =>
        p.dexId === 'raydium' || p.dexId === 'orca' || p.dexId === 'pump'
      ) || pairs[0];

      const liquiditySol = mainPair.liquidity?.usd
        ? (mainPair.liquidity.usd / (mainPair.priceNative || 1)) / 1000  // Rough SOL estimate
        : 0;

      // Check if liquidity is locked via DexScreener info (if available)
      const liquidityInfo = mainPair.liquidity || {};
      if (liquidityInfo.locked) {
        return {
          lpLocked: true,
          lpLockedPercent: liquidityInfo.lockedPercent || 1,
          liquiditySol,
          reason: `LP locked (${(liquidityInfo.lockedPercent * 100 || 100).toFixed(0)}%)`
        };
      }

      // For Pump.fun tokens, LP is managed by the bonding curve (effectively locked)
      if (mint.endsWith('pump') || mainPair.dexId === 'pump') {
        return {
          lpLocked: true,
          lpLockedPercent: 1,
          liquiditySol,
          reason: 'Pump.fun bonding curve (inherently locked)'
        };
      }

      // If we have a pool address, we can do additional on-chain checks
      if (poolAddress) {
        const lpCheckResult = await this.checkLpTokensBurned(poolAddress);
        if (lpCheckResult.burned) {
          return {
            lpLocked: true,
            lpLockedPercent: lpCheckResult.burnedPercent,
            liquiditySol,
            reason: `LP tokens burned (${(lpCheckResult.burnedPercent * 100).toFixed(0)}%)`
          };
        }
      }

      // Default: cannot confirm LP is locked
      return {
        lpLocked: false,
        lpLockedPercent: 0,
        liquiditySol,
        reason: 'LP lock status unknown'
      };

    } catch (error) {
      logger.error({ mint, error }, 'Error checking LP lock status');
      return { lpLocked: false, lpLockedPercent: 0, liquiditySol: 0, reason: 'Error checking LP' };
    }
  }

  /**
   * Check if LP tokens have been burned by querying token account holders
   */
  private async checkLpTokensBurned(lpMint: string): Promise<{
    burned: boolean;
    burnedPercent: number;
  }> {
    try {
      const response = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTokenLargestAccounts',
            params: [lpMint],
          }),
        }
      );

      const data = await response.json() as any;
      const accounts = data.result?.value || [];

      if (accounts.length === 0) {
        return { burned: false, burnedPercent: 0 };
      }

      // Check if any large holders are burn addresses
      const BURN_PATTERNS = ['1111111111111111111111111111', '1nc1nerator', 'burn', 'dead'];
      let totalSupply = 0;
      let burnedSupply = 0;

      for (const account of accounts) {
        const amount = parseFloat(account.amount) || 0;
        totalSupply += amount;

        // Check if this is a burn address
        const address = account.address?.toLowerCase() || '';
        const isBurned = BURN_PATTERNS.some(pattern => address.includes(pattern.toLowerCase()));

        if (isBurned) {
          burnedSupply += amount;
        }
      }

      const burnedPercent = totalSupply > 0 ? burnedSupply / totalSupply : 0;

      return {
        burned: burnedPercent >= 0.5, // Consider locked if >50% burned
        burnedPercent,
      };

    } catch (error) {
      logger.debug({ lpMint, error }, 'Failed to check LP token burn status');
      return { burned: false, burnedPercent: 0 };
    }
  }
}

export const rugDetector = new RugDetector();
