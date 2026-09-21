# TEK Vault

A simulation-first creator-reward automation application. No token is created and no blockchain transactions are sent by this version. The mock engine models dollar-denominated collateral; it is NOT a price-accurate model of Jupiter's asset-collateralized long positions. All prices, rewards, signatures and fills shown in mock mode are simulated.

## Components
- `app/VaultDashboard.tsx`: shared responsive interface. `/` shows the vault; `/admin` contains controls, configuration and activity. No signing keys.
- `app/api/vault/route.ts`: authenticated, same-origin admin API.
- `app/api/keeper/route.ts`: server-to-server keeper endpoint protected by a high-entropy bearer secret.
- `lib/engine.ts`: pure deterministic simulation state machine, integer USD cents, profit ledger, TP/SL, pause and cooldown.
- `lib/store.ts`: D1 state persistence with optimistic concurrency control. A successful compare-and-swap is the commit point. Competing runs reload and retry. All simulated effects commit together, so no double-open or double-spend occurs.
- `lib/live.ts`: fail-closed live adapter boundary and transaction-policy validation. It intentionally cannot sign or submit.
- `scripts/keeper.mjs`: continuously running backend keeper client. Run this separately from the frontend.

## Start locally
Use Node 22.13+ and npm. Install with `npm run install:ci`, then `npm run db:generate` if changing the schema. Copy `.env.example` to `.env.local`; never commit values. Run `npm run build` to generate the local Worker configuration. Apply the generated SQL:
```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_tek_vault.sql
npm run dev
```
Then apply drizzle/0001_durable_receipts.sql using the same command. Visit the printed local address. The starter's loopback-only simulated ChatGPT sign-in uses a local development identity. This auth simulation is excluded from production. Real hosted access is protected by the private Sites dispatcher.

The dashboard requires sign-in for persisted state. Each identity owns an isolated mock vault; a user cannot read or modify another user's vault. Copy the owner ID from Configuration into the keeper's `VAULT_OWNER_ID`. Do not expose the Worker outside the trusted Sites dispatcher: authenticated headers are trustworthy only behind that boundary.

## Configuration semantics
- Default leverage: 5x. The app policy limits new positions to 1–100x. This is an application cap, not a claim about Jupiter's supported leverage.
- Allocations must total 100%; zero allocation disables a market.
- Minimum rewards and position limits are in USD for this simulator. The maximum position size is notional per market, not collateral. Excess capital remains ready to deploy.
- TP and SL are ROE percentages on collateral. +100% ROE means a 2x equity multiple BEFORE trading costs. Existing positions retain their opening leverage, TP and SL.
- Liquidation estimate uses a simple 0.5% maintenance assumption. Funding, fees, asset collateral price changes, price impact and oracle effects are excluded. Never use this estimate for live execution.
- Buyback percentage reserves a fraction of positive NET cycle PnL, after all positions in that cycle close. Losses across markets offset gains. Returned principal never becomes buyback profit. Remaining profit returns to deployable capital.
- Pause stops new claims, opens and buybacks. Price monitoring and protective closes remain active when the keeper runs. Manual close is permitted while paused. Pause is not a close-all command.
- Configuration changes apply to the next cycle. Cooldown starts when the last position closes.
- RPC/API settings reference server-side environment variable names, not credential-bearing URLs. Addresses are configuration only until live adapters are implemented.
- In mock mode, an initial simulated reward balance is provided and mock rewards accrue only on keeper ticks. No blockchain balances are represented.

## Run the keeper
Set `KEEPER_BASE_URL`, `KEEPER_SECRET`, `VAULT_OWNER_ID`, and optionally `KEEPER_INTERVAL_MS` (default 15 seconds). Configure the same `KEEPER_SECRET` as a hosted secret. Run `node --env-file=.env.local scripts/keeper.mjs` on a trusted always-on server.

Sites private access may require an authenticated gateway for machine requests. If the private dispatcher rejects the bearer request, run the keeper behind an approved gateway or invoke it internally; do not make the admin surface public to work around authentication. The app does not claim unattended automation is running until an external keeper is configured. The dashboard's “Run cycle” button invokes exactly the same engine for testing. Leaving the browser open is not required by the backend.

Retries reuse the same idempotency key. The database keeps processed command IDs in a separate durable receipt table; the vault state holds only the latest 200 activity records. Full activity is also persisted separately. Optimistic conflicts are retried with bounded backoff. A failed validation is recorded in activity; transport/storage failures are reported to the caller and must not be presented as successful fills.

## Live integration — deliberately blocked
No environment switch enables live trading in this build. `TRADING_MODE=live` fails closed. Complete and audit adapters before adding live enablement:
1. Verify token mint, creator authority, fee destination and whether rewards are actually claimable. Pump bonding-curve fees, PumpSwap fees and shared fees have distinct instructions. Holder-reward/cashback tokens may not pay the creator.
2. Use the current official Pump SDK/IDL to construct fee claims; verify balances before and after confirmed execution. Convert rewards to required collateral with a validated quote, preserving a SOL gas/rent reserve.
3. Obtain a supported Jupiter perpetual integration and current program IDs/IDL. Spot swap APIs are not perpetual-position APIs. Longs use underlying-asset collateral; use protocol position state/oracles for ROE and liquidation, not the simplified mock formula.
4. Decode ALL proposed transaction instructions server-side. Verify allowed programs, mint, accounts, owner, destination, amount, fees, expiry, slippage, oracle freshness, leverage and notional. Reject extra signers, unexpected writable accounts and unexpected transfers. Simulate before signing. A quote response is untrusted.
5. Use a remote signer or hardware-backed secret manager with an audited vault authority policy. Browser clients must never see key material. A treasury address alone does not enforce a policy.
6. Persist an outbox intent and signed transaction bytes/signature BEFORE broadcast. Use an atomic lock/lease with fencing for each vault; reconcile signature status, position accounts and keeper request accounts before retry. A timeout is UNKNOWN, not FAILED. Never reconstruct and resend a new economic action until absence is proven. Database CAS alone cannot make an external chain operation atomic.
7. Reconcile final balance deltas and actual net fees before buyback. Confirm output mint and treasury receipt. No burn is implemented or requested.
8. Add protocol-specific tests for partial fills, asynchronous Jupiter requests, expiries, network partitions, liquidation, stale prices, multiple keepers and interrupted confirmation.

## Authority model
Recommended production design: separate operator (configuration), keeper (narrow actions), remote signer and treasury/vault authority. An audited on-chain vault/PDA or suitable policy-enforcing authority should cap spend, leverage and destinations independently of the keeper. This repository does not deploy an on-chain program and makes no claim that its off-chain rules secure a hot wallet against compromise.

## Secrets
`KEEPER_SECRET` is a random value of at least 32 characters. Do not put secrets in NEXT_PUBLIC variables, browser storage, URLs, the activity log or Git. Production secrets belong in Sites environment secret settings / your secret manager. Example RPC and API variables are reserved for future live adapters and are not used to send mock requests.

## Verification
Run `node --experimental-strip-types tests/engine.test.ts` for engine safety tests and `npx tsc --noEmit` for type checks. Build with the Sites build helper when using Sites hosting. Mock functionality is not evidence of live protocol compatibility.

## Official references checked 2026-09-21
- Pump public SDK and fee docs: https://github.com/pump-fun/pump-public-docs
- Pump creator collection: https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COLLECT_CREATOR_FEE.md
- Jupiter official developer documentation: https://developers.jup.ag/
- Jupiter support / collateral and liquidation: https://support.jup.ag/

The original screenshot is used only as visual inspiration: dark surfaces, neon green, prominent ticker and three market cards.


## Portable local preview
If Windows prevents Cloudflare workerd from starting, run:
```sh
node scripts/portable-build.mjs
node scripts/portable-server.mjs
```
Open http://127.0.0.1:5173 and use the sign-in button to create a local mock admin session. This fallback does not perform actual ChatGPT authentication. It binds only to loopback, uses a separate persistent SQLite database, and applies both migrations automatically. It is never the production server. Stop it before starting the standard preview on the same port.

Also run `node --experimental-strip-types tests/store.test.ts` for database concurrency, replay protection and ownership tests. The Windows compatibility launcher only tolerates failure of optional network-drive discovery; it does not change security permissions. For a production build in this Windows environment:
```sh
node --import ./scripts/windows-compat.mjs scripts/run-framework.mjs build
```

## Validation performed
- 13 engine / quote-boundary tests passed.
- 4 SQLite-backed persistence tests passed, including 20 concurrent duplicate requests and distinct overlapping keeper requests.
- TypeScript checks passed; production Worker build passed.
- Browser tested: sign-in to the local mock session, claim/open, pause, invalid allocation rejection, manual close while paused, and mobile/desktop overflow.
- WebMCP read tool tested with valid and invalid input.
- Local browser testing used the portable simulation server because workerd child-process pipes are unavailable in this Windows environment.
- No live Pump, Jupiter, signer, or on-chain vault integration has been exercised or enabled.

