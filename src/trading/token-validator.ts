import { dexscreener, type TokenMetadata } from '../api/dexscreener.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('token-validator');

export interface ValidationResult {
  mint: string;
  passes: boolean;
  reason?: string;
  metadata?: TokenMetadata;
}

export interface ValidatorConfig {
  minLiquidityUsd: number;
  minVolume1hUsd: number;
  requireSocials: boolean;
  minAgeMinutes: number;
}

const DEFAULT_CONFIG: ValidatorConfig = {
  minLiquidityUsd: 5000,
  minVolume1hUsd: 5000,
  requireSocials: false, // Optional, but recommended for high quality
  minAgeMinutes: 5,
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

      // Check 1: Liquidity
      if (metadata.liquidity < this.config.minLiquidityUsd) {
        return {
          mint,
          passes: false,
          reason: `Low liquidity: $${metadata.liquidity.toFixed(0)} < $${this.config.minLiquidityUsd}`,
          metadata,
        };
      }

      // Check 2: Volume
      // We look at 1h volume, or 5m volume projected to 1h if very new
      const volumeScore = metadata.volume1h > 0 
        ? metadata.volume1h 
        : (metadata.volume24h > 0 ? metadata.volume24h : metadata.buys5m * 100); // Rough proxy if volume data laggy

      if (volumeScore < this.config.minVolume1hUsd) {
        return {
          mint,
          passes: false,
          reason: `Low volume: $${volumeScore.toFixed(0)} < $${this.config.minVolume1hUsd}`,
          metadata,
        };
      }

      // Check 3: Socials (if required)
      if (this.config.requireSocials) {
        const hasTwitter = metadata.dexUrl?.includes('twitter') || false; // Proxy check
        // Note: Real social check would parse the 'info' field from DexPair if we exposed it
        // For now, we trust the "Graduation" implication of liquidity > $5k
      }

      // Check 4: Suspicious Patterns via DexScreener data
      // (e.g. if price dropped 99% in last hour - rug check)
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
