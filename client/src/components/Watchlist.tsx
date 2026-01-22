import React from 'react';
import type { WatchlistToken, WatchlistStats } from '../types';
import { TokenDisplay } from './TokenDisplay';

interface WatchlistProps {
  tokens: WatchlistToken[];
  stats: WatchlistStats;
}

const getStatusColor = (status: WatchlistToken['status']) => {
  switch (status) {
    case 'collecting': return 'var(--text-muted)';
    case 'ready': return 'var(--accent)';
    case 'analyzing': return 'var(--warning)';
    case 'rejected': return 'var(--error)';
    case 'bought': return 'var(--success)';
    default: return 'var(--text-muted)';
  }
};

const getStatusBg = (status: WatchlistToken['status']) => {
  switch (status) {
    case 'collecting': return 'rgba(255,255,255,0.05)';
    case 'ready': return 'var(--accent-subtle)';
    case 'analyzing': return 'var(--warning-subtle)';
    case 'rejected': return 'var(--error-subtle)';
    case 'bought': return 'var(--success-subtle)';
    default: return 'rgba(255,255,255,0.05)';
  }
};

const formatAge = (firstSeen: number) => {
  const ageMs = Date.now() - firstSeen;
  const ageSec = Math.floor(ageMs / 1000);
  if (ageSec < 60) return `${ageSec}s`;
  const ageMin = Math.floor(ageSec / 60);
  if (ageMin < 60) return `${ageMin}m`;
  return `${Math.floor(ageMin / 60)}h`;
};

export const Watchlist: React.FC<WatchlistProps> = ({ tokens, stats }) => {
  return (
    <div className="card" style={{ marginTop: '24px' }}>
      <div className="card-header">
        <span className="card-title">Token Watchlist</span>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div style={{
            padding: '4px 12px',
            borderRadius: '20px',
            fontSize: '11px',
            background: 'var(--bg-elevated)',
            color: 'var(--text-muted)'
          }}>
            {stats.total} watching
          </div>
          <div style={{
            padding: '4px 12px',
            borderRadius: '20px',
            fontSize: '11px',
            background: 'var(--accent-subtle)',
            color: 'var(--accent)'
          }}>
            {stats.ready} ready
          </div>
          {stats.devSold > 0 && (
            <div style={{
              padding: '4px 12px',
              borderRadius: '20px',
              fontSize: '11px',
              background: 'var(--error-subtle)',
              color: 'var(--error)'
            }}>
              {stats.devSold} dev sold
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: '16px', maxHeight: '400px', overflowY: 'auto' }}>
        {tokens.length === 0 ? (
          <div style={{
            textAlign: 'center',
            color: 'var(--text-muted)',
            padding: '24px',
            fontSize: '13px'
          }}>
            Waiting for new tokens...
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {tokens.map((token) => (
              <div
                key={token.mint}
                style={{
                  background: 'var(--bg-elevated)',
                  borderRadius: '8px',
                  padding: '12px',
                  border: token.devSold ? '1px solid var(--error)' : '1px solid transparent'
                }}
              >
                {/* Header Row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <TokenDisplay
                      mint={token.mint}
                      name={token.name}
                      symbol={token.symbol}
                      imageUrl={token.imageUrl}
                      size="sm"
                      showCopy={true}
                      inline={true}
                    />
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '10px',
                      background: getStatusBg(token.status),
                      color: getStatusColor(token.status),
                      textTransform: 'uppercase'
                    }}>
                      {token.status}
                    </span>
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {formatAge(token.firstSeen)} old
                  </span>
                </div>

                {/* Progress Bar for Data Collection */}
                {token.status === 'collecting' && (
                  <div style={{ marginBottom: '8px' }}>
                    <div style={{
                      background: 'rgba(255,255,255,0.1)',
                      borderRadius: '4px',
                      height: '4px',
                      overflow: 'hidden'
                    }}>
                      <div style={{
                        background: 'var(--accent)',
                        height: '100%',
                        width: `${Math.min(token.dataPoints * 10, 100)}%`,
                        transition: 'width 0.3s ease'
                      }} />
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      {token.dataPoints}/10 data points
                    </div>
                  </div>
                )}

                {/* Rejection Reason */}
                {token.status === 'rejected' && token.rejectReason && (
                  <div style={{
                    fontSize: '11px',
                    color: 'var(--error)',
                    marginBottom: '8px'
                  }}>
                    {token.rejectReason}
                  </div>
                )}

                {/* Metrics Row */}
                {(token.status === 'ready' || token.status === 'analyzing') && (
                  <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Price</div>
                      <div style={{
                        fontSize: '12px',
                        color: token.priceChange >= 0 ? 'var(--success)' : 'var(--error)'
                      }}>
                        {token.priceChange >= 0 ? '+' : ''}{(token.priceChange * 100).toFixed(1)}%
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Drawdown</div>
                      <div style={{
                        fontSize: '12px',
                        color: token.drawdown > 0.2 ? 'var(--error)' : 'var(--text-secondary)'
                      }}>
                        -{(token.drawdown * 100).toFixed(1)}%
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Buy Pressure</div>
                      <div style={{
                        fontSize: '12px',
                        color: token.buyPressure > 0.6 ? 'var(--success)' : 'var(--text-secondary)'
                      }}>
                        {(token.buyPressure * 100).toFixed(0)}%
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Traders</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {token.uniqueTraders}
                      </div>
                    </div>
                  </div>
                )}

                {/* Dev Sold Warning */}
                {token.devSold && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    marginTop: '8px',
                    padding: '6px 10px',
                    background: 'var(--error-subtle)',
                    borderRadius: '4px'
                  }}>
                    <span style={{ fontSize: '14px' }}>!</span>
                    <span style={{ fontSize: '11px', color: 'var(--error)' }}>DEV SOLD</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
