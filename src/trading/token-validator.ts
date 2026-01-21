import { dexscreener, type TokenMetadata } from '../api/dexscreener.js';
import { createLogger } from '../lib/logger.js';
import type { RiskProfile } from './types.js';
import type { PumpNewTokenEvent } from '../api/pumpportal-data.js';

const logger = createLogger('token-validator');

export interface ValidationResult {
  mint: string;
  passes: boolean;
  reason?: string;
  metadata?: TokenMetadata;
  isBondingCurve?: boolean; // True if validated via bonding curve data
}

export interface BondingCurveValidationResult {
  mint: string;
  passes: boolean;
  reason?: string;
  marketCapSol: number;
  bondingProgress: number; // 0-100% progress toward graduation
}

export interface ValidatorConfig {
  riskProfile: RiskProfile;
  minLiquidityUsd?: number; // Overrides risk profile if set
  minVolume1hUsd?: number;  // Overrides risk profile if set
  requireSocials: boolean;
}

const DEFAULT_CONFIG: ValidatorConfig = {
  riskProfile: 'BALANCED',
  requireSocials: false,
};

// Graduation threshold: ~400 SOL in bonding curve = ~$69k market cap
const GRADUATION_THRESHOLD_SOL = 400;

/**
 * TokenValidator
 * Validates tokens using DexScreener data to ensure quality before trading
 */
export class TokenValidator {
  private config: ValidatorConfig;

  constructor(config: Partial<ValidatorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info({ config: this.config }, 'TokenValidator initialized');
  }

  /**
   * Validate a token
   */
  async validate(mint: string): Promise<ValidationResult> {
    try {
      // Fetch metadata from DexScreener
      const metadata = await dexscreener.getTokenMetadata(mint);

      if (!metadata) {
        return {
          mint,
          passes: false,
          reason: 'No DexScreener data found (too new or dead)',
        };
      }

      // 1. RISK DIAL SETTINGS
      const profile = this.config.riskProfile;
      
      const liquidityThresholds = {
        CONSERVATIVE: 15000,
        BALANCED: 5000,
        AGGRESSIVE: 1500,
        ENTERTAINMENT: 500, // Very low threshold for micro bets
      };

      const maxAgeMinutes = {
        CONSERVATIVE: 15,
        BALANCED: 8,
        AGGRESSIVE: 3,
        ENTERTAINMENT: 60, // Allow older tokens for entertainment
      };

      const minBuyPressure = {
        CONSERVATIVE: 1.8,
        BALANCED: 1.0,
        AGGRESSIVE: 1.05,
        ENTERTAINMENT: 0.8, // Lower threshold - just needs some activity
      };

      // Determine active thresholds
      const minLiquidity = this.config.minLiquidityUsd || liquidityThresholds[profile];
      const maxAge = maxAgeMinutes[profile];
      const pressureThreshold = minBuyPressure[profile];
      const minVolume = this.config.minVolume1hUsd || minLiquidity; // Volume should match liquidity roughly

      // Check 1: Liquidity
      if (metadata.liquidity < minLiquidity) {
        return {
          mint,
          passes: false,
          reason: `Low liquidity: $${metadata.liquidity.toFixed(0)} < $${minLiquidity} (${profile})`,
          metadata,
        };
      }

      // Check 2: Age (Sniping Window)
      // IF we are AGGRESSIVE, we want FRESH tokens (age < maxAge). 
      // Existing logic (minAge) was to avoid scams. New logic (maxAge) is to catch pumps.
      // BUT, we should probably support both flows.
      // For this specific 'Sniper' flow, passing a token means it is READY to buy.
      
      // If we are 'sniping', we want tokens that are YOUNG enough to be early, 
      // but OLD enough to have some data. 
      // Actually, the new prompt says: "If ageMinutes <= maxAgeMinutes -> allow".
      // This implies we ONLY want young tokens for this strategy.
      if (metadata.ageMinutes && metadata.ageMinutes > maxAge) {
         // Optionally, we could allow older tokens if they have massive volume?
         // For now, stick to the prompt: strict age window for 'Sniping'
         // result: `Too old for ${profile} entry: ${metadata.ageMinutes}m > ${maxAge}m limit`,
         // BUT user requested to remove age filter entirely, so we log but DO NOT REJECT
         if (metadata.ageMinutes > maxAge) {
             logger.debug({ mint, age: metadata.ageMinutes, maxAge }, 'Token older than maxAge - proceeding anyway due to relaxed filter');
         }
         /*
         return {
            mint,
            passes: false,
            reason: `Too old for ${profile} entry: ${metadata.ageMinutes}m > ${maxAge}m limit`,
            metadata
         };
         */
      }

      // Check 3: Buy Pressure (New)
      // buyPressure = buys5m / Math.max(1, sells5m)
      const buys = metadata.buys5m || 0;
      const sells = metadata.sells5m || 0;
      const buyPressure = buys / Math.max(1, sells);
      
      if (buyPressure < pressureThreshold) {
          return {
              mint,
              passes: false,
              reason: `Weak buy pressure: ${buyPressure.toFixed(2)} < ${pressureThreshold} (${profile})`,
              metadata
          }
      }

      // Check 4: Volume
      const volumeScore = metadata.volume1h > 0 
        ? metadata.volume1h 
        : (metadata.volume24h > 0 ? metadata.volume24h : metadata.buys5m * 100); 

      if (volumeScore < minVolume) {
        return {
          mint,
          passes: false,
          reason: `Low volume: $${volumeScore.toFixed(0)} < $${minVolume}`,
          metadata,
        };
      }

      // Check 5: Suspicious Patterns (Rug Check)
      if (metadata.priceChange1h < -90) {
        return {
          mint,
          passes: false,
          reason: `Rug detected: Price down ${metadata.priceChange1h.toFixed(1)}% in 1h`,
          metadata,
        };
      }

      return {
        mint,
        passes: true,
        metadata,
      };

    } catch (error) {
      logger.error({ mint, error }, 'Error validating token');
      return {
        mint,
        passes: false,
        reason: 'Validation error',
      };
    }
  }

  /**
   * Validate a bonding curve token using PumpPortal data
   * This is for tokens still on the pump.fun bonding curve (not yet graduated)
   */
  validateBondingCurve(token: PumpNewTokenEvent): BondingCurveValidationResult {
    const profile = this.config.riskProfile;

    // Calculate bonding progress (0-100%)
    // Tokens graduate at ~400 SOL in bonding curve
    const bondingProgress = Math.min(100, (token.vSolInBondingCurve / GRADUATION_THRESHOLD_SOL) * 100);

    // Market cap thresholds in SOL (since bonding curve tokens are priced in SOL)
    // Most tokens start at ~28 SOL mcap - thresholds set to catch early momentum
    const minMarketCapSol = {
      CONSERVATIVE: 50,    // ~$8.5k at $170/SOL
      BALANCED: 28,        // ~$4.8k - catch early momentum (lowered from 30 to match reality)
      AGGRESSIVE: 28,      // ~$4.8k - very early entry
      ENTERTAINMENT: 0,    // No minimum - catch everything
    };

    // Minimum bonding progress (% toward graduation)
    // Lower thresholds - we want to catch tokens with some momentum
    const minBondingProgress = {
      CONSERVATIVE: 15,    // 15% = ~60 SOL in curve
      BALANCED: 5,         // 5% = ~20 SOL in curve
      AGGRESSIVE: 2,       // 2% = ~8 SOL in curve
      ENTERTAINMENT: 1,    // 1% = ~4 SOL in curve - almost any activity
    };

    const minMcap = minMarketCapSol[profile];
    const minProgress = minBondingProgress[profile];

    // Check 1: Minimum market cap
    if (token.marketCapSol < minMcap) {
      return {
        mint: token.mint,
        passes: false,
        reason: `Low market cap: ${token.marketCapSol.toFixed(1)} SOL < ${minMcap} SOL (${profile})`,
        marketCapSol: token.marketCapSol,
        bondingProgress,
      };
    }

    // Check 2: Minimum bonding progress (shows there's buying activity)
    if (bondingProgress < minProgress) {
      return {
        mint: token.mint,
        passes: false,
        reason: `Low bonding progress: ${bondingProgress.toFixed(1)}% < ${minProgress}% (${profile})`,
        marketCapSol: token.marketCapSol,
        bondingProgress,
      };
    }

    // Check 3: Creator didn't dump immediately (initialBuy > 0 means dev bought)
    // If dev didn't buy at all, slightly suspicious but not a deal breaker
    if (token.initialBuy === 0) {
      logger.debug({ mint: token.mint }, 'Dev did not buy - proceeding with caution');
    }

    // Check 4: Suspicious name patterns
    const suspiciousPatterns = [/rug/i, /scam/i, /honeypot/i, /fake/i, /exit/i];
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(token.symbol) || pattern.test(token.name)) {
        return {
          mint: token.mint,
          passes: false,
          reason: `Suspicious token name: ${token.name}`,
          marketCapSol: token.marketCapSol,
          bondingProgress,
        };
      }
    }

    logger.info({
      mint: token.mint,
      symbol: token.symbol,
      marketCapSol: token.marketCapSol.toFixed(2),
      bondingProgress: bondingProgress.toFixed(1),
      profile,
    }, '✅ Bonding curve token validated');

    return {
      mint: token.mint,
      passes: true,
      marketCapSol: token.marketCapSol,
      bondingProgress,
    };
  }
}
