import crypto from 'node:crypto';

/**
 * Encrypted data structure for AES-256-GCM encryption.
 * All binary fields are base64-encoded strings for JSON serialization.
 */
export interface EncryptedData {
  /** Random salt for key derivation (64 bytes, base64) */
  salt: string;
  /** Initialization vector (16 bytes, base64) */
  iv: string;
  /** Authentication tag for integrity verification (16 bytes, base64) */
  authTag: string;
  /** Encrypted ciphertext (base64) */
  encrypted: string;
}

/** PBKDF2 iteration count - higher = more secure but slower */
const PBKDF2_ITERATIONS = 100000;

/** AES-256 key length in bytes */
const KEY_LENGTH = 32;

/** Salt length in bytes */
const SALT_LENGTH = 64;

/** Initialization vector length in bytes */
const IV_LENGTH = 16;

/**
 * Encrypt plaintext using AES-256-GCM with PBKDF2 key derivation.
 *
 * @param plaintext - The string to encrypt
 * @param password - The password for key derivation
 * @returns EncryptedData with all components base64-encoded
 *
 * @example
 * const encrypted = encrypt('my-secret-key', 'strong-password');
 * // encrypted.salt, encrypted.iv, encrypted.authTag, encrypted.encrypted
 */
export function encrypt(plaintext: string, password: string): EncryptedData {
  // Generate random salt and IV
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  // Derive key from password using PBKDF2 with SHA-512
  const key = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha512'
  );

  // Create cipher and encrypt
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    encrypted: encrypted.toString('base64')
  };
}

/**
 * Decrypt data encrypted with AES-256-GCM.
 *
 * @param data - The EncryptedData object from encrypt()
 * @param password - The password used for encryption
 * @returns The original plaintext string
 * @throws Error if password is wrong or data is corrupted (generic message)
 *
 * @example
 * const plaintext = decrypt(encrypted, 'strong-password');
 * // Returns original string
 */
export function decrypt(data: EncryptedData, password: string): string {
  // Decode all base64 components
  const salt = Buffer.from(data.salt, 'base64');
  const iv = Buffer.from(data.iv, 'base64');
  const authTag = Buffer.from(data.authTag, 'base64');
  const encrypted = Buffer.from(data.encrypted, 'base64');

  // Derive the same key
  const key = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha512'
  );

  // Create decipher and decrypt
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  } catch {
    // Don't leak password or key details in error message
    throw new Error('Decryption failed: invalid password or corrupted data');
  }
}
