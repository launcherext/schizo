/**
 * Script to create Helius webhook via API
 * Usage: tsx scripts/setup-helius-webhook.ts
 */

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WEBHOOK_URL = 'https://schizoclaude.fun/api/helius-webhook';
const WALLET_ADDRESS = 'DR4d6RUYHay79dCbUEhU9BphWioVxvoExu4uULq6kJpG';

if (!HELIUS_API_KEY) {
  console.error('❌ HELIUS_API_KEY environment variable not set');
  process.exit(1);
}

async function createWebhook() {
  const url = `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`;
  
  const body = {
    webhookURL: WEBHOOK_URL,
    transactionTypes: [
      'SWAP',
      'TOKEN_MINT',
      'TOKEN_BURN',
      'TRANSFER'
    ],
    accountAddresses: [WALLET_ADDRESS],
    webhookType: 'enhanced',
    authHeader: '', // Optional: add HELIUS_WEBHOOK_SECRET if you want signature verification
  };

  console.log('📡 Creating Helius webhook...');
  console.log('Webhook URL:', WEBHOOK_URL);
  console.log('Monitoring wallet:', WALLET_ADDRESS);
  console.log('Transaction types:', body.transactionTypes.join(', '));

  try {
    const response = await fetch(url, {
      method: 'POST',
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
    console.log('\n✅ Webhook created successfully!');
    console.log('Webhook ID:', webhook.webhookID);
    console.log('Wallet:', webhook.wallet);
    console.log('\nYou can manage this webhook at: https://dashboard.helius.dev/webhooks');
    
    return webhook;
  } catch (error) {
    console.error('\n❌ Failed to create webhook:', error);
    throw error;
  }
}

async function listWebhooks() {
  const url = `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`;
  
  console.log('\n📋 Fetching existing webhooks...');
  
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const webhooks = await response.json();
    
    if (webhooks.length === 0) {
      console.log('No existing webhooks found.');
      return [];
    }

    console.log(`\nFound ${webhooks.length} webhook(s):`);
    webhooks.forEach((wh: any, i: number) => {
      console.log(`\n${i + 1}. Webhook ID: ${wh.webhookID}`);
      console.log(`   URL: ${wh.webhookURL}`);
      console.log(`   Type: ${wh.webhookType}`);
      console.log(`   Addresses: ${wh.accountAddresses?.join(', ') || 'None'}`);
      console.log(`   Transaction Types: ${wh.transactionTypes?.join(', ') || 'None'}`);
    });

    return webhooks;
  } catch (error) {
    console.error('\n❌ Failed to list webhooks:', error);
    throw error;
  }
}

// Main execution
(async () => {
  try {
    // First, list existing webhooks
    const existing = await listWebhooks();
    
    // Check if webhook already exists for this URL
    const alreadyExists = existing.some((wh: any) => wh.webhookURL === WEBHOOK_URL);
    
    if (alreadyExists) {
      console.log('\n⚠️  Webhook already exists for this URL!');
      console.log('If you want to recreate it, delete the existing one first:');
      console.log('https://dashboard.helius.dev/webhooks');
    } else {
      // Create new webhook
      await createWebhook();
    }
  } catch (error) {
    console.error('\n💥 Script failed:', error);
    process.exit(1);
  }
})();
