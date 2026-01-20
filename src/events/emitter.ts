/**
 * Event emitter for agent actions
 */

import type { AgentEvent } from './types.js';
import { logger } from '../lib/logger.js';

/**
 * Event listener callback
 */
type EventListener = (event: AgentEvent) => void;

/**
 * Agent event emitter (singleton)
 */
export class AgentEventEmitter {
  private listeners: Map<string, Set<EventListener>>;
  private anyListeners: Set<EventListener>;

  constructor() {
    this.listeners = new Map();
    this.anyListeners = new Set();
  }

  /**
   * Emit an event to all listeners
   */
  emit(event: AgentEvent): void {
    // Add timestamp if not present
    if (!event.timestamp) {
      event.timestamp = Date.now();
    }

    logger.debug({ type: event.type }, 'Event emitted');

    // Notify specific event type listeners
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      typeListeners.forEach(listener => {
        try {
          listener(event);
        } catch (error) {
          logger.error({ type: event.type, error }, 'Event listener error');
        }
      });
    }

    // Notify wildcard listeners
    this.anyListeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        logger.error({ type: event.type, error }, 'Wildcard listener error');
      }
    });
  }

  /**
   * Listen to specific event type
   */
  on(eventType: string, callback: EventListener): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(callback);
  }

  /**
   * Remove listener for specific event type
   */
  off(eventType: string, callback: EventListener): void {
    const typeListeners = this.listeners.get(eventType);
    if (typeListeners) {
      typeListeners.delete(callback);
    }
  }

  /**
   * Listen to all events
   */
  onAny(callback: EventListener): void {
    this.anyListeners.add(callback);
  }

  /**
   * Remove wildcard listener
   */
  offAny(callback: EventListener): void {
    this.anyListeners.delete(callback);
  }

  /**
   * Clear all listeners
   */
  clear(): void {
    this.listeners.clear();
    this.anyListeners.clear();
  }
}

/**
 * Global event emitter instance (singleton)
 */
export const agentEvents = new AgentEventEmitter();
