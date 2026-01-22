import * as tf from '@tensorflow/tfjs';
import { createChildLogger } from '../utils/logger';
import { Action, Experience, DDQNConfig } from './types';
import { config } from '../config/settings';

const logger = createChildLogger('ddqn-agent');

export class DDQNAgent {
  private mainNetwork: tf.Sequential | null = null;
  private targetNetwork: tf.Sequential | null = null;
  private replayBuffer: Experience[] = [];
  private config: DDQNConfig;
  private epsilon: number;
  private trainStepCount = 0;

  constructor(ddqnConfig?: Partial<DDQNConfig>) {
    this.config = { ...config.ddqnConfig, ...ddqnConfig };
    this.epsilon = this.config.epsilon;
  }

  async initialize(): Promise<void> {
    logger.info('Initializing DDQN networks');

    this.mainNetwork = this.buildNetwork();
    this.targetNetwork = this.buildNetwork();

    // Copy main network weights to target
    await this.hardUpdateTarget();

    logger.info('DDQN networks initialized');
  }

  private buildNetwork(): tf.Sequential {
    const model = tf.sequential();

    // Input layer + first hidden
    model.add(
      tf.layers.dense({
        units: this.config.hiddenSize,
        activation: 'relu',
        inputShape: [this.config.stateSize],
        kernelInitializer: 'heNormal',
      })
    );

    // Second hidden layer
    model.add(
      tf.layers.dense({
        units: this.config.hiddenSize,
        activation: 'relu',
        kernelInitializer: 'heNormal',
      })
    );

    // Output layer (Q-values for each action)
    model.add(
      tf.layers.dense({
        units: this.config.actionSize,
        activation: 'linear',
        kernelInitializer: 'heNormal',
      })
    );

    model.compile({
      optimizer: tf.train.adam(this.config.learningRate),
      loss: 'meanSquaredError',
    });

    return model;
  }

  selectAction(state: number[]): { action: Action; qValues: number[] } {
    if (!this.mainNetwork) {
      throw new Error('Network not initialized');
    }

    // Epsilon-greedy action selection
    if (Math.random() < this.epsilon) {
      // Random action
      const action = Math.floor(Math.random() * this.config.actionSize) as Action;
      return { action, qValues: [0, 0, 0] };
    }

    // Get Q-values from main network
    const stateTensor = tf.tensor2d([state]);
    const qValuesTensor = this.mainNetwork.predict(stateTensor) as tf.Tensor;
    const qValues = qValuesTensor.dataSync() as Float32Array;

    stateTensor.dispose();
    qValuesTensor.dispose();

    // Select action with highest Q-value
    const action = this.argMax(Array.from(qValues)) as Action;

    return { action, qValues: Array.from(qValues) };
  }

  private argMax(arr: number[]): number {
    return arr.indexOf(Math.max(...arr));
  }

  addExperience(experience: Experience): void {
    this.replayBuffer.push(experience);

    // Remove oldest if buffer is full
    if (this.replayBuffer.length > this.config.replayBufferSize) {
      this.replayBuffer.shift();
    }
  }

  async train(): Promise<number> {
    if (!this.mainNetwork || !this.targetNetwork) {
      throw new Error('Networks not initialized');
    }

    if (this.replayBuffer.length < this.config.batchSize) {
      return 0;
    }

    // Sample random batch
    const batch = this.sampleBatch(this.config.batchSize);

    // Prepare training data
    const states = batch.map((e) => e.state);
    const nextStates = batch.map((e) => e.nextState);

    const statesTensor = tf.tensor2d(states);
    const nextStatesTensor = tf.tensor2d(nextStates);

    // Get current Q-values
    const currentQs = this.mainNetwork.predict(statesTensor) as tf.Tensor;
    const currentQsArray = currentQs.arraySync() as number[][];

    // DDQN: Use main network to select actions, target network to evaluate
    const nextQsMain = this.mainNetwork.predict(nextStatesTensor) as tf.Tensor;
    const nextQsTarget = this.targetNetwork.predict(nextStatesTensor) as tf.Tensor;

    const nextQsMainArray = nextQsMain.arraySync() as number[][];
    const nextQsTargetArray = nextQsTarget.arraySync() as number[][];

    // Update Q-values based on Bellman equation
    const targetQs: number[][] = [];

    for (let i = 0; i < batch.length; i++) {
      const experience = batch[i];
      const targetQ = [...currentQsArray[i]];

      if (experience.done) {
        targetQ[experience.action] = experience.reward;
      } else {
        // DDQN: action selected by main, value from target
        const bestAction = this.argMax(nextQsMainArray[i]);
        targetQ[experience.action] =
          experience.reward + this.config.gamma * nextQsTargetArray[i][bestAction];
      }

      targetQs.push(targetQ);
    }

    // Train main network
    const targetTensor = tf.tensor2d(targetQs);
    const history = await this.mainNetwork.fit(statesTensor, targetTensor, {
      epochs: 1,
      verbose: 0,
    });

    const loss = history.history.loss[0] as number;

    // Cleanup tensors
    statesTensor.dispose();
    nextStatesTensor.dispose();
    currentQs.dispose();
    nextQsMain.dispose();
    nextQsTarget.dispose();
    targetTensor.dispose();

    // Soft update target network
    this.trainStepCount++;
    await this.softUpdateTarget();

    // Decay epsilon
    this.decayEpsilon();

    return loss;
  }

  private sampleBatch(size: number): Experience[] {
    const batch: Experience[] = [];
    const indices = new Set<number>();

    while (indices.size < size && indices.size < this.replayBuffer.length) {
      indices.add(Math.floor(Math.random() * this.replayBuffer.length));
    }

    for (const idx of indices) {
      batch.push(this.replayBuffer[idx]);
    }

    return batch;
  }

  private async softUpdateTarget(): Promise<void> {
    if (!this.mainNetwork || !this.targetNetwork) return;

    const mainWeights = this.mainNetwork.getWeights();
    const targetWeights = this.targetNetwork.getWeights();

    const newWeights = mainWeights.map((mainWeight, i) => {
      const targetWeight = targetWeights[i];
      return tf.tidy(() => {
        const mainScaled = mainWeight.mul(this.config.targetUpdateTau);
        const targetScaled = targetWeight.mul(1 - this.config.targetUpdateTau);
        return mainScaled.add(targetScaled);
      });
    });

    this.targetNetwork.setWeights(newWeights);

    // Dispose old weights
    newWeights.forEach((w) => w.dispose());
  }

  private async hardUpdateTarget(): Promise<void> {
    if (!this.mainNetwork || !this.targetNetwork) return;

    const mainWeights = this.mainNetwork.getWeights();
    const weightCopies = mainWeights.map((w) => w.clone());
    this.targetNetwork.setWeights(weightCopies);
    weightCopies.forEach((w) => w.dispose());
  }

  private decayEpsilon(): void {
    this.epsilon = Math.max(
      this.config.epsilonMin,
      this.epsilon * this.config.epsilonDecay
    );
  }

  getEpsilon(): number {
    return this.epsilon;
  }

  setEpsilon(epsilon: number): void {
    this.epsilon = Math.max(this.config.epsilonMin, Math.min(1, epsilon));
  }

  getReplayBufferSize(): number {
    return this.replayBuffer.length;
  }

  async saveModel(path: string): Promise<void> {
    if (!this.mainNetwork) throw new Error('Network not initialized');

    await this.mainNetwork.save(`file://${path}`);
    logger.info({ path }, 'Model saved');
  }

  async loadModel(path: string): Promise<void> {
    try {
      this.mainNetwork = (await tf.loadLayersModel(`file://${path}/model.json`)) as tf.Sequential;

      // Recompile
      this.mainNetwork.compile({
        optimizer: tf.train.adam(this.config.learningRate),
        loss: 'meanSquaredError',
      });

      // Copy to target
      await this.hardUpdateTarget();

      logger.info({ path }, 'Model loaded');
    } catch (error) {
      logger.warn({ path, error }, 'Failed to load model, using fresh network');
      await this.initialize();
    }
  }

  getWeightsAsJSON(): string {
    if (!this.mainNetwork) throw new Error('Network not initialized');

    const weights = this.mainNetwork.getWeights();
    const weightsData = weights.map((w) => ({
      shape: w.shape,
      data: Array.from(w.dataSync()),
    }));

    return JSON.stringify(weightsData);
  }

  async loadWeightsFromJSON(json: string): Promise<void> {
    if (!this.mainNetwork) throw new Error('Network not initialized');

    const weightsData = JSON.parse(json);
    const weights = weightsData.map((w: { shape: number[]; data: number[] }) =>
      tf.tensor(w.data, w.shape)
    );

    this.mainNetwork.setWeights(weights);
    await this.hardUpdateTarget();

    weights.forEach((w: tf.Tensor) => w.dispose());
    logger.info('Weights loaded from JSON');
  }

  clearReplayBuffer(): void {
    this.replayBuffer = [];
  }

  dispose(): void {
    if (this.mainNetwork) {
      this.mainNetwork.dispose();
      this.mainNetwork = null;
    }
    if (this.targetNetwork) {
      this.targetNetwork.dispose();
      this.targetNetwork = null;
    }
  }
}

export const ddqnAgent = new DDQNAgent();
