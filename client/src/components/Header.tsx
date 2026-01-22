import React from 'react';

interface HeaderProps {
  isConnected: boolean;
}

export const Header: React.FC<HeaderProps> = ({ isConnected }) => {
  return (
    <header className="header">
      <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', width: '300px', height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <img src="/header_full.png" alt="1 to 100 Sol Challenge" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      </div>
      <div 
        className="live-badge" 
        style={{
          background: isConnected ? 'var(--success-subtle)' : 'var(--error-subtle)',
          borderColor: isConnected ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
          color: isConnected ? 'var(--success)' : 'var(--error)'
        }}
      >
        {isConnected && <span className="live-dot"></span>}
        <span>{isConnected ? 'Live' : 'Disconnected'}</span>
      </div>
    </header>
  );
};
