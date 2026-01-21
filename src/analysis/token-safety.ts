import { HeliusClient } from '../api/helius.js';
import { AnalysisCacheRepository } from '../db/repositories/analysis-cache.js';
import { TokenSafetyResult, TokenRisk, GetAssetResponse, CACHE_TTL } from './types.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('token-safety');

/**
 * Configuration for holder distribution thresholds
 */
interface HolderThresholds {
  maxTopHolderPercent: number;    // Reject if top holder owns more than this
  maxTop10HoldersPercent: number; // Reject if top 10 own more than this
  minHolderCount: number;         // Warn if fewer holders than this
}

const DEFAULT_HOLDER_THRESHOLDS: HolderThresholds = {
  maxTopHolderPercent: 30,        // 30% max for single holder
  maxTop10HoldersPercent: 50,     // 50% max for top 10 combined
  minHolderCount: 20,             // At least 20 holders
};

/**
 * Analyzer for detecting honeypot tokens and rug pull indicators.
 * 
 * Checks:
 * - Classic SPL Token authorities (mint, freeze)
 * - Token-2022 extensions (permanent delegate, transfer fees, hooks)
 * - Holder distribution (top holder %, top 10 %)
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
  private holderThresholds: HolderThresholds;

  constructor(
    private helius: HeliusClient,
    private cache: AnalysisCacheRepository,
    holderThresholds?: Partial<HolderThresholds>
  ) {
    this.holderThresholds = { ...DEFAULT_HOLDER_THRESHOLDS, ...holderThresholds };
  }

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

    // Fetch asset metadata from Helius
    let asset: GetAssetResponse;
    try {
      asset = await this.helius.getAsset(mintAddress);
    } catch (error) {
      logger.error({ mintAddress, error }, 'Failed to fetch token metadata');
      throw error;
    }

    // Analyze on-chain safety first
    const result = this.analyzeAsset(asset);

    // Fetch holder distribution (separate call, may fail for very new tokens)
    try {
      const holdersData = await this.helius.getTokenHolders(mintAddress, 20);
      
      if (holdersData.holders.length > 0) {
        // Calculate top holder %
        const topHolderPercent = holdersData.holders[0]?.percentage || 0;
        
        // Calculate top 10 combined %
        const top10 = holdersData.holders.slice(0, 10);
        const top10HoldersPercent = top10.reduce((sum, h) => sum + h.percentage, 0);

        // Add holder distribution to result
        result.holderDistribution = {
          topHolderPercent,
          top10HoldersPercent,
          totalHolders: holdersData.totalHolders,
        };

        // Check holder concentration risks
        if (topHolderPercent > this.holderThresholds.maxTopHolderPercent) {
          result.risks.push('HIGH_TOP_HOLDER');
          result.isSafe = false;
          logger.warn({ 
            mintAddress, 
            topHolderPercent: topHolderPercent.toFixed(1) 
          }, `Top holder owns ${topHolderPercent.toFixed(1)}% - REJECTED`);
        }

        if (top10HoldersPercent > this.holderThresholds.maxTop10HoldersPercent) {
          result.risks.push('HIGH_TOP10_HOLDERS');
          result.isSafe = false;
          logger.warn({ 
            mintAddress, 
            top10HoldersPercent: top10HoldersPercent.toFixed(1) 
          }, `Top 10 holders own ${top10HoldersPercent.toFixed(1)}% - REJECTED`);
        }

        // Check for insider concentration (few holders with high ownership)
        if (holdersData.totalHolders < this.holderThresholds.minHolderCount && 
            top10HoldersPercent > 40) {
          result.risks.push('INSIDER_CONCENTRATION');
          result.isSafe = false;
          logger.warn({ 
            mintAddress, 
            totalHolders: holdersData.totalHolders,
            top10HoldersPercent: top10HoldersPercent.toFixed(1)
          }, 'Insider concentration detected - REJECTED');
        }
      }
    } catch (error) {
      // Log but don't fail - holder data may not be available for very new tokens
      logger.warn({ mintAddress, error }, 'Failed to fetch holder distribution (token may be too new)');
    }

    // Cache result
    this.cache.set(mintAddress, 'token_safety', result, CACHE_TTL.tokenSafety);

    logger.info(
      { 
        mintAddress, 
        isSafe: result.isSafe, 
        risks: result.risks,
        topHolderPercent: result.holderDistribution?.topHolderPercent?.toFixed(1),
        top10Percent: result.holderDistribution?.top10HoldersPercent?.toFixed(1),
      },
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
   * 3. Determine overall safety
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

    // Determine safety (holder checks added later in analyze())
    // Safe if no critical risks found
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

