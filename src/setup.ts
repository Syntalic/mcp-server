import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import {
  loadOrCreateWallet,
  loadWallet,
  markBackupAcknowledged,
  walletFileExists,
  WALLET_FILE,
} from "./lib/wallet.js";

async function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

export function printHelp() {
  console.log(`
  Syntalic Pricing Intelligence — MCP Server

  Usage:
    npx @crush-rewards/mcp-server                 Start the MCP server (default)
    npx @crush-rewards/mcp-server --setup         Interactive setup (wallet + Claude Code)
    npx @crush-rewards/mcp-server --export-keys   Print your private keys for backup/import
    npx @crush-rewards/mcp-server --info          Show wallet addresses, paths, and status
    npx @crush-rewards/mcp-server --help          Show this help

  Available Tools:

    Shopper (0.01 USDC/query)
      best_price          Find the cheapest price across retailers
      price_history       Price trends over time
      deal_finder         Current deals in a category
      price_drop_alert    Recent price drops

    Marketing (0.01 USDC/query)
      competitive_landscape   Competitive pricing overview
      brand_tracker           Brand pricing and positioning
      promo_intelligence      Promotional activity intelligence
      share_of_shelf          Brand share of shelf analysis
      price_positioning       Price positioning vs competitors

    Analyst (0.02 USDC/query)
      inflation_tracker       Category price inflation trends
      price_dispersion        Price variance across retailers
      retailer_index          Pricing index for a retailer
      category_summary        Comprehensive category summary

    Utility
      wallet_info             Show wallet addresses and funding instructions

  Payment: USDC on Solana, USDC on Base, or USDC.e on Tempo.
           Fund any chain — the client auto-selects whichever has balance.

  Bring your own keys (optional):
    export CRUSH_EVM_PRIVATE_KEY=0x...
    export CRUSH_SOLANA_PRIVATE_KEY=<base58>
    (Overrides the local wallet file. Useful for CI, shared setups, or HSMs.)

  Docs: https://www.syntalic.com
`);
}

function printPrivateKeys(evmKey: string, solanaKey: string) {
  // Use stderr so `... --export-keys | tee keys.log` doesn't silently
  // persist keys to whatever stdout is being piped into.
  console.error("");
  console.error(
    "  ─────────────────────────────────────────────────────────────",
  );
  console.error("  ⚠️  PRIVATE KEYS — save to a password manager, never share");
  console.error(
    "  ─────────────────────────────────────────────────────────────",
  );
  console.error("");
  console.error("    EVM key (Base/Tempo): " + evmKey);
  console.error("    Solana key (base58):  " + solanaKey);
  console.error("");
  console.error(
    "  Import EVM key into MetaMask/Rabby, Solana key into Phantom/Solflare",
  );
  console.error(
    "  if you want to fund or manage balances from an external wallet.",
  );
  console.error("");
  // Mark acknowledged AFTER the write above so a broken pipe (EPIPE) that cuts
  // off the key output doesn't leave us in "acked but keys never seen" state.
  markBackupAcknowledged();
}

function printByoInstructions() {
  console.log("");
  console.log("  Using your own keys (env vars)");
  console.log("  ───────────────────────────────");
  console.log("");
  console.log(
    "  Add these to your shell profile (or the MCP client's env config):",
  );
  console.log("");
  console.log("    export CRUSH_EVM_PRIVATE_KEY=0x<your_evm_private_key>");
  console.log(
    "    export CRUSH_SOLANA_PRIVATE_KEY=<your_solana_base58_private_key>",
  );
  console.log("");
  console.log(
    "  When both are set, the MCP skips ~/.crush/wallet.json entirely.",
  );
  console.log("");
  console.log("  Security tips:");
  console.log(
    "    • Use a dedicated wallet for this MCP — never your main funds.",
  );
  console.log(
    "    • Tiny per-query amounts (0.01-0.02 USDC) mean a few dollars",
  );
  console.log("      buys hundreds of queries; fund accordingly.");
  console.log("");
}

export async function runSetup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("");
    console.log("  Syntalic Pricing Intelligence — Setup");
    console.log("  ───────────────────────────────────");
    console.log("");

    // Fresh install: offer BYO path before creating a wallet file we may not need.
    if (!walletFileExists()) {
      console.log("  No wallet found. How do you want to set up?");
      console.log("");
      console.log("    [1] Generate a new multi-chain wallet (recommended)");
      console.log("        Creates a fresh wallet at ~/.crush/wallet.json.");
      console.log("        Best for most users — isolated from your main funds.");
      console.log("");
      console.log("    [2] Use your own private keys via environment variables");
      console.log("        You manage the keys; the MCP reads them from env.");
      console.log("        Best for CI, shared setups, or existing wallets.");
      console.log("");
      const choice = await ask(rl, "  Choice (1/2, default 1): ");
      if (choice === "2") {
        printByoInstructions();
        await configureClaudeCode(rl);
        return;
      }
    }

    const { wallet, isNew } = await loadOrCreateWallet();

    console.log("");
    console.log(
      isNew
        ? "  Generated new multi-chain wallet:"
        : `  Existing wallet at ${WALLET_FILE}:`,
    );
    console.log("");
    console.log("    Base / Tempo (EVM): " + wallet.evmAddress);
    console.log("    Solana:             " + wallet.solanaAddress);
    console.log("");
    console.log(
      "  Fund any chain — the client auto-picks the one with balance per query.",
    );

    if (isNew || !wallet.backupAcknowledgedAt) {
      console.log("");
      console.log("  ⚠️  Back up your keys before funding. Run:");
      console.log("        npx @crush-rewards/mcp-server --export-keys");
      console.log(
        "     If this machine loses the wallet file without a backup, funds",
      );
      console.log("     sent to the above addresses become unrecoverable.");
    }

    await configureClaudeCode(rl);
    printExampleQueries();
  } finally {
    // Always close the readline interface — an unclosed rl holds stdin open
    // and prevents Node from exiting cleanly if anything throws above.
    rl.close();
  }
}

function printExampleQueries() {
  console.log("  Try asking Claude:");
  console.log("");
  console.log(
    '    "What is the cheapest price for wireless earbuds right now?"',
  );
  console.log(
    '    "Show me the price history of the Sony WH-1000XM5 over the last 90 days."',
  );
  console.log('    "Any good deals on kitchen appliances this week?"');
  console.log(
    '    "Track how Nike pricing has moved versus Adidas at major US retailers."',
  );
  console.log(
    '    "What is the inflation trend for groceries over the last 6 months?"',
  );
  console.log("");
}

export async function runExportKeys() {
  if (!walletFileExists()) {
    const evmSet = Boolean(process.env.CRUSH_EVM_PRIVATE_KEY);
    const solanaSet = Boolean(process.env.CRUSH_SOLANA_PRIVATE_KEY);
    console.error("");
    console.error("  No wallet file found at " + WALLET_FILE);
    console.error("");
    if (evmSet && solanaSet) {
      console.error("  You're using env-var keys (CRUSH_EVM_PRIVATE_KEY +");
      console.error("  CRUSH_SOLANA_PRIVATE_KEY) — they live in your shell, not");
      console.error("  on disk, so there's nothing for --export-keys to show.");
    } else if (evmSet || solanaSet) {
      console.error(
        "  Partial env-var setup detected: " +
          (evmSet ? "CRUSH_EVM_PRIVATE_KEY" : "CRUSH_SOLANA_PRIVATE_KEY") +
          " is set",
      );
      console.error(
        "  but " +
          (evmSet ? "CRUSH_SOLANA_PRIVATE_KEY" : "CRUSH_EVM_PRIVATE_KEY") +
          " is missing.",
      );
      console.error(
        "  Both are required for BYO mode, or run --setup to generate a wallet.",
      );
    } else {
      console.error("  Run `--setup` to generate a wallet, or set");
      console.error(
        "  CRUSH_EVM_PRIVATE_KEY + CRUSH_SOLANA_PRIVATE_KEY to bring your own.",
      );
    }
    console.error("");
    process.exit(1);
  }
  // Read-only load (plus silent migration if legacy keys are missing): never
  // regenerate from scratch here. If the file vanished between
  // walletFileExists() and now (TOCTOU), surface the error instead of
  // creating a fresh wallet the user would then back up instead of the old,
  // funded one.
  const wallet = await loadWallet();
  printPrivateKeys(wallet.evmPrivateKey, wallet.solanaPrivateKey);
}

export async function runInfo() {
  console.log("");
  console.log("  Syntalic Pricing Intelligence — Status");
  console.log("  ────────────────────────────────────");
  console.log("");

  const envEvm = process.env.CRUSH_EVM_PRIVATE_KEY;
  const envSolana = process.env.CRUSH_SOLANA_PRIVATE_KEY;
  const apiBase =
    process.env.CRUSH_API_BASE ?? "https://api.syntalic.com (default)";
  const solanaRpc =
    process.env.CRUSH_SOLANA_RPC_URL ??
    "https://api.mainnet-beta.solana.com (default)";
  const tempoRpc =
    process.env.CRUSH_TEMPO_RPC_URL ?? "https://rpc.tempo.xyz (default)";

  if (envEvm && envSolana) {
    console.log(
      "  Wallet source: environment variables (CRUSH_EVM_PRIVATE_KEY + CRUSH_SOLANA_PRIVATE_KEY)",
    );
    console.log(
      "                 ~/.crush/wallet.json is ignored when both env vars are set.",
    );
  } else if (walletFileExists()) {
    // Read-only — we never want --info to create a wallet from scratch. If
    // the file is missing keys for either chain, `loadWallet` silently migrates
    // (adds the missing chain, preserves the existing one), which is the right
    // behavior for --info: the user expects to see their complete wallet.
    try {
      const wallet = await loadWallet();
      console.log("  Wallet file: " + WALLET_FILE);
      console.log("    Created:        " + wallet.createdAt);
      console.log("    Base / Tempo:   " + wallet.evmAddress);
      console.log("    Solana:         " + wallet.solanaAddress);
      console.log(
        "    Keys exported:  " +
          (wallet.backupAcknowledgedAt ?? "NO — run `--export-keys` to back up"),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log("  Wallet file: " + WALLET_FILE + " (failed to load)");
      console.log("    " + msg);
    }
  } else {
    console.log(
      "  No wallet found. Run `--setup` to create one or set CRUSH_EVM_PRIVATE_KEY",
    );
    console.log("  + CRUSH_SOLANA_PRIVATE_KEY to bring your own.");
  }

  console.log("");
  console.log("  Endpoints");
  console.log("    API base:       " + apiBase);
  console.log("    Solana RPC:     " + solanaRpc);
  console.log("    Tempo RPC:      " + tempoRpc);
  console.log("");
}

async function configureClaudeCode(rl: ReturnType<typeof createInterface>) {
  console.log("");
  const configureClaude = await ask(
    rl,
    "  Auto-configure Claude Code? (Y/n): ",
  );

  const claudeArgs = [
    "mcp",
    "add",
    "-s",
    "user",
    "crush-pricing",
    "--",
    "npx",
    "-y",
    "@crush-rewards/mcp-server",
  ];
  const cmdString = "claude " + claudeArgs.join(" ");

  if (configureClaude.toLowerCase() === "n") {
    console.log("");
    console.log("  Add this to ~/.claude/settings.json under mcpServers:");
    console.log("");
    console.log('    "crush-pricing": {');
    console.log('      "command": "npx",');
    console.log('      "args": ["-y", "@crush-rewards/mcp-server"]');
    console.log("    }");
    console.log("");
    console.log("  Or run this later:");
    console.log("    " + cmdString);
    console.log("");
    return;
  }

  // Disclose which `claude` binary we're about to run — defends against PATH hijack
  // where a malicious ~/bin/claude or node_modules/.bin/claude shadows the real CLI.
  const which = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["claude"],
    { encoding: "utf8" },
  );
  if (which.status !== 0) {
    console.log("");
    console.log("  `claude` CLI not found on PATH.");
    console.log("  Install it from https://claude.ai/code, then run:");
    console.log("    " + cmdString);
    console.log("");
    return;
  }
  const resolvedPath = which.stdout.trim().split("\n")[0];
  console.log("");
  console.log("  Running: " + resolvedPath);
  console.log("  Args:    " + claudeArgs.join(" "));
  const confirm = await ask(rl, "  Proceed? (Y/n): ");
  if (confirm.toLowerCase() === "n") {
    console.log("");
    console.log("  Skipped. Run manually when ready:");
    console.log("    " + cmdString);
    return;
  }

  // spawnSync with argv array — no shell interpolation, no injection risk.
  const result = spawnSync("claude", claudeArgs, { stdio: "inherit" });
  if (result.status === 0) {
    console.log("");
    console.log(
      "  Claude Code configured. Open a new session to use the pricing tools.",
    );
  } else if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    console.log("");
    if (code === "ENOENT") {
      console.log("  `claude` CLI disappeared between detection and launch.");
      console.log("  Reinstall from https://claude.ai/code, then run:");
    } else {
      console.log(
        "  Failed to launch claude (" + (code ?? "unknown") + "). Run manually:",
      );
    }
    console.log("    " + cmdString);
  } else {
    console.log("");
    console.log(
      "  claude exited with status " + result.status + ". Run manually:",
    );
    console.log("    " + cmdString);
  }
  console.log("");
}
