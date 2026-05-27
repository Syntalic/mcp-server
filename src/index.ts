#!/usr/bin/env node

// CLI flags — each has one responsibility so accidental runs can't leak keys.
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  const { printHelp } = await import("./setup.js");
  printHelp();
  process.exit(0);
}

if (process.argv.includes("--setup")) {
  const { runSetup } = await import("./setup.js");
  await runSetup();
  process.exit(0);
}

if (process.argv.includes("--export-keys")) {
  const { runExportKeys } = await import("./setup.js");
  await runExportKeys();
  process.exit(0);
}

if (process.argv.includes("--info")) {
  const { runInfo } = await import("./setup.js");
  await runInfo();
  process.exit(0);
}

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { loadOrCreateWallet } from "./lib/wallet.js";

const DEFAULT_API_BASE = "https://api.syntalic.com";
const rawApiBase = process.env.CRUSH_API_BASE ?? DEFAULT_API_BASE;

// CRUSH_API_BASE controls where we sign and send USDC payments. Enforce HTTPS
// to block plaintext MITM, and warn loudly on any non-default origin.
let parsedApiBase: URL;
try {
  parsedApiBase = new URL(rawApiBase);
} catch {
  console.error(`CRUSH_API_BASE is not a valid URL: ${rawApiBase}`);
  process.exit(1);
}
if (parsedApiBase.protocol !== "https:") {
  console.error(
    `CRUSH_API_BASE must use https:// (got ${parsedApiBase.protocol}). ` +
    `Refusing to sign USDC payments over plaintext.`,
  );
  process.exit(1);
}
if (rawApiBase !== DEFAULT_API_BASE) {
  console.error(
    `⚠️  CRUSH_API_BASE override: ${rawApiBase}\n` +
    `   This endpoint will receive signed USDC payments. Verify it is trusted.`,
  );
}
const apiBase = rawApiBase;
const apiKey = process.env.CRUSH_API_KEY;

// Env vars are supported as overrides for advanced users (CI, shared secrets,
// read-only home dirs). If both are provided, we skip the wallet file entirely.
const envEvmKey = process.env.CRUSH_EVM_PRIVATE_KEY;
const envSolanaKey = process.env.CRUSH_SOLANA_PRIVATE_KEY;

// Either both env vars or neither — mixing env for one chain and the wallet
// file for the other silently pulls from two unrelated keypairs, which confuses
// "which wallet am I funding?" and is almost always a misconfiguration.
if (Boolean(envEvmKey) !== Boolean(envSolanaKey)) {
  console.error(
    "Both CRUSH_EVM_PRIVATE_KEY and CRUSH_SOLANA_PRIVATE_KEY must be set to " +
      "use env-var keys. Currently set: " +
      (envEvmKey ? "CRUSH_EVM_PRIVATE_KEY" : "CRUSH_SOLANA_PRIVATE_KEY") +
      ". Unset it to use the wallet file instead, or add the missing one.",
  );
  process.exit(1);
}

let evmPrivateKey: string;
let solanaPrivateKey: string;
// Defaults to false so a forgotten assignment below produces the loudest
// possible behavior (the banner + the tool warning keep showing). The env-var
// path sets it to true explicitly because there's no wallet file to back up.
let backupAcknowledged = false;

if (envEvmKey && envSolanaKey) {
  evmPrivateKey = envEvmKey;
  solanaPrivateKey = envSolanaKey;
  backupAcknowledged = true;
} else {
  const { wallet, isNew } = await loadOrCreateWallet();
  evmPrivateKey = envEvmKey ?? wallet.evmPrivateKey;
  solanaPrivateKey = envSolanaKey ?? wallet.solanaPrivateKey;
  backupAcknowledged = Boolean(wallet.backupAcknowledgedAt);

  if (isNew) {
    console.error([
      "",
      "  New multi-chain wallet generated for Syntalic Pricing Intelligence API",
      "",
      "  Base / Tempo (EVM): " + wallet.evmAddress,
      "  Solana:             " + wallet.solanaAddress,
      "",
      "  Fund any chain — the client auto-picks the one with balance per query.",
      "  Saved to: ~/.crush/wallet.json",
      "",
      "  Run `npx @crush-rewards/mcp-server --export-keys` in your terminal to back",
      "  up your private keys before funding.",
      "",
    ].join("\n"));
  }

  // Deleting ~/.crush/wallet.json without a backup is the only way to lose
  // funds with this MCP, so we nag until --export-keys has run.
  //
  // Caveat: MCP clients (Claude Code) capture this stderr into a log the user
  // rarely reads — the *real* user-visible nag is the `wallet_info` tool
  // warning, which fires inside Claude chat. The stderr banner here is the
  // fallback for direct CLI invocations and for debugging.
  if (!wallet.backupAcknowledgedAt) {
    console.error([
      "",
      "  ⚠️  BACK UP YOUR WALLET",
      "",
      "  You have not exported your private keys yet. If ~/.crush/wallet.json is",
      "  deleted or lost, any USDC funded to your addresses becomes unrecoverable.",
      "",
      "  Run this in your terminal to view and save your keys:",
      "    npx @crush-rewards/mcp-server --export-keys",
      "",
      "  This warning goes away once you've run --export-keys at least once.",
      "",
    ].join("\n"));
  }
}

const server = await createServer({
  apiBase,
  evmPrivateKey,
  solanaPrivateKey,
  apiKey,
  backupAcknowledged,
});
const transport = new StdioServerTransport();
await server.connect(transport);
