/**
 * Shill Queue Types
 *
 * Handles viewer-submitted token "shills" via $SCHIZO burns
 * Viewers send $SCHIZO to burn wallet with a memo containing a CA
 */

/**
 * Configuration for the burn wallet watcher
 */
export interface ShillQueueWatcherConfig {
  /** Address of the burn wallet to monitor */
  burnWalletAddress: string;
  /** $SCHIZO token mint address */
  schizoTokenMint: string;
  /** Minimum $SCHIZO tokens required to shill */
  minShillAmountTokens: number;
  /** Cooldown per wallet (prevent spam) in ms */
  cooldownPerWalletMs: number;
  /** Enable/disable the watcher */
  enabled: boolean;
}

/**
 * A shill request from a viewer
 */
export interface ShillRequest {
  /** Wallet that sent the shill */
  senderWallet: string;
  /** Contract address they want analyzed */
  contractAddress: string;
  /** Amount of $SCHIZO burned */
  schizoAmountBurned: number;
  /** Transaction signature */
  signature: string;
  /** Timestamp of the burn */
  timestamp: number;
}

/**
 * Configuration for the shill queue processor
 */
export interface ShillQueueConfig {
  /** Maximum items in queue */
  maxQueueSize: number;
  /** Timeout for processing each shill (ms) */
  processingTimeoutMs: number;
  /** Position size for lotto buys (SOL) */
  lottoPositionSol: number;
}

/**
 * Result of shill analysis
 */
export interface ShillAnalysisResult {
  /** The original shill request */
  request: ShillRequest;
  /** Whether the token passed safety checks */
  isSafe: boolean;
  /** Risks identified (if any) */
  risks: string[];
  /** Token metadata */
  tokenInfo?: {
    symbol: string;
    name: string;
    marketCapSol?: number;
    liquidity?: number;
  };
  /** Roast message if rejected */
  roastMessage?: string;
  /** Buy signature if accepted */
  buySignature?: string;
  /** Position size if bought */
  positionSizeSol?: number;
}

/**
 * Default configurations
 */
export const DEFAULT_SHILL_WATCHER_CONFIG: Omit<ShillQueueWatcherConfig, 'schizoTokenMint'> = {
  burnWalletAddress: 'GvV8bXgQTYSGHnfNF9vgodshgQ4P2fcichGFLqBd73kr',
  minShillAmountTokens: 1000,
  cooldownPerWalletMs: 5 * 60 * 1000, // 5 minutes
  enabled: true,
};

export const DEFAULT_SHILL_QUEUE_CONFIG: ShillQueueConfig = {
  maxQueueSize: 5,
  processingTimeoutMs: 30000, // 30 seconds
  lottoPositionSol: 0.02,
};
