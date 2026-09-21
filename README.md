# LONG

A green/black public dashboard and password-protected Admin for a single developer wallet. Mainnet balances and positions are real reads; unavailable data stays unavailable. No simulated fee claims are shown.

## Railway setup

Use Node 22.13+, one replica, `npm run build:railway` and `npm run start:railway`. `railway.json` supplies these commands, `/health`, and the server binds `0.0.0.0:$PORT`.

Required server variables:

- `ADMIN_PASSWORD`: 20–256 characters.
- `PUBLIC_ORIGIN`: your HTTPS origin, e.g. `https://longcoin.lol`.
- `DATA_DIR=/data`: attach a Railway persistent volume at `/data`. A variable alone does not create a volume.
- `SOLANA_RPC_URL`: an HTTPS mainnet provider supporting account scans, simulation, transaction submission, and historical signature lookup.
- `LIVE_TRADING_ENABLED=true`: explicitly permits real transactions. Default is disabled. Admin still starts paused.
- `JUPITER_API_KEY`: optional. Keyless buyback requests are spaced at least 2.1 seconds apart; free-key requests at least 1.1 seconds apart. Rate-limit and server errors receive bounded retries. Server destinations are pinned to `https://perps-api.jup.ag/v2` and `https://api.jup.ag/swap/v1`.
- Optional `WALLET_ENCRYPTION_KEY`: a base64-encoded random 32-byte encryption key stored separately in Railway Variables.

Open `/admin` and sign in. The main setup has three inputs: token CA, developer private key, and cycle interval. Private keys accept Solana base58 or a JSON array of 64 bytes; seed phrases are not accepted. Saving derives the public address and uses it for all wallet roles, updates the public CA, and pauses cycles. A blank private-key field keeps the current wallet. After reviewing the displayed strategy and funding the wallet, **Start cycles** permits real claims and orders.

The collapsible **Strategy** section edits leverage, BTC/ETH/SOL allocation, minimum cycle capital, TP/SL ROE, maximum position notional, slippage and buyback percentage. Allocations must total 100%. Changes are validated on the server and pause cycles; an unsettled cycle must finish before changes can be saved.

The on-chain token creator must be the developer wallet. Entering an address cannot change Pump fee authority. Shared creator distributions, holder rewards, and non-SOL quote currencies are unsupported and stop execution.

## Wallet storage

The private key is submitted only to the authenticated, same-origin setup endpoint over HTTPS (or local loopback for development). It is encrypted with AES-256-GCM, with its public address authenticated as associated data. Neither plaintext, ciphertext, nor signed transaction bytes are returned by the API. The browser field is cleared after a successful save. No localStorage storage is used.

Prefer `WALLET_ENCRYPTION_KEY` in Railway Variables. If omitted, the server creates `DATA_DIR/.wallet-encryption-key` with owner-only permissions. Back it up separately from SQLite; losing it makes the stored wallet unreadable. Keeping key and ciphertext on the same volume protects against database-only disclosure, not compromise of the host or complete volume. A server compromise can access a hot wallet. Do not use public environment variable prefixes. `DEV_WALLET_PRIVATE_KEY` remains supported as a server-secret fallback when no wallet is saved through Admin. An encrypted saved wallet takes precedence.

## Cycle behavior

The production server runs a durable cycle worker every ten seconds; no browser or separate keeper process is required. One cycle at a time:

1. Verify mainnet, the configured developer wallet, and the token's on-chain fee creator. Wait for existing positions to close.
2. When available capital meets the saved threshold, claim pending creator fees with locally constructed instructions from the pinned Pump SDK. Fees are pooled across all coins of that creator, not token-attributed earnings.
3. Budget the entire cycle once. Prefer USDC when it meets the threshold; otherwise use SOL directly as Jupiter input, preserving a 0.15 SOL cycle reserve. Jupiter performs any required collateral conversion. SOL and USDC balances are not combined through a standalone swap.
4. Open each nonzero BTC/ETH/SOL allocation sequentially. Require a verified fill and on-chain full-position TP and SL before continuing. New positions need at least $10 collateral each. Defaults: 5x, 40/30/30 allocation, $100 capital threshold, $1,000 notional cap per market, +100% / -25% ROE triggers, 50 bps slippage. Existing saved settings are preserved.
5. After each close, scan finalized payout receipts from the recorded Jupiter request escrow to the developer USDC account. Once receipts recover the whole cycle principal and a conservative SOL fee/rent reserve, swap the saved buyback percentage of the surplus (default 75%) from USDC into the saved token CA. The new tokens stay in the developer wallet. This is a market buy, not a burn or a guaranteed chart price increase.
6. Wait until all positions, payout receipts and buybacks settle, then wait the selected cycle interval before starting again. Jupiter keepers execute on-chain price triggers; they are approximate ROE before costs, not guaranteed net-return targets.

Cycles may use existing wallet funds as well as newly claimed rewards. A failed leg pauses the cycle; other legs remain live with their own TP/SL. Pausing stops new opens/claims and fresh automatic broadcasts, not existing on-chain orders. Manual closes are permitted while paused. Manual controls and actual transaction history are collapsed in Admin. The old simulation keeper is not used for live execution.

## Buyback settlement

Closes and swaps are separate transactions. The worker checks every ten seconds, then waits for Solana finality and available RPC receipts. A small winning leg may not buy immediately: all cycle collateral, including still-open legs, is reserved before any payout is treated as spendable profit. The fee/rent reserve is `(number of legs × 0.08 + 0.01) SOL`, valued at the cycle's starting SOL price; this is conservative reserved capital, not an exact realized-fee report. Surplus below 1 USDC stays in the wallet for the next cycle.

Buybacks use Jupiter ExactIn routes, saved slippage, a 3% price-impact cap, and a locally constructed destination account. Quotes and instructions must agree on the owner, amount, output mint and destination. Simulation must debit exactly the reserved USDC and credit at least the minimum output, without changing token authority. Ordinary SPL mints and metadata-only Token-2022 mints are supported; transfer hooks, transfer taxes and permanent delegates are rejected. Unsupported route instruction versions stop before signing.

Receipt identities and exact signed swaps persist in SQLite. A failed preparation or finalized failed swap pauses the cycle; **Start cycles** retries using a fresh order only after failure is definitive. An uncertain submission retains its original signature and blocks replacement. Pause also stops automatic buybacks until resumed. Settings changes and manual opens are blocked while a tracked cycle is unsettled. External/manual Jupiter closes that do not use a recorded request, liquidation with no USDC payout, unavailable historical transactions, or unsupported payout layouts remain pending for reconciliation; they are never treated as verified profit or silently skipped. Keep an archival RPC and avoid modifying managed positions outside this app.

## Transaction validation and recovery

- The signer is server-only and must match the saved developer address.
- Jupiter unsigned transactions are decoded before signing: deterministic owner/position/request addresses, pool, custody, mint, token destinations, long side, collateral, size, slippage, swap minimum outputs, full-position TP/SL, and required signer are checked.
- Unknown instructions, additional signers, standalone transfers, token approvals, referral destinations, incompatible layouts, and excessive priority fees are rejected. SOL wrapping is permitted only for the exact authorized collateral into the developer's own associated account.
- Transactions are simulated on-chain. Network fees and SOL spending are capped. Liquidity or protocol errors stop the order.
- SQLite reserves a single active order. Exact signed bytes and signature are committed before broadcasting. Retries resend identical bytes; no retry builds a replacement financial order.
- Submitted, finalized-request, filled, settled, failed, and unknown outcomes remain distinct. A finalized request is not a fill. Position and trigger accounts are checked on-chain to establish the live position and protection.
- Unknown signatures after expiry pause execution and remain blocking. Restore an archival RPC and reconcile the original signature; never delete the outbox to force a retry. If a pending request or old TP/SL remains, inspect/cancel it in Jupiter before a fresh open. Unsupported protocol changes stop signing until the validator is updated.
- Signed bytes are private replayable authorizations until expiry and stay in the private database. Protect database backups. Never run multiple independent databases/replicas for the same wallet.

This is a server-held hot-wallet design, not a deployed on-chain vault policy. Automatic buybacks are implemented for newly recorded cycles. They do not infer profit from pre-existing positions, wallet deposits, or API PnL estimates. No new token or smart contract is deployed by this app.

## Run and verify

```sh
npm ci
npm run build:railway
npm test
npx tsc --noEmit
node --env-file=.env.local scripts/server.mjs
```

The production server defaults to port 3000. Set `PUBLIC_ORIGIN=http://127.0.0.1:3000`, a test admin password and a private data directory for local development. The separate portable preview on `127.0.0.1:5173` displays the UI but cannot accept private keys or trade. Never deploy `scripts/portable-server.mjs`.

Tests cover authentication, same-origin writes, encrypted key persistence/tampering, secret redaction, unified wallet setup, instruction tampering, fee limits, duplicate order locks, restart/ambiguous-send recovery, immutable cycle allocations, and creator mismatch. Chain adapters in execution tests are mocked; these tests do not establish a funded mainnet fill. The real unsigned quote check against the configured public wallet returned `insufficient_funds`. No real transaction has been signed or sent during development, and funded claim/open/close/buyback acceptance remains unverified. Buyback tests cover escrow receipts, profit reservation, instruction tampering, simulated token delivery, automatic close-to-buyback scheduling, and restart recovery.

## Protocol references and assets

- [Official Jupiter API client](https://github.com/jup-ag/cli/blob/main/src/clients/PerpsClient.ts)
- [Jupiter position-request lifecycle and linked Anchor IDL](https://developers.jup.ag/docs/perps/position-request-account)
- [IDL and deterministic address examples linked by Jupiter](https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing)
- [Jupiter swap API](https://developers.jup.ag/docs/api-reference/swap/v1/swap-instructions)
- [Official Pump SDK](https://github.com/pump-fun/pump-public-docs)

PFP is the supplied original image; accent is #2DD409. BTC/ETH icon license is in `public/coins/LICENSE.md`; SOL uses the green/purple three-bar mark.
