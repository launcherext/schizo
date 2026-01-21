import { HeliusClient } from '../api/helius.js';
import { AnalysisCacheRepository } from '../db/repositories/analysis-cache.js';
import { TokenSafetyResult, TokenRisk, GetAssetResponse, CACHE_TTL } from './types.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('token-safety');

/**
 * Analyzer for detecting honeypot tokens and rug pull indicators.
 * 
 * Checks:
 * - Classic SPL Token authorities (mint, freeze)
 * - Token-2022 extensions (permanent delegate, transfer fees, hooks)
 * - Metadata mutability
 * 
 * Results are cached for 24 hours to minimize API calls.
 * 
 * @example
 * const analyzer = new TokenSafetyAnalyzer(helius, cache);
 * const result = await analyzer.analyze('token-mint-address');
 * if (!result.isSafe) {
 *   console.log('Dangerous token detected:', result.risks);
 * }
 */
class TokenSafetyAnalyzer {
  constructor(
    private helius: HeliusClient,
    private cache: AnalysisCacheRepository
  ) {}

  /**
   * Analyze a token for safety indicators.
   * 
   * Checks cache first, then fetches from Helius DAS API if needed.
   * 
   * @param mintAddress - Token mint address (base58)
   * @returns Token safety analysis result
   */
  async analyze(mintAddress: string): Promise<TokenSafetyResult> {
    // Check cache first
    const cached = this.cache.get<TokenSafetyResult>(mintAddress, 'token_safety');
    if (cached) {
      logger.debug({ mintAddress }, 'Cache hit for token safety');
      return cached;
    }

    // Fetch from Helius
    let asset: GetAssetResponse;
    try {
      asset = await this.helius.getAsset(mintAddress);
    } catch (error) {
      logger.error({ mintAddress, error }, 'Failed to fetch token metadata');
      throw error;
    }

    // Analyze safety
    const result = this.analyzeAsset(asset);

    // Cache result
    this.cache.set(mintAddress, 'token_safety', result, CACHE_TTL.tokenSafety);

    logger.info(
      { mintAddress, isSafe: result.isSafe, risks: result.risks },
      'Token safety analysis complete'
    );

    return result;
  }

  /**
   * Analyze token asset for safety indicators.
   * 
   * Follows the pattern from 02-RESEARCH.md:
   * 1. Check classic authorities (mint, freeze)
   * 2. Check Token-2022 extensions (permanent delegate, transfer fee, hook)
   * 3. Check metadata mutability
   * 4. Determine overall safety
   * 
   * @param asset - Helius DAS API response
   * @returns Token safety result
   */
  private analyzeAsset(asset: GetAssetResponse): TokenSafetyResult {
    const risks: TokenRisk[] = [];

    // Check classic authorities
    const tokenInfo = asset.token_info;
    if (tokenInfo?.mint_authority) {
      risks.push('MINT_AUTHORITY_ACTIVE');
    }
    if (tokenInfo?.freeze_authority) {
      risks.push('FREEZE_AUTHORITY_ACTIVE');
    }

    // Check Token-2022 extensions (CRITICAL)
    const extensions = asset.mint_extensions;
    if (extensions?.permanent_delegate) {
      risks.push('PERMANENT_DELEGATE'); // Most dangerous!
    }
    if (extensions?.transfer_fee_config) {
      const feeBps = extensions.transfer_fee_config.transfer_fee_basis_points;
      if (feeBps > 100) { // > 1%
        risks.push('HIGH_TRANSFER_FEE');
      }
    }
    if (extensions?.transfer_hook) {
      risks.push('TRANSFER_HOOK');
    }

    // Check metadata mutability
    // REMOVED FILTER: User requested to ignore mutable metadata risk
    /* if (asset.mutable) {
      risks.push('MUTABLE_METADATA');
    } */

    // Determine safety
    // Safe if no risks OR only mutable metadata (warning, not blocker)
    const isSafe = risks.length === 0 ||
                   (risks.length === 1 && risks[0] === 'MUTABLE_METADATA');

    return {
      mint: asset.id,
      isSafe,
      risks,
      authorities: {
        mintAuthority: tokenInfo?.mint_authority ?? null,
        freezeAuthority: tokenInfo?.freeze_authority ?? null,
        updateAuthority: asset.authorities[0]?.address ?? null,
      },
      extensions: {
        hasPermanentDelegate: !!extensions?.permanent_delegate,
        hasTransferFee: !!extensions?.transfer_fee_config,
        hasTransferHook: !!extensions?.transfer_hook,
        permanentDelegateAddress: extensions?.permanent_delegate?.delegate,
        transferFeePercent: extensions?.transfer_fee_config
          ? extensions.transfer_fee_config.transfer_fee_basis_points / 100
          : undefined,
      },
      metadata: {
        isMutable: asset.mutable,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Convenience method to check if a token is safe.
   * 
   * @param result - Token safety analysis result
   * @returns True if token is safe to trade
   */
  isSafe(result: TokenSafetyResult): boolean {
    return result.isSafe;
  }
}

export { TokenSafetyAnalyzer };
