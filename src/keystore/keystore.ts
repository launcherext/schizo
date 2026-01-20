import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'node:fs';
import { encrypt, decrypt, type EncryptedData } from './crypto.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('keystore');

/**
 * Keystore file format for encrypted wallet storage.
 *
 * The private key is encrypted with AES-256-GCM using a password-derived key.
 * Only the public key is stored in plaintext for identification.
 */
export interface KeystoreFile {
  /** Format version for future compatibility */
  version: 1;
  /** Base58-encoded public key (safe to store unencrypted) */
  publicKey: string;
  /** AES-256-GCM encrypted private key */
  encryptedPrivateKey: EncryptedData;
  /** ISO timestamp of keystore creation */
  createdAt: string;
}

/**
 * Create a new keystore with a freshly generated keypair.
 *
 * @param password - The password to encrypt the private key
 * @returns The keypair and keystore data (keystore not yet saved to disk)
 *
 * @example
 * const { keypair, keystore } = createKeystore('my-secure-password');
 * // keypair can be used for signing
 * // keystore can be saved to disk with saveKeystore()
 */
export function createKeystore(password: string): {
  keypair: Keypair;
  keystore: KeystoreFile;
} {
  // Generate new keypair
  const keypair = Keypair.generate();

  // Encode secret key as base58
  const secretKeyBase58 = bs58.encode(keypair.secretKey);

  // Encrypt the secret key
  const encryptedPrivateKey = encrypt(secretKeyBase58, password);

  // Build keystore file
  const keystore: KeystoreFile = {
    version: 1,
    publicKey: keypair.publicKey.toBase58(),
    encryptedPrivateKey,
    createdAt: new Date().toISOString(),
  };

  logger.info({ publicKey: keystore.publicKey }, 'Created new keystore');

  return { keypair, keystore };
}

/**
 * Save a keystore to disk with secure file permissions.
 *
 * @param keystore - The keystore data to save
 * @param filepath - Path where the keystore file will be written
 *
 * @example
 * saveKeystore(keystore, 'wallet.keystore.json');
 */
export function saveKeystore(keystore: KeystoreFile, filepath: string): void {
  // Write JSON with pretty formatting
  const content = JSON.stringify(keystore, null, 2);
  fs.writeFileSync(filepath, content, { encoding: 'utf8' });

  // Set file permissions to 0600 (owner read/write only) on Unix systems
  // On Windows this is a no-op but doesn't throw
  try {
    fs.chmodSync(filepath, 0o600);
  } catch {
    // Ignore permission errors on platforms that don't support chmod
  }

  logger.info({ filepath }, 'Saved keystore');
}

/**
 * Load a keypair from an encrypted keystore file.
 *
 * @param filepath - Path to the keystore file
 * @param password - The password to decrypt the private key
 * @returns The decrypted Keypair ready for signing
 * @throws Error if file doesn't exist, version mismatch, or wrong password
 *
 * @example
 * const keypair = loadKeystore('wallet.keystore.json', 'my-secure-password');
 * // keypair can now be used for signing transactions
 */
export function loadKeystore(filepath: string, password: string): Keypair {
  // Read and parse keystore file
  let content: string;
  try {
    content = fs.readFileSync(filepath, 'utf8');
  } catch {
    throw new Error('Keystore file not found or unreadable');
  }

  let keystore: KeystoreFile;
  try {
    keystore = JSON.parse(content) as KeystoreFile;
  } catch {
    throw new Error('Keystore file is corrupted');
  }

  // Validate version
  if (keystore.version !== 1) {
    throw new Error('Unsupported keystore version');
  }

  // Decrypt the private key
  let secretKeyBase58: string;
  try {
    secretKeyBase58 = decrypt(keystore.encryptedPrivateKey, password);
  } catch {
    // Don't leak details about what went wrong
    throw new Error('Failed to decrypt keystore: invalid password or corrupted data');
  }

  // Reconstruct keypair from secret key
  const secretKey = bs58.decode(secretKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);

  // Verify public key matches stored value
  const recoveredPublicKey = keypair.publicKey.toBase58();
  if (recoveredPublicKey !== keystore.publicKey) {
    throw new Error('Keystore integrity check failed');
  }

  logger.info({ publicKey: keystore.publicKey }, 'Loaded keystore');

  return keypair;
}
