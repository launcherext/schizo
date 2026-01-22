import React from 'react';
import type { ScannerData } from '../types';
import { TokenDisplay } from './TokenDisplay';

interface TokenScannerProps {
  data?: ScannerData;
  isScanning: boolean;
  tokensScanned?: number;
}

export const TokenScanner: React.FC<TokenScannerProps> = ({ data, isScanning, tokensScanned = 0 }) => {
  return (
    <div className="card scanner-card">
      <div className="card-header">
        <span className="card-title">Token Scanner</span>
        <span style={{
          fontSize: '11px',
          color: 'var(--text-muted)',
          background: 'var(--bg-elevated)',
          padding: '4px 10px',
          borderRadius: '12px'
        }}>
          {tokensScanned.toLocaleString()} scanned
        </span>
      </div>
      <div className="scanner-content">
        <div className="scanner-token">
          <div className={`scanner-icon ${isScanning ? 'scanning' : ''}`}>
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
              <div style={{ padding: '8px 0' }}>
                <h4 style={{ margin: 0, color: 'var(--text-primary)' }}>
                  {isScanning ? 'Scanning...' : 'Waiting for tokens'}
                </h4>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>
                  Monitoring pump.fun for new launches
                </p>
              </div>
            )}
          </div>
        </div>

        {data?.mint && (
          <div style={{
            marginTop: '16px',
            padding: '12px',
            background: 'var(--bg-elevated)',
            borderRadius: '8px',
            fontSize: '12px',
            color: 'var(--text-muted)',
            textAlign: 'center'
          }}>
            Collecting price data for watchlist analysis...
          </div>
        )}
      </div>
    </div>
  );
};
