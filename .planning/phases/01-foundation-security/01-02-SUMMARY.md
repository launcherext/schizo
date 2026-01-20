---
phase: 01-foundation-security
plan: 02
subsystem: security
tags: [encryption, keystore, aes-256-gcm, pbkdf2, solana, wallet]

dependency-graph:
  requires: ["01-01"]
  provides: ["encrypted-keystore", "wallet-management"]
  affects: ["01-05", "02-01"]

tech-stack:
  added: []
  patterns: ["AES-256-GCM encryption", "PBKDF2 key derivation", "Base58 encoding"]

key-files:
  created:
    - src/keystore/crypto.ts
    - src/keystore/keystore.ts
    - src/keystore/index.ts
  modified: []

decisions:
  - id: "PBKDF2_ITERATIONS"
    decision: "100,000 iterations"
    rationale: "Balance between security and startup time"
  - id: "SALT_LENGTH"
    decision: "64 bytes"
    rationale: "Extra entropy for key derivation"
  - id: "KEYSTORE_VERSION"
    decision: "Version 1 format"
    rationale: "Future compatibility with format changes"

metrics:
  duration: "6 min"
  completed: "2026-01-20"
---

# Phase 01 Plan 02: Encrypted Keystore Summary

**One-liner:** AES-256-GCM encrypted keystore for Solana wallet private keys using PBKDF2 key derivation with secure file storage.

## What Was Built

### 1. AES-256-GCM Encryption Module (`src/keystore/crypto.ts`)

- `encrypt(plaintext, password)` - Encrypts data with password-derived key
- `decrypt(data, password)` - Decrypts with auth tag verification
- `EncryptedData` interface - JSON-serializable encrypted payload

**Security features:**
- 100,000 PBKDF2 iterations with SHA-512
- 64-byte random salt per encryption
- 16-byte random IV
- GCM authentication tag for integrity
- Generic error messages that don't leak secrets

### 2. Keystore Operations (`src/keystore/keystore.ts`)

- `createKeystore(password)` - Generates new encrypted keypair
- `saveKeystore(keystore, filepath)` - Writes with 0600 permissions
- `loadKeystore(filepath, password)` - Decrypts and verifies keypair

**Keystore file format (v1):**
```json
{
  "version": 1,
  "publicKey": "base58-public-key",
  "encryptedPrivateKey": {
    "salt": "base64...",
    "iv": "base64...",
    "authTag": "base64...",
    "encrypted": "base64..."
  },
  "createdAt": "2026-01-20T17:00:00.000Z"
}
```

### 3. Barrel Export (`src/keystore/index.ts`)

Clean public API exporting all keystore functionality.

## Key Links Verified

| From | To | Via | Pattern |
|------|-----|-----|---------|
| keystore.ts | crypto.ts | encrypt/decrypt calls | `import { encrypt, decrypt } from './crypto.js'` |
| keystore.ts | @solana/web3.js | Keypair operations | `Keypair.generate()`, `Keypair.fromSecretKey()` |

## Tests Implemented

1. **Encryption roundtrip** - encrypt/decrypt returns original
2. **Wrong password detection** - throws on invalid password
3. **Keystore create/save/load** - full lifecycle
4. **No plaintext in file** - keystore contains only encrypted data
5. **Public key verification** - loaded keypair matches stored key
6. **Secret key verification** - loaded keypair can sign

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Bottleneck 'retry' event type error**
- **Found during:** Build verification
- **Issue:** `src/api/rate-limiter.ts` used invalid 'retry' event that doesn't exist in Bottleneck types
- **Fix:** Removed the invalid event handler (logging already handled in 'failed' handler)
- **Files modified:** src/api/rate-limiter.ts
- **Commit:** Part of task commits

**2. [Rule 3 - Blocking] Installed missing @types/opossum**
- **Found during:** Build verification
- **Issue:** helius.ts import of opossum had no type declarations
- **Fix:** `npm install -D @types/opossum`
- **Files modified:** package.json, package-lock.json

## Commits

| Hash | Type | Description |
|------|------|-------------|
| 85963c6 | feat | implement AES-256-GCM encryption module |
| e18384a | feat | implement keystore save/load operations |

## Success Criteria Verification

| Criteria | Status |
|----------|--------|
| Encryption/decryption roundtrip works | PASSED |
| Wrong password is detected and rejected | PASSED |
| Keystore file contains only encrypted data | PASSED |
| Log output never shows private key or password | PASSED |
| Keypair can be loaded and used for signing | PASSED |

## Next Phase Readiness

**Ready for:** Plan 01-05 (Integration testing with encrypted wallet)

**Dependencies satisfied:**
- Keystore module provides secure wallet storage
- Logger from 01-01 provides secret redaction
- All exports available via `./keystore/index.js`

**No blockers identified.**
