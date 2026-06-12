# Syntalic Pricing Intelligence MCP Server

MCP server that gives AI agents access to real-time competitive pricing data across Amazon, Walmart, Costco, and more. Pay-per-query via [x402](https://x402.org) + MPP micropayments with automatic smart routing across Solana, Base, and Tempo.

## Quick Start

### Option A — Let the MCP manage a wallet (recommended for most users)

```bash
npx @syntalic/mcp-server --setup
```

This walks you through:
1. Creating a new multi-chain wallet (or skipping if you prefer BYO — see Option B)
2. Wiring the MCP into Claude Code

After setup:

```bash
# Back up your private keys — mandatory before funding
npx @syntalic/mcp-server --export-keys

# Fund any of the printed addresses with USDC (or USDC.e on Tempo) and you're ready
```

### Option B — Bring your own wallet keys

Skip the generated wallet and supply keys yourself. Recommended if you already use a dedicated agent wallet, you're deploying to CI/CD, or you want to manage keys with an HSM/secret manager.

```bash
# Both env vars are required — setting only one will cause the MCP to exit with an error.
export SYNTALIC_EVM_PRIVATE_KEY=0x<your_evm_private_key>
export SYNTALIC_SOLANA_PRIVATE_KEY=<your_solana_base58_private_key>

# Still run --setup to wire Claude Code (it won't touch the wallet file when both env vars are set)
npx @syntalic/mcp-server --setup
```

When both env vars are set, `~/.syntalic/wallet.json` is ignored entirely.

> ⚠️ Do not use your primary wallet here. Use a dedicated low-balance "agent wallet" — per-query amounts are tiny (0.01–0.02 USDC), so a few dollars buys hundreds of queries.

### Manual MCP config

```json
{
  "mcpServers": {
    "syntalic": {
      "command": "npx",
      "args": ["-y", "@syntalic/mcp-server"]
    }
  }
}
```

## CLI Commands

| Command | Purpose |
|---------|---------|
| `npx @syntalic/mcp-server` | Start the MCP server (default behavior) |
| `... --setup` | Interactive setup: choose wallet path, wire Claude Code |
| `... --export-keys` | Print private keys for backup or importing into Phantom/MetaMask |
| `... --info` | Show wallet addresses, paths, endpoints, and backup status |
| `... --help` | Usage overview |

## Supported Payment Networks

| Protocol | Network | Token | Wallet Type |
|----------|---------|-------|-------------|
| x402 | **Solana** | USDC | Solana (base58) |
| x402 | **Base** | USDC | EVM (`0x...`) |
| MPP | **Tempo** | USDC.e | EVM (`0x...`) |

Base and Tempo share the same EVM address. Solana uses a separate keypair. The client tries chains in that order (Solana first — lowest fees) and falls through when a chain doesn't have enough balance.

## Smart Routing

On every query, the client:

1. Derives your Solana USDC ATA and checks balance via public RPC. Enough → pay on Solana. Not enough → skip.
2. Attempts payment on Base. Falls through on insufficient-balance errors only.
3. Checks USDC.e balance on Tempo, signs an MPP receipt, retries.
4. All chains exhausted → throws a clear `PaymentError` listing what happened per chain.

Balance pre-checks are **optimizations**. If an RPC is rate-limited or down, the client attempts payment anyway — requests never hang on RPC health.

## Tools

### Shopper ($0.01/query)

| Tool | Description |
|------|-------------|
| `best_price` | Find the cheapest price for a product across retailers |
| `price_history` | Price trends over time |
| `deal_finder` | Current deals in a category |
| `price_drop_alert` | Recent price drops |

### Marketing ($0.01/query)

| Tool | Description |
|------|-------------|
| `competitive_landscape` | Competitive pricing overview for a category |
| `brand_tracker` | Track a brand's pricing and positioning |
| `promo_intelligence` | Promotional activity intelligence |
| `share_of_shelf` | Brand share of shelf analysis |
| `price_positioning` | Brand price positioning vs competitors |

### Analyst ($0.02/query)

| Tool | Description |
|------|-------------|
| `inflation_tracker` | Category price inflation trends |
| `price_dispersion` | Price variance across retailers |
| `retailer_index` | Pricing index for a retailer |
| `category_summary` | Comprehensive category pricing summary |

### Utility

| Tool | Description |
|------|-------------|
| `wallet_info` | Show your wallet addresses and funding instructions |

## Parameters

All tools accept optional parameters:

| Parameter | Description |
|-----------|-------------|
| `country` | `us` or `ca` (defaults to `us`) |
| `retailer` | Filter to a specific retailer (e.g. `amazon`, `walmart`, `costco`) |
| `days` | Number of days to look back (where applicable) |

## Configuration

All env vars are optional — a wallet is auto-generated on first run.

| Environment Variable | Description |
|---------------------|-------------|
| `SYNTALIC_EVM_PRIVATE_KEY` | Override the EVM key (Base + Tempo) from the wallet file |
| `SYNTALIC_SOLANA_PRIVATE_KEY` | Override the Solana key from the wallet file |
| `SYNTALIC_API_KEY` | Optional API key (payment is the primary auth) |
| `SYNTALIC_API_BASE` | API base URL (default `https://api.syntalic.com`, HTTPS enforced) |
| `SYNTALIC_SOLANA_RPC_URL` | Custom Solana RPC for balance checks (default `https://api.mainnet-beta.solana.com`, HTTPS enforced) |
| `SYNTALIC_TEMPO_RPC_URL` | Custom Tempo RPC for balance checks (default `https://rpc.tempo.xyz`, HTTPS enforced) |

If both `SYNTALIC_EVM_PRIVATE_KEY` and `SYNTALIC_SOLANA_PRIVATE_KEY` are set, `~/.syntalic/wallet.json` is untouched.

### Upgrading from ≤ 0.5.x

Versions before 0.6.0 used the package's pre-rebrand naming. Both changes are handled automatically:

- **Wallet file** — `~/.crush/wallet.json` is moved to `~/.syntalic/wallet.json` on first run (same keys, same funds).
- **Env vars** — the old `CRUSH_*` names still work as deprecated fallbacks; the `SYNTALIC_*` name wins when both are set.

## Security

- Private keys are **never** exposed through MCP tools. Export only via the `--export-keys` CLI command, which prints to stderr in your own terminal.
- Wallet file uses mode `0o600` and refuses to follow symlinks.
- RPC URL overrides must be HTTPS (except `localhost`/`127.0.0.1`).
- Balance caps prevent a hostile RPC from spoofing an implausible balance to keep you on a chain you can't pay on.
- Error messages are sanitized to strip anything resembling a private key before being surfaced.

## How It Works

1. You call an MCP tool (e.g. `best_price(q: "wireless earbuds")`).
2. The server makes an HTTP request to the Syntalic Pricing API.
3. The API returns `402 Payment Required` with requirements for Solana, Base, and Tempo.
4. The client runs balance pre-checks, signs a payment on the first eligible chain, and retries.
5. You get the pricing data back.

All payment handling is automatic and transparent via the [x402](https://x402.org) and MPP protocols.

## Direct API Access

Skip the MCP and hit the API directly:

```bash
curl https://api.syntalic.com/openapi.json
curl https://api.syntalic.com/v1/shopper/best-price?q=wireless+earbuds  # returns 402
```

Payments accepted:
- **x402** — USDC on Solana or Base
- **MPP** — USDC.e on Tempo

## License

MIT
