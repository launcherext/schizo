/**
 * Script to update existing Helius webhook
 * Usage: tsx scripts/update-helius-webhook.ts
 */

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WEBHOOK_ID = 'b1d7d5fc-b652-48b7-8b01-a2377d598501';
const WEBHOOK_URL = 'https://schizoclaude.fun/api/helius-webhook';
const WALLET_ADDRESS = 'DR4d6RUYHay79dCbUEhU9BphWioVxvoExu4uULq6kJpG';

if (!HELIUS_API_KEY) {
  console.error('❌ HELIUS_API_KEY environment variable not set');
  process.exit(1);
}

async function updateWebhook() {
  const url = `https://api.helius.xyz/v0/webhooks/${WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`;
  
  const body = {
    webhookURL: WEBHOOK_URL,
    transactionTypes: [
      'SWAP',
      'TRANSFER',
      'TOKEN_MINT',
      'BURN'
    ],
    accountAddresses: [WALLET_ADDRESS],
    webhookType: 'enhanced',
  };

  console.log('🔄 Updating Helius webhook...');
  console.log('Webhook ID:', WEBHOOK_ID);
  console.log('Webhook URL:', WEBHOOK_URL);
  console.log('Monitoring wallet:', WALLET_ADDRESS);
  console.log('Transaction types:', body.transactionTypes.join(', '));

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const webhook = await response.json();
    console.log('\n✅ Webhook updated successfully!');
    console.log('Webhook ID:', webhook.webhookID);
    console.log('Account Addresses:', webhook.accountAddresses);
    console.log('Transaction Types:', webhook.transactionTypes);
    console.log('\nThe webhook will now send events for all transactions on your wallet!');
    
    return webhook;
  } catch (error) {
    console.error('\n❌ Failed to update webhook:', error);
    throw error;
  }
}

// Main execution
(async () => {
  try {
    await updateWebhook();
  } catch (error) {
    console.error('\n💥 Script failed:', error);
    process.exit(1);
  }
})();
