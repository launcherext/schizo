import type { C100Data } from '../types';

interface C100CardProps {
  data: C100Data | null;
}

export function C100Card({ data }: C100CardProps) {
  if (!data || !data.enabled) {
    return null;
  }

  const formatNumber = (num: number, decimals: number = 4) => {
    if (num === 0) return '0';
    if (num < 0.0001) return num.toExponential(2);
    return num.toFixed(decimals);
  };

  const formatLargeNumber = (num: number) => {
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
  };

  const truncateMint = (mint: string) => {
    if (!mint) return '';
    return `${mint.slice(0, 6)}...${mint.slice(-4)}`;
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const priceChange = data.token?.priceChange24h || 0;
  const isPriceUp = priceChange >= 0;

  return (
    <div className="c100-card card">
      <div className="c100-header">
        <div className="c100-token-info">
          <div className="c100-icon">C</div>
          <div className="c100-details">
            <h3>{data.token?.name || 'C100'}</h3>
            <div className="c100-ticker">${data.token?.symbol || 'C100'}</div>
          </div>
        </div>
        {data.token && (
          <div
            className="c100-mint"
            onClick={() => copyToClipboard(data.token!.mint)}
            title="Click to copy"
          >
            {truncateMint(data.token.mint)}
          </div>
        )}
      </div>

      <div className="c100-grid">
        {/* Price Section */}
        <div className="c100-stat">
          <span className="c100-stat-label">Price</span>
          <span className="c100-stat-value">
            ${data.token ? formatNumber(data.token.priceUsd, 8) : '—'}
          </span>
          {data.token && (
            <span className={`c100-stat-change ${isPriceUp ? 'positive' : 'negative'}`}>
              {isPriceUp ? '+' : ''}{priceChange.toFixed(2)}%
            </span>
          )}
        </div>

        {/* Market Cap */}
        <div className="c100-stat">
          <span className="c100-stat-label">Market Cap</span>
          <span className="c100-stat-value">
            ${data.token ? formatLargeNumber(data.token.marketCapUsd) : '—'}
          </span>
        </div>

        {/* SOL Claimed */}
        <div className="c100-stat highlight">
          <span className="c100-stat-label">SOL Claimed</span>
          <span className="c100-stat-value accent">
            {formatNumber(data.claims.totalClaimedSol, 4)}
          </span>
          <span className="c100-stat-sub">{data.claims.claimCount} claims</span>
        </div>

        {/* SOL Buyback */}
        <div className="c100-stat highlight">
          <span className="c100-stat-label">SOL Buyback</span>
          <span className="c100-stat-value accent">
            {formatNumber(data.buybacks.totalBuybackSol, 4)}
          </span>
          <span className="c100-stat-sub">{data.buybacks.buybackCount} buys</span>
        </div>

        {/* Tokens Bought */}
        <div className="c100-stat wide">
          <span className="c100-stat-label">C100 Tokens Bought</span>
          <span className="c100-stat-value large">
            {formatLargeNumber(data.buybacks.totalTokensBought)}
          </span>
        </div>
      </div>
    </div>
  );
}
