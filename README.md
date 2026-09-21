# LONG Vault

$LONG dashboard, admin settings and simulation keeper, with real mainnet reads and unsigned protocol previews. **No real transaction is signed or broadcast by this build.** Entering a CA updates the website; an address alone cannot authorize spending.

## Deploy to Railway

The repository now includes railway.json. The previous start command ran a local Cloudflare development server at 127.0.0.1:8787; Railway could not reach it. The new Node server listens on 0.0.0.0 and Railway's PORT.

1. Connect this repository, branch main, root directory /.
2. Use build command npm run build:railway and start command npm run start:railway (railway.json sets both). Existing overrides of npm run build / npm start also use the Node deployment now. Remove any custom command that invokes Wrangler.
3. Set PUBLIC_ORIGIN=https://longcoin.lol (or your actual public origin, without a path).
4. Set ADMIN_PASSWORD to a unique random password of at least 20 characters in Railway Variables. Never commit it or paste it into chat. Without it, the public page still loads and Admin stays locked.
5. Attach a Railway volume at /data and set DATA_DIR=/data. Use one replica. SQLite settings and activity persist on that volume. Without a volume, container replacement loses local data; DATA_DIR alone does not create a volume.
6. Keep TRADING_MODE=mock. Mainnet monitoring is a separate Admin setting; it does not enable trading.
7. Health check: /health. Let Railway provide PORT; remove any old domain target port of 8787, or match the target to the configured PORT.
8. Redeploy. Open /admin, sign in, enter the token contract and public addresses, then Save configuration. Visitors see the saved CA, copy action and Solscan link within five seconds.

The Node deployment does not use Cloudflare D1 or trust ChatGPT identity headers. It uses password-authenticated, expiring, HttpOnly/SameSite sessions, HTTPS Secure cookies, same-origin write checks, bounded requests and login rate limiting. Restarting the server clears sessions but preserves database state on the volume. The browser never receives ADMIN_PASSWORD, RPC credentials, API keys or signing keys.

## Run locally

Use Node 22.13 or later, with npm. Run npm ci, npm run build, then npm start. The production Node server defaults to port 3000. Set ADMIN_PASSWORD and PUBLIC_ORIGIN=http://localhost:3000 in your shell or an ignored .env.local file; use node --env-file=.env.local scripts/server.mjs when loading that file. A public dashboard is available without logging in.

For the existing loopback-only preview at http://127.0.0.1:5173:

~~~sh
node scripts/portable-build.mjs
node scripts/portable-server.mjs
~~~

This preview has a local simulated sign-in and a separate SQLite database; **never deploy the portable-server script**. Its sign-in is not production authentication.

Cloudflare/Sites remains a separate target: npm run build:sites and npm run start:sites. Apply both SQL migrations to its D1 binding. Set VAULT_OWNER_ID to the trusted admin user ID displayed in Admin; the public endpoint reads that vault and only that account can modify it. Sites identity headers must only be accepted behind the trusted Sites dispatcher.

## Mainnet monitoring and previews

Save the CA and vault in Admin, configure SOLANA_RPC_URL in server secrets, and choose Mainnet monitoring under Dashboard data. Save again. The public page then shows chain data instead of simulated balances. Missing or failed reads are displayed as unavailable, never zero or mock fallback.

- The official Pump SDK 2.0.0 discovers the on-chain creator from the CA and reads SOL creator fees across Pump and PumpSwap. The optional creator address verifies the discovered identity. Fees are pooled by creator wallet, so they can include other coins belonging to that creator.
- This adapter only supports SOL-paired single-creator coins. Shared fee distributions, holder rewards and other quote currencies fail closed. A different creator and vault wallet requires an authorized routing transfer; merely entering the vault address does not redirect fees.
- Solana mainnet genesis is checked before RPC balances are used. The vault's SOL and USDC balances are read on-chain.
- Jupiter v2 supplies real BTC/ETH/SOL prices, positions, ROE and estimated liquidation prices. Its micro-USD amounts are validated before conversion. JUPITER_API_URL defaults to https://perps-api.jup.ag/v2 and rejects other hosts. JUPITER_API_KEY is optional where the provider allows unauthenticated reads.
- Admin connection checks report missing dependencies. Previews construct an unsigned Pump claim or Jupiter long and call RPC simulation. They require valid addresses, a funded wallet and supported protocol responses. Orders respect the configured collateral threshold, allocation, leverage, notional and slippage bounds.
- Preview TP/SL trigger prices approximate the configured ROE before fees. Previews do not decode and authorize every instruction for signing. They are not proof of executable fills. No signed transaction bytes or signing service exist in this build.
- Connection reads retry transient failures with bounded timeouts. Checks share an in-flight request and a short cache. RPC errors are sanitized; credentials are not returned to the browser.

Mainnet monitoring disables all simulated economic actions. Historical simulation events remain clearly labeled in Admin. It does **not** automatically close real positions, claim real fees or buy back tokens. Manage existing real positions in Jupiter until the execution integration is complete.

The pinned Pump package's ESM dependency currently has an Anchor CommonJS export incompatibility. The Node adapter imports the pinned CJS distribution. The Sites build resolves Anchor's browser-compatible RPC implementation. Keep these compatibility choices covered when upgrading dependencies.

## Simulation behavior

- Default leverage is 5x; application range 1–100x. This is an app limit, not a promise of protocol availability.
- Allocations total 100%. The per-market position cap is notional USD, not collateral.
- TP/SL use collateral ROE; +100% is 2x equity before costs. Existing simulated positions keep their opening risk settings.
- The mock liquidation formula excludes funding, real collateral behavior, oracle effects and price impact. Do not use it to trade.
- Buybacks reserve only a share of positive net cycle PnL after all positions close; market losses offset gains and principal is excluded.
- Pause blocks claims, opens and buybacks, while protective simulated closes can still run. Mainnet monitoring has no such automated protection.
- Cooldown starts at the last close. Mock rewards accrue only when the keeper runs.

## Keeper and durability

The keeper is for simulation only. Set the same random KEEPER_SECRET of at least 32 characters on the Node server and keeper process. Set KEEPER_BASE_URL to the website origin and run node --env-file=.env.local scripts/keeper.mjs on an always-on worker. The browser does not run the keeper. On Railway, VAULT_OWNER_ID defaults to long_vault_admin; changing it selects a different stored vault.

Commands carry persistent idempotency receipts and commit through an atomic compare-and-swap with a per-attempt fence. Duplicate runs cannot double-open simulated positions. Activity and receipts survive restarts. The UI shows the latest 200 events. These guarantees apply to the database simulation; they do not make blockchain writes atomic.

## What remains before real execution

Automated signing, transaction instruction authorization, an on-chain authority/policy, a durable transaction outbox, unknown-result reconciliation, reward conversion, actual realized-profit accounting and buyback execution are **not implemented**. TRADING_MODE=live remains blocked. A signed transaction must be journaled before broadcast and reconciled on timeout before any economic action is retried. Protocol-specific tests must cover partial execution, stale quotes, expiry, interrupted confirmations and competing keepers. No token mint or on-chain vault is created here.

## Verification

~~~sh
npm run build
npm test
npx tsc --noEmit
~~~

Tests cover the simulation engine, concurrent keeper requests and durable receipts; strict public key and Jupiter response validation; mainnet-mode isolation; HTTP authentication, cross-origin protection, public CA updates, restart persistence and missing-secret startup. Mainnet price reads have been verified against Jupiter's real service. No live signed transactions, funded-wallet claim previews or long previews have been confirmed for this project because its addresses, RPC and signing service are not configured.

## Sources and assets

- [Official Pump SDK and fee instructions](https://github.com/pump-fun/pump-public-docs)
- [Official Jupiter perpetuals CLI/API implementation](https://github.com/jup-ag/cli/blob/main/src/clients/PerpsClient.ts)
- [Jupiter perpetuals command documentation](https://github.com/jup-ag/cli/blob/main/docs/perps.md)
- [Railway port binding](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond)
- [Railway health checks](https://docs.railway.com/deployments/healthchecks)
- BTC/ETH/SOL SVG paths: cryptocurrency-icons, license in public/coins/LICENSE.md. Solana presentation uses its black and gradient colors. PFP is the supplied original image; accent #2DD409. The reference dashboard inspired the layout without a pixel-for-pixel copy.
