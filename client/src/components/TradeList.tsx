import React from 'react';
import type { Trade } from '../types';
import { TokenDisplay } from './TokenDisplay';

interface TradeListProps {
  trades: Trade[];
}

export const TradeList: React.FC<TradeListProps> = ({ trades }) => {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Recent Trades</span>
      </div>
      <div className="trades-list">
        {trades.length === 0 ? (
          <div className="empty-state">No trades yet</div>
        ) : (
          trades.map((t, i) => {
            const pnl = parseFloat(t.pnlSol || "0");
            const pnlPercent = parseFloat(t.pnlPercent || "0");
            const isProfit = pnl >= 0;
            const time = new Date(t.exitTime || t.entryTime).toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true
            });

            return (
              <div key={i} className="trade-item">
                <div className={`trade-arrow ${isProfit ? 'up' : 'down'}`}>
                  {isProfit ? '↑' : '↓'}
                </div>
                <div className="trade-info">
                  <TokenDisplay
                    mint={t.mint}
                    name={t.name}
                    symbol={t.symbol}
                    imageUrl={t.imageUrl}
                    size="sm"
                    showCopy={true}
                    inline={true}
                  />
                  <div className="trade-time">{time}</div>
                </div>
                <div className="trade-pnl">
                  <div className={`trade-pnl-value ${isProfit ? 'positive' : 'negative'}`}>
                    {isProfit ? '+' : ''}{pnl.toFixed(4)} SOL
                  </div>
                  <div className={`trade-pnl-percent ${isProfit ? 'positive' : 'negative'}`}>
                    {isProfit ? '+' : ''}{pnlPercent.toFixed(1)}%
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
