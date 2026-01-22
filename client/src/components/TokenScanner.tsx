import React, { useEffect, useState } from 'react';
import type { ScannerData } from '../types';
import { TokenDisplay } from './TokenDisplay';

interface TokenScannerProps {
  data?: ScannerData;
  isScanning: boolean;
}

// Helper to generate chart bars
const MiniChart: React.FC = () => {
  const [bars, setBars] = useState<Array<{ height: number; isUp: boolean }>>([]);

  useEffect(() => {
    // Generate static random chart on mount, or could animate
    const newBars = Array.from({ length: 40 }, () => ({
      height: Math.random() * 70 + 20,
      isUp: Math.random() > 0.4
    }));
    setBars(newBars);
  }, []);

  return (
    <div className="mini-chart">
      {bars.map((bar, i) => (
        <div 
          key={i} 
          className={`chart-bar ${bar.isUp ? 'up' : 'down'}`}
          style={{ height: `${bar.height}%` }}
        />
      ))}
    </div>
  );
};

export const TokenScanner: React.FC<TokenScannerProps> = ({ data, isScanning }) => {
  // Simulating metrics for visual flair if data is generic
  // In real app, these should come from backend
  const [metrics, setMetrics] = useState({
    safetyScore: '--',
    sentiment: '--',
    volume: '--',
    holders: '--'
  });

  useEffect(() => {
    if (data && data.mint) {
      // Simulate "analysis" result display
      setMetrics({
        safetyScore: String(Math.floor(Math.random() * 30 + 70)),
        sentiment: '+' + (Math.random() * 0.8 + 0.2).toFixed(1),
        volume: '$' + (Math.random() * 900000 + 100000).toLocaleString(undefined, { maximumFractionDigits: 0 }),
        holders: (Math.random() * 5000 + 1000).toFixed(0)
      });
    } else {
      setMetrics({
        safetyScore: '--',
        sentiment: '--',
        volume: '--',
        holders: '--'
      });
    }
  }, [data]);

  return (
    <div className="card scanner-card">
      <div className="card-header">
        <span className="card-title">Token Scanner</span>
      </div>
      <div className="scanner-content">
        <div className="scanner-token">
          <div className={`scanner-icon ${!isScanning && !data?.mint ? 'idle' : ''}`}>
            ⟳
          </div>
          <div className="scanner-token-info">
            {data?.mint ? (
              <TokenDisplay
                mint={data.mint}
                name={data.name}
                symbol={data.symbol}
                imageUrl={data.imageUrl}
                size="lg"
                showCopy={true}
              />
            ) : (
              <>
                <h4>Waiting...</h4>
                <p>{isScanning ? 'Scanning for tokens' : 'Idle'}</p>
              </>
            )}
          </div>
        </div>
        <div className="scanner-metrics">
          <div className="metric-box">
            <div className="metric-value accent">{metrics.safetyScore}</div>
            <div className="metric-label">Safety Score</div>
          </div>
          <div className="metric-box">
            <div className="metric-value success">{metrics.sentiment}</div>
            <div className="metric-label">Sentiment</div>
          </div>
          <div className="metric-box">
            <div className="metric-value">{metrics.volume}</div>
            <div className="metric-label">24H Volume</div>
          </div>
          <div className="metric-box">
            <div className="metric-value">{metrics.holders}</div>
            <div className="metric-label">Holders</div>
          </div>
        </div>
        <MiniChart />
      </div>
    </div>
  );
};
