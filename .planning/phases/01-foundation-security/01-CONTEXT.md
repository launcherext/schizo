# Phase 1: Foundation & Security - Context

**Gathered:** 2026-01-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Secure wallet management, persistent state storage, and rate-limited Helius API client. This phase delivers the infrastructure layer — no analysis logic, no trading, no personality. Just secure foundations.

</domain>

<decisions>
## Implementation Decisions

### Secret Storage
- Private key encrypted at rest using a master password or derived key
- Never stored in plaintext, env vars, or logs
- Decrypt only in memory when signing transactions
- Consider using system keyring (Windows Credential Manager) if available, fallback to encrypted file

### State Persistence
- SQLite for structured data (trades, analysis cache, P&L history)
- Single local database file — portable and easy to backup
- Schema supports recovery of all agent state after restart
- JSON files acceptable for config, but not for trade history

### API Client Behavior
- Rate limiting: Respect Helius tier limits (track calls per second/minute)
- Caching: Cache getTransactionsForAddress results with TTL
- Retry: Exponential backoff on 429/5xx, max 3 retries
- Circuit breaker: Stop calling after repeated failures, wait before retry

### Error Handling
- Fail fast on critical errors (can't decrypt wallet, can't connect to RPC)
- Retry on transient errors (network timeout, rate limit)
- Log errors with context but never log secrets or full private keys
- Structured logging (JSON) for easy parsing

### Claude's Discretion
- Specific encryption algorithm (AES-256-GCM recommended)
- SQLite schema design details
- Exact cache TTL values
- Logging library choice

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for Solana/Node.js ecosystem.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation-security*
*Context gathered: 2026-01-20*
