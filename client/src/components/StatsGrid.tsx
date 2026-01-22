import React, { useEffect, useState } from 'react';
import type { Stats } from '../types';

interface StatsGridProps {
  stats: Stats;
}

const NumberDisplay: React.FC<{ value: string | number; className?: string }> = ({ value, className = "" }) => {
  const [displayValue, setDisplayValue] = useState(value);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (value !== displayValue) {
      setUpdating(true);
      setDisplayValue(value);
      const timer = setTimeout(() => setUpdating(false), 300);
      return () => clearTimeout(timer);
    }
  }, [value, displayValue]);

  return (
    <div className={`animate-number ${updating ? 'updating' : ''} ${className}`}>
      {value}
    </div>
  );
};

export const StatsGrid: React.FC<StatsGridProps> = ({ stats }) => {
  const equity = parseFloat(stats.currentEquity || "0");
  const initial = parseFloat(stats.initialCapital || "0");
  const profit = equity - initial;
  const isProfit = profit >= 0;

  return (
    <div className="stats-grid">
      <div className="stat-card highlight">
        <div className="stat-label">Multiplier</div>
        <NumberDisplay value={`${parseFloat(stats.multiplier || "1").toFixed(2)}x`} className="stat-value accent" />
        <div className={`stat-sub ${isProfit ? 'positive' : ''}`}>
          <span className="arrow">↑</span>
          <span>{isProfit ? '+' : ''}{profit.toFixed(2)} SOL profit</span>
        </div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Win Rate</div>
        <NumberDisplay value={`${stats.winRate}%`} className="stat-value" />
        <div className="stat-sub positive">
          <span className="arrow">↑</span>
          <span>Creating alpha</span>
        </div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Total Trades</div>
        <NumberDisplay value={stats.totalTrades} className="stat-value" />
        <div className="stat-sub">Lifetime</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Tokens Scanned</div>
        <NumberDisplay value={stats.tokensScanned} className="stat-value" />
        <div className="stat-sub">Last 24 hours</div>
      </div>
    </div>
  );
};
