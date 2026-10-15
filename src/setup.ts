import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { readEnv } from "./lib/env.js";
import { formatBalances, readBalances } from "./lib/balances.js";
import {
  loadOrCreateWallet,
  loadWallet,
  markBackupAcknowledged,
  walletFileExists,
  WALLET_FILE,
} from "./lib/wallet.js";

export interface SetupOptions {
  /** --yes: take every default without asking (new wallet, configure Claude Code). */
  yes?: boolean;
  /** --no-claude: never offer to run `claude mcp add`. */
  noClaude?: boolean;
}

/**
 * Answers read line by line from stdin, typed or piped. readline/promises' question() loses lines
 * that arrive before it is asked (a pipe delivers them all at once) and throws ERR_USE_AFTER_CLOSE
 * once stdin reaches EOF, which crashed `printf '1\nn\n' | … --setup` right after it had
 * created the wallet. Here lines queue until asked for, and EOF answers null: no answer, so the
 * caller takes the safe default.
 */
export interface Prompter {
  ask(question: string): Promise<string | null>;
  close(): void;
}

export function createPrompter(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Prompter {
  const rl = createInterface({ input, terminal: false });
  const queued: string[] = [];
  const waiting: Array<(answer: string | null) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line.trim());
    else queued.push(line.trim());
  });
  rl.on("close", () => {
    closed = true;
    for (const next of waiting.splice(0)) next(null);
  });
  const typed = Boolean((input as { isTTY?: boolean }).isTTY);
  return {
    ask(question) {
      output.write(question);
      const answer = queued.shift();
      if (answer !== undefined) {
        if (!typed) output.write(answer + "\n"); // echo a piped answer so the transcript reads right
        return Promise.resolve(answer);
      }
      if (closed) {
        output.write("\n");
        return Promise.resolve(null);
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}

export function printHelp() {
  console.log(`
  Syntalic Pricing Intelligence — MCP Server

  Usage:
    npx @syntalic/mcp-server                 Start the MCP server (default)
    npx @syntalic/mcp-server --setup         Interactive setup (wallet + Claude Code)
        --yes, -y                            Take every default without asking
        --no-claude                          Do not offer to configure Claude Code
                                             (piped or closed stdin never configures it)
    npx @syntalic/mcp-server --export-keys   Print your private keys for backup/import
    npx @syntalic/mcp-server --info          Show wallet addresses, live balances, paths and status
    npx @syntalic/mcp-server --help          Show this help

  Tools (every paid tool states its price in its description):

    Free
      wallet_info             Wallet addresses, live balances, funding instructions
      catalog_overview        The shape of the catalog: products, listings, brands
      browse_categories       The category tree with product counts
      list_retailers          Retailers in the catalog
      list_brands             Brands in the catalog
      coverage_map            Where the catalog is deep and where it is thin

    Ontology ($0.01): names to ids, and the evidence behind them
      ontology_resolve        A brand, category, product type or retailer name -> ids
      ontology_neighbors      What sits next to one id
      ontology_coverage       How much evidence stands behind ids, and what was scanned

    Shopper ($0.01)
      best_price              The cheapest current price across retailers
      price_history           A product's price over time
      deal_finder             Current deals in a category
      price_drop_alert        Recent price drops on a product

    Marketing ($0.01)
      competitive_landscape   Competitive pricing in a category
      brand_tracker           A brand's pricing and positioning
      promo_intelligence      Promotion frequency and depth
      share_of_shelf          Brand share of a shelf
      price_positioning       A brand's price tier on its shelf
      brand_breakdown         A brand's assortment by category
      retailer_assortment     Which chains carry a brand or a category
      availability_index      Out-of-stock rates by retailer or category

    Analyst ($0.02)
      inflation_tracker       Like-for-like price change in a category
      price_dispersion        Price spread across a category
      retailer_index          A retailer's price index
      price_bands             A shelf's price tiers
      category_summary        A category's pricing summary
      category_concentration  How few brands own a shelf (HHI, CR4)
      price_change_leaders    The biggest price movers

    Reference ($0.01 per request, up to 100 ids)
      classify_product_type   Product type or browse node -> GS1 GPC brick
      gpc_reverse_lookup      GPC code -> the browse nodes mapped onto it
      gpc_brick_attributes    GS1 attribute schema for a brick

    Social ($0.03)
      creator_index           Creators driving mention volume
      brand_share             Share of conversation by brand
      category_structure      Which subcategories own the conversation
      brand_momentum          Brands rising, falling or new in conversation
      topic_trends            Emerging conversation topics
      product_type_trends     Attention by product type
      social_series           Weekly mentions and views for a brand or category

    Scout ($0.05)
      attention_vs_shelf      Share of conversation against share of shelf
      launch_buzz             New arrivals against the conversation around them

  Payment: USDC on Solana, USDC on Base, or USDC.e on Tempo.
           Fund any chain — the client auto-selects whichever has balance.
           SYNTALIC_PAYMENT_NETWORK=solana|base|tempo pays on that chain only.
           SYNTALIC_SOLANA_RPC_URL sets a dedicated Solana RPC (the public one rate-limits).

  Bring your own keys (optional):
    export SYNTALIC_EVM_PRIVATE_KEY=0x...
    export SYNTALIC_SOLANA_PRIVATE_KEY=<base58>
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
  console.log("    export SYNTALIC_EVM_PRIVATE_KEY=0x<your_evm_private_key>");
  console.log(
    "    export SYNTALIC_SOLANA_PRIVATE_KEY=<your_solana_base58_private_key>",
  );
  console.log("");
  console.log(
    "  When both are set, the MCP skips ~/.syntalic/wallet.json entirely.",
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

export async function runSetup(opts: SetupOptions = {}) {
  const rl = createPrompter();
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
      console.log("        Creates a fresh wallet at ~/.syntalic/wallet.json.");
      console.log("        Best for most users — isolated from your main funds.");
      console.log("");
      console.log("    [2] Use your own private keys via environment variables");
      console.log("        You manage the keys; the MCP reads them from env.");
      console.log("        Best for CI, shared setups, or existing wallets.");
      console.log("");
      const choice = opts.yes ? "1" : await rl.ask("  Choice (1/2, default 1): ");
      if (choice === "2") {
        printByoInstructions();
        await configureClaudeCode(rl, opts);
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
      console.log("        npx @syntalic/mcp-server --export-keys");
      console.log(
        "     If this machine loses the wallet file without a backup, funds",
      );
      console.log("     sent to the above addresses become unrecoverable.");
    }

    await configureClaudeCode(rl, opts);
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
    const evmVar = readEnv("EVM_PRIVATE_KEY");
    const solanaVar = readEnv("SOLANA_PRIVATE_KEY");
    const evmSet = Boolean(evmVar.value);
    const solanaSet = Boolean(solanaVar.value);
    console.error("");
    console.error("  No wallet file found at " + WALLET_FILE);
    console.error("");
    if (evmSet && solanaSet) {
      console.error("  You're using env-var keys (" + evmVar.name + " +");
      console.error("  " + solanaVar.name + ") — they live in your shell, not");
      console.error("  on disk, so there's nothing for --export-keys to show.");
    } else if (evmSet || solanaSet) {
      console.error(
        "  Partial env-var setup detected: " +
          (evmSet ? evmVar.name : solanaVar.name) +
          " is set",
      );
      console.error(
        "  but " +
          (evmSet ? "SYNTALIC_SOLANA_PRIVATE_KEY" : "SYNTALIC_EVM_PRIVATE_KEY") +
          " is missing.",
      );
      console.error(
        "  Both are required for BYO mode, or run --setup to generate a wallet.",
      );
    } else {
      console.error("  Run `--setup` to generate a wallet, or set");
      console.error(
        "  SYNTALIC_EVM_PRIVATE_KEY + SYNTALIC_SOLANA_PRIVATE_KEY to bring your own.",
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

  const evmVar = readEnv("EVM_PRIVATE_KEY");
  const solanaVar = readEnv("SOLANA_PRIVATE_KEY");
  const envEvm = evmVar.value;
  const envSolana = solanaVar.value;
  const apiBase =
    readEnv("API_BASE").value ?? "https://api.syntalic.com (default)";
  const solanaRpc =
    readEnv("SOLANA_RPC_URL").value ??
    "https://api.mainnet-beta.solana.com (default)";
  const tempoRpc =
    readEnv("TEMPO_RPC_URL").value ?? "https://rpc.tempo.xyz (default)";
  const baseRpc =
    readEnv("BASE_RPC_URL").value ?? "https://mainnet.base.org (default)";
  const pinVar = readEnv("PAYMENT_NETWORK");
  const payment = pinVar.value?.trim()
    ? `${pinVar.value.trim()} only (${pinVar.name})`
    : "solana, then base, then tempo (default)";

  let addresses: { evm: string; solana: string } | undefined;
  if (envEvm && envSolana) {
    console.log(
      "  Wallet source: environment variables (" + evmVar.name + " + " + solanaVar.name + ")",
    );
    console.log(
      "                 ~/.syntalic/wallet.json is ignored when both env vars are set.",
    );
    try {
      addresses = await addressesFromKeys(envEvm, envSolana);
      console.log("    Base / Tempo:   " + addresses.evm);
      console.log("    Solana:         " + addresses.solana);
    } catch {
      console.log("    (a key is malformed; the server will say which at startup)");
    }
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
      addresses = { evm: wallet.evmAddress, solana: wallet.solanaAddress };
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
      "  No wallet found. Run `--setup` to create one or set SYNTALIC_EVM_PRIVATE_KEY",
    );
    console.log("  + SYNTALIC_SOLANA_PRIVATE_KEY to bring your own.");
  }

  if (addresses) {
    console.log("");
    console.log("  Balances (read live just now)");
    for (const line of formatBalances(await readBalances(addresses.evm, addresses.solana))) {
      console.log("  " + line);
    }
  }

  console.log("");
  console.log("  Endpoints");
  console.log("    API base:       " + apiBase);
  console.log("    Solana RPC:     " + solanaRpc);
  console.log("    Base RPC:       " + baseRpc);
  console.log("    Tempo RPC:      " + tempoRpc);
  console.log("    Payment chain:  " + payment);
  console.log("");
}

/** The public addresses for env-var keys, derived the same way the server derives them. */
async function addressesFromKeys(evmKey: string, solanaKey: string): Promise<{ evm: string; solana: string }> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { base58 } = await import("@scure/base");
  const keypair = base58.decode(solanaKey);
  if (keypair.length !== 64) throw new Error("Solana key is not a 64-byte keypair");
  return {
    evm: privateKeyToAccount(evmKey as `0x${string}`).address,
    solana: base58.encode(keypair.slice(32)),
  };
}

async function configureClaudeCode(rl: Prompter, opts: SetupOptions) {
  console.log("");
  // No answer (stdin closed: a script or an agent) is a "no": running `claude mcp add` is a change
  // to the user's config, and only a person, or --yes, should make it.
  const configureClaude = opts.noClaude
    ? "n"
    : opts.yes
      ? "y"
      : ((await rl.ask("  Auto-configure Claude Code? (Y/n): ")) ?? "n");

  const claudeArgs = [
    "mcp",
    "add",
    "-s",
    "user",
    "syntalic",
    "--",
    "npx",
    "-y",
    "@syntalic/mcp-server",
  ];
  const cmdString = "claude " + claudeArgs.join(" ");

  if (configureClaude.toLowerCase() === "n") {
    console.log("");
    console.log("  Add this to ~/.claude/settings.json under mcpServers:");
    console.log("");
    console.log('    "syntalic": {');
    console.log('      "command": "npx",');
    console.log('      "args": ["-y", "@syntalic/mcp-server"]');
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
  const confirm = opts.yes ? "y" : ((await rl.ask("  Proceed? (Y/n): ")) ?? "n");
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
