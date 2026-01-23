import React from 'react';

interface HeaderProps {
  isConnected: boolean;
}

export const Header: React.FC<HeaderProps> = ({ isConnected }) => {
  return (
    <header className="header">
      <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
        <img src="/logo.png" alt="Trader By Claude" style={{ height: '50px', width: 'auto', objectFit: 'contain' }} />
        <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>Trader By Claude</h1>
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
