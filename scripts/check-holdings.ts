/**
 * Check current wallet token holdings via Helius DAS API
 */

import { Connection, PublicKey } from '@solana/web3.js';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'dd091d8d-f7eb-4d3c-83fc-87cc3232f4f6';
const WALLET_ADDRESS = 'DR4d6RUYHay79dCbUEhU9BphWioVxvoExu4uULq6kJpG';

async function checkHoldings() {
  console.log('🔍 Fetching wallet holdings...');
  console.log('Wallet:', WALLET_ADDRESS);
  console.log('');
  
  try {
    // Use Helius RPC to get token accounts
    const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`);
    
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(WALLET_ADDRESS),
      { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
    );

    // Filter for tokens with non-zero balance
    const tokens = tokenAccounts.value
      .map(acc => {
        const info = acc.account.data.parsed.info;
        return {
          mint: info.mint,
          balance: parseFloat(info.tokenAmount.uiAmountString),
          decimals: info.tokenAmount.decimals,
        };
      })
      .filter(t => t.balance > 0);

    if (tokens.length === 0) {
      console.log('❌ No token holdings found');
      
      // Check SOL balance
      const solBalance = await connection.getBalance(new PublicKey(WALLET_ADDRESS));
      console.log(`💰 SOL Balance: ${(solBalance / 1e9).toFixed(6)} SOL`);
      return;
    }

    console.log(`✅ Found ${tokens.length} token(s):\n`);

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      console.log(`${i + 1}. Token`);
      console.log(`   Mint: ${token.mint}`);
      console.log(`   Balance: ${token.balance.toLocaleString(undefined, { maximumFractionDigits: 6 })}`);
      console.log('');
    }

    // Check SOL balance
    const solBalance = await connection.getBalance(new PublicKey(WALLET_ADDRESS));
    console.log(`💰 SOL Balance: ${(solBalance / 1e9).toFixed(6)} SOL`);

  } catch (error: any) {
    console.error('❌ Error fetching holdings:', error.message);
    throw error;
  }
}

checkHoldings();
