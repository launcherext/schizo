import React, { useState } from 'react';
import { copyToClipboard } from '../utils/clipboard';

interface TokenDisplayProps {
  mint: string;
  name?: string;
  symbol?: string;
  imageUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
  showCopy?: boolean;
  inline?: boolean;
}

// Generate a consistent color from a string
const stringToColor = (str: string): string => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = hash % 360;
  return `hsl(${hue}, 65%, 45%)`;
};

const sizeConfig = {
  sm: { img: 20, fontSize: '11px', gap: '6px' },
  md: { img: 28, fontSize: '12px', gap: '8px' },
  lg: { img: 40, fontSize: '14px', gap: '10px' },
};

export const TokenDisplay: React.FC<TokenDisplayProps> = ({
  mint,
  name,
  symbol,
  imageUrl,
  size = 'md',
  showCopy = true,
  inline = false,
}) => {
  const [copied, setCopied] = useState(false);
  const [imgError, setImgError] = useState(false);

  const config = sizeConfig[size];
  const displayName = name || symbol || 'Unknown';
  const displaySymbol = symbol ? `$${symbol}` : `$${mint.substring(0, 6).toUpperCase()}`;
  const truncatedMint = `${mint.substring(0, 6)}...${mint.substring(mint.length - 4)}`;
  const fallbackLetter = (symbol || name || mint)[0].toUpperCase();
  const fallbackColor = stringToColor(mint);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const success = await copyToClipboard(mint);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const renderImage = () => {
    if (imageUrl && !imgError) {
      return (
        <img
          src={imageUrl}
          alt={displayName}
          style={{
            width: config.img,
            height: config.img,
            borderRadius: '50%',
            objectFit: 'cover',
            flexShrink: 0,
          }}
          onError={() => setImgError(true)}
        />
      );
    }

    // Fallback: letter avatar
    return (
      <div
        style={{
          width: config.img,
          height: config.img,
          borderRadius: '50%',
          background: fallbackColor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontSize: config.img * 0.5,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {fallbackLetter}
      </div>
    );
  };

  if (inline) {
    // Compact inline display for lists
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: config.gap }}>
        {renderImage()}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: config.fontSize, color: 'var(--text-primary)' }}>
          {displaySymbol}
        </span>
        {showCopy && (
          <button
            onClick={handleCopy}
            style={{
              background: 'none',
              border: 'none',
              padding: '2px',
              cursor: 'pointer',
              color: copied ? 'var(--success)' : 'var(--text-muted)',
              fontSize: '10px',
              display: 'flex',
              alignItems: 'center',
            }}
            title="Copy address"
          >
            {copied ? '✓' : '⎘'}
          </button>
        )}
      </div>
    );
  }

  // Full display with name, symbol, and address
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: config.gap }}>
      {renderImage()}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        {size !== 'sm' && name && (
          <div style={{
            fontSize: config.fontSize,
            fontWeight: 500,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {displayName}
          </div>
        )}
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: size === 'lg' ? '12px' : '11px',
          color: 'var(--accent)',
        }}>
          {displaySymbol}
        </div>
        {showCopy && (
          <button
            onClick={handleCopy}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: copied ? 'var(--success)' : 'var(--text-muted)',
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
            }}
            title="Copy full address"
          >
            <span>{truncatedMint}</span>
            <span style={{ fontSize: '9px' }}>{copied ? '✓' : '⎘'}</span>
          </button>
        )}
      </div>
    </div>
  );
};

// Compact version for tight spaces (just image + symbol)
export const TokenBadge: React.FC<{
  mint: string;
  symbol?: string;
  imageUrl?: string | null;
  onClick?: () => void;
}> = ({ mint, symbol, imageUrl, onClick }) => {
  const [imgError, setImgError] = useState(false);
  const displaySymbol = symbol ? `$${symbol}` : `$${mint.substring(0, 6).toUpperCase()}`;
  const fallbackLetter = (symbol || mint)[0].toUpperCase();
  const fallbackColor = stringToColor(mint);

  return (
    <div
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 8px 2px 2px',
        borderRadius: '12px',
        background: 'var(--bg-elevated)',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      {imageUrl && !imgError ? (
        <img
          src={imageUrl}
          alt={displaySymbol}
          style={{ width: 18, height: 18, borderRadius: '50%', objectFit: 'cover' }}
          onError={() => setImgError(true)}
        />
      ) : (
        <div
          style={{
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: fallbackColor,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 9,
            fontWeight: 600,
          }}
        >
          {fallbackLetter}
        </div>
      )}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-primary)' }}>
        {displaySymbol}
      </span>
    </div>
  );
};
