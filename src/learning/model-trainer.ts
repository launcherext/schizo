import { createChildLogger } from '../utils/logger';
import { config } from '../config/settings';
import { ddqnAgent } from '../ai/ddqn-agent';
import { positionSizer } from '../ai/position-sizer';
import { repository } from '../db/repository';
import { tradeLogger } from './trade-logger';
import { performanceAnalytics } from './performance';
import { ModelTrainingResult, LearningState } from './types';

const logger = createChildLogger('model-trainer');

export class ModelTrainer {
  private state: LearningState;
  private trainingInterval: NodeJS.Timeout | null = null;
  private modelVersion: number = 0;

  constructor() {
    this.state = {
      tradesProcessed: 0,
      lastTrainingTime: new Date(0),
      modelVersion: 0,
      performanceHistory: [],
      featureImportance: [],
    };
  }

  async initialize(): Promise<void> {
    // Load model version from database
    const savedVersion = await repository.getConfig('model_version');
    if (savedVersion) {
      this.modelVersion = parseInt(savedVersion);
      this.state.modelVersion = this.modelVersion;
    }

    // Try to load existing model weights
    const modelData = await repository.getLatestModelWeights();
    if (modelData) {
      try {
        await ddqnAgent.loadWeightsFromJSON(modelData.weights);
        this.modelVersion = modelData.version;
        logger.info({ version: this.modelVersion }, 'Loaded model weights from database');
      } catch (error) {
        logger.warn({ error }, 'Failed to load model weights, using fresh model');
        await ddqnAgent.initialize();
      }
    } else {
      await ddqnAgent.initialize();
    }

    logger.info('Model trainer initialized');
  }

  async startPeriodicTraining(): Promise<void> {
    // Train every week
    this.trainingInterval = setInterval(() => {
      this.runTrainingCycle();
    }, config.modelRetrainIntervalMs);

    logger.info({ intervalMs: config.modelRetrainIntervalMs }, 'Periodic training started');
  }

  stopPeriodicTraining(): void {
    if (this.trainingInterval) {
      clearInterval(this.trainingInterval);
      this.trainingInterval = null;
    }
    logger.info('Periodic training stopped');
  }

  async runTrainingCycle(): Promise<ModelTrainingResult | null> {
    logger.info('Starting training cycle');

    const startTime = Date.now();

    try {
      // Get trades for training
      const trades = await tradeLogger.getTradesForTraining(4);

      if (trades.length < 50) {
        logger.info({ tradeCount: trades.length }, 'Not enough trades for training');
        return null;
      }

      // Convert trades to experiences
      const experiences = trades
        .map((trade) => tradeLogger.tradeToExperience(trade))
        .filter((e) => e !== null);

      if (experiences.length < 32) {
        logger.info({ experienceCount: experiences.length }, 'Not enough experiences');
        return null;
      }

      // Add to replay buffer
      for (const exp of experiences) {
        if (exp) {
          ddqnAgent.addExperience(exp);
        }
      }

      // Calculate pre-training metrics
      const preMetrics = await performanceAnalytics.calculateMetrics(trades);

      // Run training epochs
      const epochs = 100;
      let totalLoss = 0;

      for (let epoch = 0; epoch < epochs; epoch++) {
        const loss = await ddqnAgent.train();
        totalLoss += loss;

        if (epoch % 10 === 0) {
          logger.debug({ epoch, loss: loss.toFixed(6) }, 'Training progress');
        }
      }

      const avgLoss = totalLoss / epochs;

      // Update position sizer with win rate
      const winTrades = trades.filter((t) => (t.pnlSol || 0) > 0);
      for (const trade of trades) {
        positionSizer.recordTrade((trade.pnlSol || 0) > 0);
      }

      // Calculate post-training validation (simplified)
      const validationLoss = avgLoss * 1.1; // Approximate

      // Update model version
      this.modelVersion++;
      this.state.modelVersion = this.modelVersion;
      this.state.lastTrainingTime = new Date();
      this.state.tradesProcessed += trades.length;

      // Save model weights
      const weights = ddqnAgent.getWeightsAsJSON();
      const metrics = JSON.stringify(preMetrics);

      await repository.saveModelWeights(this.modelVersion, weights, metrics);
      await repository.setConfig('model_version', this.modelVersion.toString());

      // Update feature importance
      this.state.featureImportance = await performanceAnalytics.analyzeFeatureImportance();

      // Store performance history
      this.state.performanceHistory.push(preMetrics);
      if (this.state.performanceHistory.length > 52) {
        // Keep last year of weekly metrics
        this.state.performanceHistory.shift();
      }

      const trainingTime = Date.now() - startTime;

      const result: ModelTrainingResult = {
        epochsTrained: epochs,
        finalLoss: avgLoss,
        validationLoss,
        trainingTime,
        samplesUsed: experiences.length,
        improvementPercent: 0, // Would need post-validation
        timestamp: new Date(),
      };

      logger.info({
        version: this.modelVersion,
        epochs,
        loss: avgLoss.toFixed(6),
        samples: experiences.length,
        trainingTime,
      }, 'Training cycle completed');

      return result;
    } catch (error) {
      logger.error({ error }, 'Training cycle failed');
      return null;
    }
  }

  async addTradeExperience(positionId: string): Promise<void> {
    const trade = await tradeLogger.getActiveTrade(positionId);

    if (!trade || !trade.exitPrice) {
      return;
    }

    const experience = tradeLogger.tradeToExperience(trade);

    if (experience) {
      ddqnAgent.addExperience(experience);
      this.state.tradesProcessed++;

      // Train incrementally every 10 trades
      if (this.state.tradesProcessed % 10 === 0) {
        await ddqnAgent.train();
      }
    }
  }

  getState(): LearningState {
    return { ...this.state };
  }

  getModelVersion(): number {
    return this.modelVersion;
  }

  async exportModel(path: string): Promise<void> {
    await ddqnAgent.saveModel(path);
    logger.info({ path, version: this.modelVersion }, 'Model exported');
  }

  async importModel(path: string): Promise<void> {
    await ddqnAgent.loadModel(path);
    this.modelVersion++;
    await repository.setConfig('model_version', this.modelVersion.toString());
    logger.info({ path, version: this.modelVersion }, 'Model imported');
  }

  getTrainingStatus(): string {
    const timeSinceTrain = Date.now() - this.state.lastTrainingTime.getTime();
    const hoursSinceTrain = Math.floor(timeSinceTrain / (60 * 60 * 1000));

    return [
      `Model v${this.modelVersion}`,
      `Trades: ${this.state.tradesProcessed}`,
      `Buffer: ${ddqnAgent.getReplayBufferSize()}`,
      `Last train: ${hoursSinceTrain}h ago`,
      `Epsilon: ${ddqnAgent.getEpsilon().toFixed(3)}`,
    ].join(' | ');
  }
}

export const modelTrainer = new ModelTrainer();
