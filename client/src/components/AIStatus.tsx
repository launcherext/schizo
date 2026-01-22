import React, { useEffect, useState } from 'react';
import type { Stats, AIDecisionData } from '../types';
import { TokenBadge } from './TokenDisplay';

interface AIStatusProps {
  stats: Stats;
  decision: AIDecisionData | null;
}

export const AIStatus: React.FC<AIStatusProps> = ({ stats, decision }) => {
  const [statusText, setStatusText] = useState('Initializing AI Model...');
  const winRate = parseFloat(stats.winRate || "0");
  const winStreak = stats.winStreak || 0;

  useEffect(() => {
    if (!decision) return;

    // Map regime to text
    const regimes = ['BULL', 'VOLATILE', 'CRASH'];
    const regimeText = regimes[decision.regime];

    // Clearer action text - these are decisions about NEW tokens, not existing positions
    let actionText: string;
    switch (decision.action) {
      case 0: // HOLD
        actionText = `Watching`;
        break;
      case 1: // BUY
        actionText = `Buying`;
        break;
      case 2: // SELL (means "pass on this token")
        actionText = `Passing on`;
        break;
      default:
        actionText = `Evaluating`;
    }

    setStatusText(`${regimeText}: ${actionText}`);
  }, [decision]);

  // Fallback animation if no decision yet
  useEffect(() => {
    if (decision) return;
    const statuses = ['Analyzing market structure', 'Calculating Q-values', 'Scanning liquidity'];
    let index = 0;
    const interval = setInterval(() => {
      index = (index + 1) % statuses.length;
      setStatusText(statuses[index]);
    }, 3000);
    return () => clearInterval(interval);
  }, [decision]);

  // Visualize Q-Values (Buy vs Hold vs Sell reward expectations)
  // Normalize for display: find max absolute value to scale bars
  const qValues = decision?.qValues || [0, 0, 0]; // [Hold, Buy, Sell] typically
  const maxQ = Math.max(...qValues.map(Math.abs), 1); // Avoid div by zero
  
  // Confidence for the bar
  // Scale factor: AI confidence is often raw difference in Q-values (0.01-0.1 range)
  // We apply a sigmoid-like scaling to make it visible on the 0-100% bar
  const rawConfidence = decision ? decision.confidence : (winRate / 100);
  const scaledConfidence = Math.min(100, Math.max(0, rawConfidence * 500)); // Boost factor
  
  const confidence = decision ? scaledConfidence : Math.min(100, Math.max(0, winRate * 1.2));

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Claude's Thoughts</span>
      </div>
      <div className="ai-content">
        <div className="ai-indicator">
          <div className="ai-ring-outer"></div>
          <div className="ai-ring" style={{ animationDuration: decision ? '0.5s' : '1.5s' }}></div>
          <div className="ai-ring-inner"></div>
          <div className="ai-center">
            <div className="ai-center-dot" style={{ 
              background: decision?.action === 1 ? 'var(--success)' : 
                          decision?.action === 2 ? 'var(--error)' : '#FAFAF9' 
            }}></div>
          </div>
        </div>
        
        <div className="ai-status" style={{ minHeight: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span>{statusText}</span>
          {decision && (
            <TokenBadge
              mint={decision.mint}
              symbol={decision.symbol}
              imageUrl={decision.imageUrl}
            />
          )}
        </div>

        {/* Q-Value Visualization */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', height: '60px', alignItems: 'flex-end' }}>
          {['WATCH', 'BUY', 'PASS'].map((label, i) => {
            const val = qValues[i] || 0;
            const height = Math.abs(val) / maxQ * 100;
            const color = val > 0 ? 'var(--success)' : 'var(--error)';
            const isSelected = decision?.action === i;
            
            return (
              <div key={label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: isSelected ? 1 : 0.5 }}>
                 <div style={{ 
                   width: '100%', 
                   height: `${Math.max(10, height)}%`, 
                   background: color,
                   borderRadius: '4px',
                   transition: 'all 0.3s ease'
                 }}></div>
                 <span style={{ fontSize: '10px', marginTop: '4px', color: 'var(--text-muted)' }}>{label}</span>
              </div>
            );
          })}
        </div>

        <div className="confidence-bar">
          <div className="confidence-header">
            <span>Confidence</span>
            <span>{confidence.toFixed(0)}%</span>
          </div>
          <div className="confidence-track">
            <div 
              className="confidence-fill" 
              style={{ width: `${confidence}%` }}
            ></div>
          </div>
        </div>
        <div className="win-streak-box">
          <div className="win-streak-value animate-number">{winStreak}</div>
          <div className="win-streak-label">Win streak</div>
        </div>
      </div>
    </div>
  );
};
