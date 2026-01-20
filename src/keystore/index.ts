/**
 * Encrypted keystore module for secure wallet management.
 *
 * Provides secure storage and retrieval of Solana keypairs using
 * AES-256-GCM encryption with PBKDF2 key derivation.
 *
 * @example
 * import { createKeystore, saveKeystore, loadKeystore } from './keystore/index.js';
 *
 * // Create and save a new wallet
 * const { keypair, keystore } = createKeystore('my-password');
 * saveKeystore(keystore, 'wallet.keystore.json');
 *
 * // Later, load the wallet
 * const loadedKeypair = loadKeystore('wallet.keystore.json', 'my-password');
 *
 * @module keystore
 */

export { createKeystore, saveKeystore, loadKeystore, type KeystoreFile } from './keystore.js';
export { encrypt, decrypt, type EncryptedData } from './crypto.js';
