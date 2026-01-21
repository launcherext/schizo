import { dexscreener, type TokenMetadata } from '../api/dexscreener.js';
import { createLogger } from '../lib/logger.js';
import type { RiskProfile } from './types.js';

const logger = createLogger('token-validator');

export interface ValidationResult {
  mint: string;
  passes: boolean;
  reason?: string;
  metadata?: TokenMetadata;
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
      };
      
      const maxAgeMinutes = {
        CONSERVATIVE: 15,
        BALANCED: 8,
        AGGRESSIVE: 3,
      };

      const minBuyPressure = {
        CONSERVATIVE: 1.8,
        BALANCED: 1.3,
        AGGRESSIVE: 1.05
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
         return {
            mint,
            passes: false,
            reason: `Too old for ${profile} entry: ${metadata.ageMinutes}m > ${maxAge}m limit`,
            metadata
         };
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
}
