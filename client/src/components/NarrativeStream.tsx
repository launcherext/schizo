import React from 'react';
import type { NarrativeSignal } from '../types';

interface NarrativeStreamProps {
  signal: NarrativeSignal | null;
}

export const NarrativeStream: React.FC<NarrativeStreamProps> = ({ signal }) => {
  if (!signal) return null;

  return (
    <div className="card" style={{ marginTop: '24px' }}>
      <div className="card-header">
        <span className="card-title">Narrative Stream</span>
        <div style={{
          padding: '4px 12px',
          borderRadius: '20px',
          fontSize: '11px',
          background: signal.sentiment === 'bullish' ? 'var(--success-subtle)' : 
                      signal.sentiment === 'bearish' ? 'var(--error-subtle)' : 'var(--bg-elevated)',
          color: signal.sentiment === 'bullish' ? 'var(--success)' :
                 signal.sentiment === 'bearish' ? 'var(--error)' : 'var(--text-muted)'
        }}>
          {signal.sentiment.toUpperCase()}
        </div>
      </div>
      <div style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div>
            <div className="stat-label">Bullish Score</div>
            <div className="metric-value" style={{ fontSize: '18px' }}>
              {signal.bullishnessScore.toFixed(2)}
            </div>
          </div>
          <div>
            <div className="stat-label">Hype Score</div>
            <div className="metric-value" style={{ fontSize: '18px', color: 'var(--accent)' }}>
              {(signal.hypeScore * 100).toFixed(0)}%
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {signal.keywords.map((k, i) => (
            <span key={i} style={{
              background: 'rgba(255,255,255,0.05)',
              padding: '6px 10px',
              borderRadius: '6px',
              fontSize: '12px',
              color: 'var(--text-secondary)'
            }}>
              #{k}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};
