# Jupiter perpetual interface

`perps-idl.json` was fetched from the deployed Solana mainnet Jupiter perpetual program through Anchor Program.fetchIdl on September 21, 2026. The program address is pinned as PERPS in scripts/perps-policy.mjs. Legacy IDL types were normalized for Anchor 0.31.1 (publicKey/pubkey, defined types, account types and Anchor discriminators); event definitions are omitted because execution validation does not decode events.

The interface is pinned, not fetched dynamically during signing. Unknown layouts fail closed. The API keeper public key is also pinned in scripts/instant-perps.mjs.

The unsigned quote fixture in tests/fixtures contains public chain account data and an API keeper signature, with no developer wallet signature or private key. Its deliberately wider diagnostic conversion bound is not a production default.
