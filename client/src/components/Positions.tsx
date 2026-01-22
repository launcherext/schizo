import React from 'react';
import type { Position } from '../hooks/useSocket';

interface PositionsProps {
  positions: Position[];
  summary: { totalUnrealizedPnl: string; totalExposure: string; positionCount: number } | null;
}

const formatHoldTime = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
};

export const Positions: React.FC<PositionsProps> = ({ positions, summary }) => {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Open Positions</span>
        {summary && (
          <span className={`card-badge ${parseFloat(summary.totalUnrealizedPnl) >= 0 ? 'positive' : 'negative'}`}>
            {parseFloat(summary.totalUnrealizedPnl) >= 0 ? '+' : ''}{parseFloat(summary.totalUnrealizedPnl).toFixed(4)} SOL
          </span>
        )}
      </div>
      <div className="positions-list">
        {positions.length === 0 ? (
          <div className="empty-state">No open positions</div>
        ) : (
          positions.map((p) => {
            const unrealizedPnl = parseFloat(String(p.unrealizedPnl));
            const unrealizedPnlPercent = parseFloat(String(p.unrealizedPnlPercent));
            const realizedPnl = p.realizedPnl ? parseFloat(String(p.realizedPnl)) : 0;
            const isProfit = unrealizedPnl >= 0;
            const holdTime = formatHoldTime(p.holdTime);

            return (
              <div key={p.id} className="position-item">
                <div className={`position-indicator ${isProfit ? 'profit' : 'loss'}`} />
                <div className="position-info">
                  <div className="position-header">
                    <span className="position-symbol">${p.symbol || p.mint.substring(0, 6).toUpperCase()}</span>
                    <span className="position-pool">{p.poolType}</span>
                  </div>
                  <div className="position-details">
                    <span className="position-size">{p.amountSol.toFixed(4)} SOL</span>
                    <span className="position-hold">{holdTime}</span>
                  </div>
                </div>
                <div className="position-pnl">
                  <div className={`position-unrealized ${isProfit ? 'positive' : 'negative'}`}>
                    {isProfit ? '+' : ''}{unrealizedPnl.toFixed(4)}
                    <span className="position-pnl-percent">({unrealizedPnlPercent.toFixed(1)}%)</span>
                  </div>
                  {realizedPnl !== 0 && (
                    <div className="position-realized">
                      Realized: {realizedPnl >= 0 ? '+' : ''}{realizedPnl.toFixed(4)}
                    </div>
                  )}
                </div>
                <div className="position-status">
                  {p.initialRecovered && <span className="status-badge recovered">IR</span>}
                  {p.scaledExitsTaken && p.scaledExitsTaken > 0 && (
                    <span className="status-badge exits">x{p.scaledExitsTaken}</span>
                  )}
                  {p.trailingStop && <span className="status-badge trailing">TS</span>}
                </div>
              </div>
            );
          })
        )}
      </div>
      {summary && positions.length > 0 && (
        <div className="positions-footer">
          <span>Total Exposure: {summary.totalExposure} SOL</span>
          <span>{summary.positionCount} position{summary.positionCount !== 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  );
};
