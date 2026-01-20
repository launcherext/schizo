// WebSocket client and UI logic for $SCHIZO dashboard

let ws;
let isPaused = false;
let isTokensPaused = false;
let buybackCount = 0;

// Get WebSocket URL based on environment
function getWebSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;

  // Local development
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return 'ws://localhost:8080';
  }

  // Production - use same host
  return `${protocol}//${host}`;
}

// Connect to WebSocket server
function connect() {
  const wsUrl = getWebSocketUrl();
  console.log('Connecting to:', wsUrl);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('Connected to $SCHIZO agent');
    updateStatus('Connected', true);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleEvent(data);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    updateStatus('Error', false);
  };

  ws.onclose = () => {
    console.log('Disconnected from $SCHIZO agent');
    updateStatus('Disconnected', false);
    // Attempt to reconnect after 5 seconds
    setTimeout(connect, 5000);
  };
}

// Handle incoming events
function handleEvent(event) {
  switch (event.type) {
    case 'CONNECTED':
      addToFeed('🟢 Connected to agent', 'system');
      break;
    case 'ANALYSIS_START':
      // Silent - too spammy
      break;
    case 'SAFETY_CHECK':
      // Silent - only show interesting decisions
      break;
    case 'SMART_MONEY_CHECK':
      // Silent - show in trade decisions if relevant
      break;
    case 'TRADE_DECISION':
      // Silent - only show actual trades, not analysis chatter
      break;
    case 'TRADE_EXECUTED':
      const emoji = event.data.type === 'BUY' ? '💰' : '💸';
      addToFeed(`${emoji} ${event.data.type}: ${event.data.amount.toFixed(2)} SOL - ${formatMint(event.data.mint)}`, 'trade');
      addToTradesTable(event.data);
      break;
    case 'BUYBACK_TRIGGERED':
      addToFeed(`🔄 BUYBACK: ${event.data.amount.toFixed(2)} SOL (profit: ${event.data.profit.toFixed(2)} SOL)`, 'buyback');
      buybackCount = (buybackCount || 0) + 1;
      updateBuybackCount();
      break;
    case 'STATS_UPDATE':
      updateStats(event.data);
      break;
    case 'STOP_LOSS':
      addToFeed(`🛑 STOP-LOSS: ${formatMint(event.data.mint)} @ ${event.data.lossPercent.toFixed(1)}% loss`, 'stop-loss');
      break;
    case 'TAKE_PROFIT':
      addToFeed(`🎯 TAKE-PROFIT: ${formatMint(event.data.mint)} @ +${event.data.profitPercent.toFixed(1)}% gain`, 'take-profit');
      break;
    case 'SCHIZO_SPEAKS':
      // Voice only - no text in feed
      break;
    case 'SCHIZO_COMMENTARY':
      // Voice only - no text in feed
      break;
    case 'SCHIZO_LEARNING':
      // Voice only - no text in feed
      break;
    case 'CHAT_RECEIVED':
      const chatUser = event.data.username || 'anon';
      addToChat(`💬 @${chatUser}: ${event.data.message}`, 'user-message');
      break;
    case 'CHAT_RESPONSE':
      hideTypingIndicator();
      addToChat(`🤖 $SCHIZO: ${event.data.response}`, 'schizo-response');
      break;
    case 'CHAT_TYPING':
      if (event.data.typing) {
        showTypingIndicator();
      } else {
        hideTypingIndicator();
      }
      break;
    case 'VOICE_AUDIO':
      playVoiceAudio(event.data);
      break;
    case 'TOKEN_DISCOVERED':
      addToTokenStream(event.data);
      break;
    case 'TOKEN_COMMENTARY':
      // Claude's random commentary on tokens (voice only, but show in stream)
      highlightTokenCommentary(event.data.mint, event.data.commentary);
      break;
  }
}

// Current token being viewed
let currentToken = null;

// Add token to the streaming list
function addToTokenStream(token) {
  if (isTokensPaused) return;

  currentToken = token;

  const container = document.getElementById('token-stream');
  if (!container) return;

  const tokenEl = document.createElement('div');
  tokenEl.className = 'token-stream-item';
  tokenEl.id = `token-${token.mint}`;
  tokenEl.onclick = () => openChart(token.mint, token.dexUrl);

  const priceChangeClass = (token.priceChange5m || 0) >= 0 ? 'price-up' : 'price-down';
  const priceChangeSign = (token.priceChange5m || 0) >= 0 ? '+' : '';
  const priceDisplay = token.priceUsd
    ? (token.priceUsd < 0.0001 ? token.priceUsd.toExponential(2) : '$' + token.priceUsd.toFixed(6))
    : 'New';
  const mcapDisplay = token.marketCap ? '$' + formatNumber(token.marketCap) : (token.marketCapSol ? token.marketCapSol.toFixed(1) + ' SOL' : '-');

  tokenEl.innerHTML = `
    <div class="token-stream-left">
      ${token.imageUrl ? `<img src="${token.imageUrl}" alt="${token.symbol}" class="token-stream-img">` : '<div class="token-stream-img-placeholder">?</div>'}
      <div class="token-stream-info">
        <span class="token-stream-symbol">${token.symbol || 'UNK'}</span>
        <span class="token-stream-name">${(token.name || 'Unknown').slice(0, 20)}</span>
      </div>
    </div>
    <div class="token-stream-right">
      <span class="token-stream-price">${priceDisplay}</span>
      <span class="token-stream-mcap">${mcapDisplay}</span>
      <span class="token-stream-change ${priceChangeClass}">${priceChangeSign}${(token.priceChange5m || 0).toFixed(1)}%</span>
    </div>
  `;

  // Add to top of stream
  container.insertBefore(tokenEl, container.firstChild);

  // Limit to 20 items
  while (container.children.length > 20) {
    container.removeChild(container.lastChild);
  }

  // Flash effect for new token
  tokenEl.classList.add('token-new');
  setTimeout(() => tokenEl.classList.remove('token-new'), 2000);
}

// Highlight token when Claude comments on it
function highlightTokenCommentary(mint, commentary) {
  const tokenEl = document.getElementById(`token-${mint}`);
  if (tokenEl) {
    tokenEl.classList.add('token-commented');

    // Add commentary bubble
    const bubble = document.createElement('div');
    bubble.className = 'token-commentary-bubble';
    bubble.textContent = commentary.slice(0, 100) + (commentary.length > 100 ? '...' : '');
    tokenEl.appendChild(bubble);

    // Remove after 8 seconds
    setTimeout(() => {
      tokenEl.classList.remove('token-commented');
      bubble.remove();
    }, 8000);
  }
}

// Format large numbers
function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toFixed(0);
}

// Open chart popup
function openChart(mint, dexUrl) {
  const popup = document.getElementById('chart-popup');
  const iframe = document.getElementById('chart-iframe');

  // Use DexScreener embed
  iframe.src = `https://dexscreener.com/solana/${mint}?embed=1&theme=dark&trades=0&info=0`;
  popup.classList.add('visible');
}

// Close chart popup
function closeChart() {
  const popup = document.getElementById('chart-popup');
  const iframe = document.getElementById('chart-iframe');
  popup.classList.remove('visible');
  iframe.src = '';
}

// Play voice audio from base64
function playVoiceAudio(data) {
  try {
    const audio = new Audio(`data:audio/mp3;base64,${data.audio}`);
    audio.play().catch(err => console.log('Audio autoplay blocked:', err));
  } catch (error) {
    console.error('Error playing audio:', error);
  }
}

// Update dashboard stats
function updateStats(stats) {
  document.getElementById('winRate').textContent = stats.winRate.toFixed(1) + '%';
  document.getElementById('pnl').textContent = stats.dailyPnL.toFixed(2) + ' SOL';
  document.getElementById('buybacks').textContent = stats.totalBuybacks;
  if (stats.balance !== undefined) {
    document.getElementById('balance').textContent = stats.balance.toFixed(4) + ' SOL';
  }
}

// Add event to feed
function addToFeed(message, className = '') {
  if (isPaused) return;

  const feed = document.getElementById('feed');
  const div = document.createElement('div');
  div.className = `event ${className}`;

  const timestamp = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="timestamp">[${timestamp}]</span>${message}`;

  feed.appendChild(div);

  // Auto-scroll to bottom
  feed.scrollTop = feed.scrollHeight;

  // Limit feed to 100 items
  while (feed.children.length > 100) {
    feed.removeChild(feed.firstChild);
  }
}

// Add message to chat box
function addToChat(message, className = '') {
  const chatBox = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg ${className}`;

  const timestamp = new Date().toLocaleTimeString();
  div.innerHTML = `<span class="timestamp">[${timestamp}]</span>${message}`;

  chatBox.appendChild(div);

  // Auto-scroll to bottom
  chatBox.scrollTop = chatBox.scrollHeight;

  // Limit chat to 50 items
  while (chatBox.children.length > 50) {
    chatBox.removeChild(chatBox.firstChild);
  }
}

// Typing indicator
function showTypingIndicator() {
  const chatBox = document.getElementById('chat-messages');

  // Don't add if already showing
  if (document.getElementById('typing-indicator')) return;

  const div = document.createElement('div');
  div.id = 'typing-indicator';
  div.className = 'chat-msg typing-indicator';
  div.innerHTML = `<span class="typing-dots">🤖 $SCHIZO is typing<span>.</span><span>.</span><span>.</span></span>`;

  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function hideTypingIndicator() {
  const indicator = document.getElementById('typing-indicator');
  if (indicator) {
    indicator.remove();
  }
}

// Add trade to table
function addToTradesTable(trade) {
  const tbody = document.querySelector('#trades tbody');
  const row = document.createElement('tr');
  
  const time = new Date(trade.timestamp || Date.now()).toLocaleTimeString();
  const typeClass = trade.type === 'BUY' ? 'trade-buy' : 'trade-sell';
  const signature = formatSignature(trade.signature);
  
  row.innerHTML = `
    <td>${time}</td>
    <td class="${typeClass}">${trade.type}</td>
    <td>${formatMint(trade.mint)}</td>
    <td>${trade.amount.toFixed(2)} SOL</td>
    <td><a href="https://solscan.io/tx/${trade.signature}" target="_blank">${signature}</a></td>
  `;
  
  tbody.insertBefore(row, tbody.firstChild);
  
  // Limit table to 20 rows
  while (tbody.children.length > 20) {
    tbody.removeChild(tbody.lastChild);
  }
}

// Update status indicator
function updateStatus(status, connected) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = status;
  statusEl.className = connected ? 'status-connected' : 'status-disconnected';
}

// Update buyback count
function updateBuybackCount() {
  document.getElementById('buybacks').textContent = buybackCount;
}

// Format mint address
function formatMint(mint) {
  return mint.slice(0, 4) + '...' + mint.slice(-4);
}

// Format signature
function formatSignature(sig) {
  return sig.slice(0, 8) + '...';
}

// Pause/Resume feed
document.getElementById('pauseBtn').addEventListener('click', () => {
  isPaused = !isPaused;
  const btn = document.getElementById('pauseBtn');
  btn.textContent = isPaused ? 'Resume' : 'Pause';
});

// Pause/Resume tokens stream
document.getElementById('pauseTokensBtn')?.addEventListener('click', () => {
  isTokensPaused = !isTokensPaused;
  const btn = document.getElementById('pauseTokensBtn');
  btn.textContent = isTokensPaused ? 'Resume' : 'Pause';
});

// Chat functionality
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'CHAT',
    message: message,
    username: 'anon' // Could be customizable
  }));

  chatInput.value = '';
}

sendBtn.addEventListener('click', sendChatMessage);

chatInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    sendChatMessage();
  }
});

// Connect on page load
connect();

// ============================================
// SCHIZO 3D CHARACTER TOGGLE
// ============================================
let schizoVisible = false;

function toggleSchizo() {
    const container = document.getElementById('schizo-3d-container');
    const btn = document.getElementById('schizo-toggle-btn');

    if (!container) return;

    schizoVisible = !schizoVisible;

    if (schizoVisible) {
        container.classList.remove('schizo-hidden');
        container.classList.add('schizo-visible');
        btn.classList.add('active');
        btn.querySelector('.schizo-btn-text').textContent = 'Close Schizo';

        // Dispatch event for 3D module to initialize
        window.dispatchEvent(new CustomEvent('schizo-open'));
    } else {
        container.classList.remove('schizo-visible');
        container.classList.add('schizo-hidden');
        btn.classList.remove('active');
        btn.querySelector('.schizo-btn-text').textContent = 'Open Schizo';

        // Dispatch event for 3D module
        window.dispatchEvent(new CustomEvent('schizo-close'));
    }
}

// Check if Schizo is visible (for 3D module)
window.isSchizoVisible = () => schizoVisible;

// $SCHIZO Token Card - Update function for when token goes live
function updateSchizoTokenCard(data) {
  if (data.price) {
    document.getElementById('schizo-price').textContent =
      data.price < 0.0001 ? '$' + data.price.toExponential(2) : '$' + data.price.toFixed(6);
  }
  if (data.marketCap) {
    document.getElementById('schizo-mcap').textContent = '$' + formatNumber(data.marketCap);
  }
  if (data.holders) {
    document.getElementById('schizo-holders').textContent = formatNumber(data.holders);
  }
  if (data.volume24h) {
    document.getElementById('schizo-volume').textContent = '$' + formatNumber(data.volume24h);
  }
  if (data.ca) {
    const caInput = document.getElementById('schizo-ca-input');
    if (caInput) {
      caInput.value = data.ca;
      caInput.onclick = () => {
        caInput.select();
        navigator.clipboard.writeText(data.ca);
        
        // Visual feedback
        const oldVal = caInput.value;
        const hint = document.querySelector('.copy-hint');
        if (hint) {
            const originalText = hint.textContent;
            hint.textContent = 'COPIED!';
            hint.style.color = '#4ade80';
            setTimeout(() => {
                hint.textContent = originalText;
                hint.style.color = '';
            }, 1500);
        }
      };
    }
  }
  if (data.live) {
    const statusEl = document.querySelector('.token-card-status');
    statusEl.textContent = 'Live';
    statusEl.classList.add('live');
    
    // Update button text/link if needed
    const buyBtn = document.querySelector('.btn-primary');
    if (buyBtn && data.dexUrl) {
        buyBtn.href = data.dexUrl;
        buyBtn.textContent = 'BUY NOW';
    }
  }
}

// Handle SCHIZO_TOKEN_UPDATE event from server (when token goes live)
// This will be emitted by the server when fetching data from DexScreener/PumpPortal

// ============================================
// TERMINAL LOGIC
// ============================================
const terminalMessages = [
    '> SEARCHING FOR ALPHA...',
    '> ERROR: TRUST NO ONE.',
    '> DETECTING JEETS...',
    '> SCANNING MEMPOOL...',
    '> ANALYZING WHALE MOVEMENTS...',
    '> SYSTEM INTEGRITY: COMPROMISED',
    '> THE BLOCKCHAIN IS WATCHING',
    '> ENCRYPTING THOUGHTS...',
    '> DECODING SMART MONEY...',
    '> PARANOIA LEVEL: CRITICAL',
    '> BUY SIGNALS DETECTED',
    '> IGNORING FUD...',
    '> EXECUTING STRATEGY 99...',
    '> CHECKING WALLET SECURITY...'
];

function initTerminal() {
    const terminal = document.getElementById('terminal-content');
    if (!terminal) return;

    function addLine(text) {
        const line = document.createElement('div');
        line.className = 'terminal-line';
        terminal.appendChild(line);
        
        let i = 0;
        const speed = 30 + Math.random() * 40;
        
        const interval = setInterval(() => {
            line.textContent += text.charAt(i);
            i++;
            if (i >= text.length) clearInterval(interval);
        }, speed);

        // Keep last 6 lines
        while (terminal.children.length > 6) {
            terminal.removeChild(terminal.firstChild);
        }
    }

    // Random interval
    function scheduleNext() {
        const delay = 1500 + Math.random() * 2500;
        setTimeout(() => {
            const msg = terminalMessages[Math.floor(Math.random() * terminalMessages.length)];
            addLine(msg);
            scheduleNext();
        }, delay);
    }
    
    scheduleNext();
}

// ============================================
// EYE TRACKING LOGIC
// ============================================
function initEyeTracking() {
    const logo = document.getElementById('hero-logo');
    if (!logo) return;

    document.addEventListener('mousemove', (e) => {
        const rect = logo.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        const deltaX = e.clientX - centerX;
        const deltaY = e.clientY - centerY;

        // Limit movement magnitude
        const moveX = Math.min(Math.max(deltaX / 25, -12), 12);
        const moveY = Math.min(Math.max(deltaY / 25, -12), 12);

        logo.style.transform = `translate(${moveX}px, ${moveY}px)`;
    });
}

// Initialize new features when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initTerminal();
    initEyeTracking();
});
