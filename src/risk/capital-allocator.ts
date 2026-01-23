import { createChildLogger } from '../utils/logger';
import { config } from '../config/settings';
import { txManager } from '../execution/tx-manager';
import { positionManager } from './position-manager';
import { CapitalAllocation, RiskCheckResult, RiskLimits } from './types';

const logger = createChildLogger('capital-allocator');

export class CapitalAllocator {
  private allocation: CapitalAllocation;
  private limits: RiskLimits;
  private pendingByPool: Map<string, number> = new Map();

  constructor() {
    const totalCapital = config.initialCapitalSol;

    this.allocation = {
      totalSol: totalCapital,
      reserveSol: totalCapital * config.capitalAllocation.reserve,
      activeSol: totalCapital * config.capitalAllocation.active,
      highRiskSol: totalCapital * config.capitalAllocation.highRisk,
      inPositions: 0,
      availableActive: totalCapital * config.capitalAllocation.active,
      availableHighRisk: totalCapital * config.capitalAllocation.highRisk,
    };

    this.limits = {
      maxPositionSizeSol: config.maxPositionSize * totalCapital,
      maxConcurrentPositions: config.maxConcurrentPositions,
      dailyLossLimit: config.dailyLossLimit,
      maxDrawdownLimit: 0.30, // 30% max drawdown
      minPositionSizeSol: 0.001,
    };
  }

  async start(): Promise<void> {
    this.setupEventHandlers();
    await this.syncWithWallet();
    logger.info('Capital allocator started');
  }

  private setupEventHandlers(): void {
    txManager.on('txPending', (tx) => {
      if (tx.type === 'buy' && tx.poolType) {
        const current = this.pendingByPool.get(tx.poolType) || 0;
        this.pendingByPool.set(tx.poolType, current + tx.inputAmount);
        logger.info({ 
          pool: tx.poolType, 
          amount: tx.inputAmount,
          newPending: current + tx.inputAmount 
        }, 'Capital reserved for pending tx');
      }
    });

    const releasePending = (tx: any) => {
      if (tx.type === 'buy' && tx.poolType) {
        const current = this.pendingByPool.get(tx.poolType) || 0;
        const newPending = Math.max(0, current - tx.inputAmount);
        this.pendingByPool.set(tx.poolType, newPending);
        logger.info({ 
          pool: tx.poolType, 
          amount: tx.inputAmount,
          remainingPending: newPending
        }, 'Pending capital released');
      }
    };

    txManager.on('txConfirmed', releasePending);
    txManager.on('txFailed', releasePending);
  }

  async syncWithWallet(): Promise<void> {
    try {
      const actualBalance = await txManager.getWalletBalance();
      const inPositions = positionManager.getTotalExposure();

      this.allocation.totalSol = actualBalance + inPositions;
      this.allocation.inPositions = inPositions;

      // Recalculate allocations
      this.allocation.reserveSol = this.allocation.totalSol * config.capitalAllocation.reserve;
      this.allocation.activeSol = this.allocation.totalSol * config.capitalAllocation.active;
      this.allocation.highRiskSol = this.allocation.totalSol * config.capitalAllocation.highRisk;

      // Calculate available capital by pool
      const activeInPositions = this.getPoolExposure('active');
      const highRiskInPositions = this.getPoolExposure('high_risk');

      this.allocation.availableActive = Math.max(0, this.allocation.activeSol - activeInPositions);
      this.allocation.availableHighRisk = Math.max(0, this.allocation.highRiskSol - highRiskInPositions);

      // Update limits based on new total
      this.limits.maxPositionSizeSol = config.maxPositionSize * this.allocation.totalSol;

      logger.debug({
        total: this.allocation.totalSol.toFixed(4),
        available: actualBalance.toFixed(4),
        inPositions: inPositions.toFixed(4),
        availableActive: this.allocation.availableActive.toFixed(4),
        availableHighRisk: this.allocation.availableHighRisk.toFixed(4),
      }, 'Capital synced');
    } catch (error) {
      logger.error({ error }, 'Failed to sync capital');
    }
  }

  private getPoolExposure(poolType: 'active' | 'high_risk'): number {
    return positionManager
      .getOpenPositions()
      .filter((p) => p.poolType === poolType)
      .reduce((sum, p) => sum + p.amountSol, 0);
  }

  checkRisk(
    requestedSizeSol: number,
    poolType: 'active' | 'high_risk'
  ): RiskCheckResult {
    const warnings: string[] = [];
    let adjustedSize = requestedSizeSol;
    let approved = true;

    // Check position count limit
    const currentPositions = positionManager.getPositionCount();
    if (currentPositions >= this.limits.maxConcurrentPositions) {
      logger.info({
        currentPositions,
        maxPositions: this.limits.maxConcurrentPositions,
      }, 'BLOCKED: Max concurrent positions reached');
      return {
        approved: false,
        reason: `Max positions (${this.limits.maxConcurrentPositions}) reached`,
        warnings: [],
      };
    }

    // Check pool availability
    const available =
      poolType === 'active'
        ? this.allocation.availableActive
        : this.allocation.availableHighRisk;
    
    // Deduct pending transactions
    const pending = this.pendingByPool.get(poolType) || 0;
    const effectiveAvailable = Math.max(0, available - pending);

    if (requestedSizeSol > effectiveAvailable) {
      adjustedSize = effectiveAvailable;
      warnings.push(`Size reduced from ${available.toFixed(4)} to ${effectiveAvailable.toFixed(4)} (pending: ${pending.toFixed(4)})`);
    }

    // Check max position size
    if (adjustedSize > this.limits.maxPositionSizeSol) {
      adjustedSize = this.limits.maxPositionSizeSol;
      warnings.push(`Size capped at max: ${this.limits.maxPositionSizeSol.toFixed(4)} SOL`);
    }

    // Check min position size
    if (adjustedSize < this.limits.minPositionSizeSol) {
      return {
        approved: false,
        reason: `Size ${adjustedSize.toFixed(4)} below minimum ${this.limits.minPositionSizeSol} SOL`,
        warnings,
      };
    }

    // Check total exposure
    const totalExposure = positionManager.getTotalExposure() + adjustedSize;
    const maxExposure = this.allocation.totalSol - this.allocation.reserveSol;

    if (totalExposure > maxExposure) {
      const allowedSize = maxExposure - positionManager.getTotalExposure();
      if (allowedSize < this.limits.minPositionSizeSol) {
        return {
          approved: false,
          reason: 'Would exceed total exposure limit',
          warnings,
        };
      }
      adjustedSize = allowedSize;
      warnings.push(`Size reduced due to exposure limit: ${adjustedSize.toFixed(4)} SOL`);
    }

    return {
      approved: true,
      adjustedSize,
      reason: 'Risk check passed',
      warnings,
    };
  }

  getAllocation(): CapitalAllocation {
    return { ...this.allocation };
  }

  getLimits(): RiskLimits {
    return { ...this.limits };
  }

  getAvailableCapital(poolType: 'active' | 'high_risk'): number {
    return poolType === 'active'
      ? this.allocation.availableActive
      : this.allocation.availableHighRisk;
  }

  getExposurePercent(): number {
    if (this.allocation.totalSol === 0) return 0;
    return (this.allocation.inPositions / this.allocation.totalSol) * 100;
  }

  reserveCapital(amount: number, poolType: 'active' | 'high_risk'): void {
    if (poolType === 'active') {
      this.allocation.availableActive = Math.max(0, this.allocation.availableActive - amount);
    } else {
      this.allocation.availableHighRisk = Math.max(0, this.allocation.availableHighRisk - amount);
    }
    this.allocation.inPositions += amount;
  }

  releaseCapital(amount: number, poolType: 'active' | 'high_risk'): void {
    if (poolType === 'active') {
      this.allocation.availableActive += amount;
    } else {
      this.allocation.availableHighRisk += amount;
    }
    this.allocation.inPositions = Math.max(0, this.allocation.inPositions - amount);
  }

  suggestPoolType(rugScore: number): 'active' | 'high_risk' {
    // Higher rug score = safer token = active pool
    // Lower rug score = riskier = high risk pool
    return rugScore >= 70 ? 'active' : 'high_risk';
  }

  getStatus(): string {
    const exposure = this.getExposurePercent();
    const positions = positionManager.getPositionCount();

    return [
      `Total: ${this.allocation.totalSol.toFixed(4)} SOL`,
      `In Positions: ${this.allocation.inPositions.toFixed(4)} SOL (${exposure.toFixed(1)}%)`,
      `Available Active: ${this.allocation.availableActive.toFixed(4)} SOL`,
      `Available High Risk: ${this.allocation.availableHighRisk.toFixed(4)} SOL`,
      `Positions: ${positions}/${this.limits.maxConcurrentPositions}`,
    ].join(' | ');
  }
}

export const capitalAllocator = new CapitalAllocator();
