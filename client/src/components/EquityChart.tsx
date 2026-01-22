import React, { useMemo } from 'react';
import type { EquitySnapshot } from '../hooks/useSocket';

interface EquityChartProps {
  history: EquitySnapshot[];
  walletBalance?: number;
}

export const EquityChart: React.FC<EquityChartProps> = ({ history, walletBalance }) => {
  const chartData = useMemo(() => {
    if (history.length < 2) return null;

    const values = history.map(s => s.totalEquity);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = maxVal - minVal || 1;

    // Chart dimensions
    const width = 300;
    const height = 60;
    const padding = 4;

    // Calculate points
    const points = values.map((val, i) => {
      const x = padding + (i / (values.length - 1)) * (width - padding * 2);
      const y = height - padding - ((val - minVal) / range) * (height - padding * 2);
      return `${x},${y}`;
    }).join(' ');

    // Determine trend
    const firstVal = values[0];
    const lastVal = values[values.length - 1];
    const isUp = lastVal >= firstVal;
    const change = lastVal - firstVal;
    const changePercent = firstVal > 0 ? (change / firstVal) * 100 : 0;

    return {
      points,
      width,
      height,
      isUp,
      change,
      changePercent,
      current: lastVal,
      min: minVal,
      max: maxVal,
    };
  }, [history]);

  if (!chartData) {
    return (
      <div className="card equity-chart-card">
        <div className="card-header">
          <span className="card-title">Equity</span>
        </div>
        <div className="equity-chart-empty">
          <span>Collecting data...</span>
          {walletBalance !== undefined && (
            <span className="wallet-balance">{walletBalance.toFixed(4)} SOL</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="card equity-chart-card">
      <div className="card-header">
        <span className="card-title">Equity</span>
        <span className={`card-badge ${chartData.isUp ? 'positive' : 'negative'}`}>
          {chartData.isUp ? '+' : ''}{chartData.changePercent.toFixed(2)}%
        </span>
      </div>
      <div className="equity-chart-content">
        <div className="equity-current">
          <span className="equity-value">{chartData.current.toFixed(4)}</span>
          <span className="equity-label">SOL</span>
        </div>
        <svg
          className="equity-sparkline"
          viewBox={`0 0 ${chartData.width} ${chartData.height}`}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={chartData.isUp ? '#10b981' : '#ef4444'}
                stopOpacity="0.3"
              />
              <stop
                offset="100%"
                stopColor={chartData.isUp ? '#10b981' : '#ef4444'}
                stopOpacity="0"
              />
            </linearGradient>
          </defs>
          <polygon
            points={`${4},${chartData.height - 4} ${chartData.points} ${chartData.width - 4},${chartData.height - 4}`}
            fill="url(#equityGradient)"
          />
          <polyline
            points={chartData.points}
            fill="none"
            stroke={chartData.isUp ? '#10b981' : '#ef4444'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <div className="equity-range">
          <span>{chartData.min.toFixed(2)}</span>
          <span>{chartData.max.toFixed(2)}</span>
        </div>
      </div>
      <div className="equity-footer">
        <span className={chartData.isUp ? 'positive' : 'negative'}>
          {chartData.isUp ? '+' : ''}{chartData.change.toFixed(4)} SOL (24h)
        </span>
        {walletBalance !== undefined && (
          <span className="wallet-indicator">
            Wallet: {walletBalance.toFixed(4)}
          </span>
        )}
      </div>
    </div>
  );
};
