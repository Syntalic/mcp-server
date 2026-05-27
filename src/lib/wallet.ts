import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Current wallet schema version. Bump when the file shape changes in a way
 * that requires an explicit migration branch in `loadOrCreateWallet`. Files
 * written before this field existed (v0.3.0 and earlier) are treated as
 * version 1 on read.
 */
export const CURRENT_WALLET_SCHEMA_VERSION = 1;

/**
 * The in-memory, post-migration wallet shape. Callers can rely on every chain's
 * keys being populated. Anything that may be missing on disk is reconciled by
 * `migrateLegacyWallet` before reaching consumers.
 */
export interface WalletConfig {
  schemaVersion: number;
  createdAt: string;
  evmPrivateKey: string;
  evmAddress: string;
  solanaPrivateKey: string;
  solanaAddress: string;
  /**
   * Set when the user has explicitly viewed their private keys via
   * `--export-keys`. While unset, the server prints a backup-reminder banner
   * on every startup. The only way to lose funds with this MCP is a wallet
   * file that was never exported before being deleted — this field is how we
   * harass the user into not letting that happen.
   */
  backupAcknowledgedAt?: string;
}

/**
 * The on-disk shape we may encounter. Older versions wrote partial files
 * (v0.2.x: EVM only; hypothetical future: Solana only), so every key-bearing
 * field is optional until `migrateLegacyWallet` fills in the gaps.
 */
interface RawWalletConfig {
  schemaVersion?: number;
  createdAt?: string;
  evmPrivateKey?: string;
  evmAddress?: string;
  solanaPrivateKey?: string;
  solanaAddress?: string;
  backupAcknowledgedAt?: string;
}

const WALLET_DIR = join(homedir(), ".crush");
const WALLET_FILE = join(WALLET_DIR, "wallet.json");

export { WALLET_FILE };

export function walletFileExists(): boolean {
  return existsSync(WALLET_FILE);
}

async function generateEvmWallet(): Promise<{ privateKey: string; address: string }> {
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}

async function generateSolanaWallet(): Promise<{ privateKey: string; address: string }> {
  const { base58 } = await import("@scure/base");
  const ed25519Key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const privRaw = new Uint8Array(await crypto.subtle.exportKey("pkcs8", ed25519Key.privateKey));
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ed25519Key.publicKey));
  const seed = privRaw.slice(privRaw.length - 32);
  const keypairBytes = new Uint8Array(64);
  keypairBytes.set(seed, 0);
  keypairBytes.set(pubRaw, 32);
  return { privateKey: base58.encode(keypairBytes), address: base58.encode(pubRaw) };
}

/**
 * Refuse to follow symlinks on either the wallet directory or file — an attacker
 * with local filesystem access could otherwise redirect our writes.
 *
 * `existsSync` follows symlinks and returns false for a dangling symlink whose
 * target doesn't exist. We must call `lstatSync` directly and tolerate ENOENT
 * only when there is truly no path at all.
 */
function assertNoSymlink(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(
      `Refusing to use ${path}: it is a symlink. Remove it (with care — it may point to a real wallet) ` +
      `and re-run. This check prevents an attacker from redirecting your private keys to a world-readable location.`,
    );
  }
}

function saveWallet(config: WalletConfig): void {
  assertNoSymlink(WALLET_DIR);
  mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  // mode on mkdirSync/writeFileSync only applies at creation; force-tighten
  // existing dir/file so a user who restored a backup with loose perms is safe.
  try { chmodSync(WALLET_DIR, 0o700); } catch { /* best-effort */ }

  assertNoSymlink(WALLET_FILE);

  // Atomic write: if the process dies mid-write, wallet.json stays intact.
  // A corrupted wallet.json is how users panic-delete and lose funds, so we
  // go out of our way to avoid ever producing one.
  const tmp = WALLET_FILE + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* best-effort */ }
    renameSync(tmp, WALLET_FILE);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
  try { chmodSync(WALLET_FILE, 0o600); } catch { /* best-effort */ }
}

function warnIfPermissive(): void {
  if (!existsSync(WALLET_FILE)) return;
  try {
    const mode = statSync(WALLET_FILE).mode;
    if (mode & 0o077) {
      console.error(
        `⚠️  ${WALLET_FILE} is readable by other users (mode ${(mode & 0o777).toString(8)}). ` +
        `Fix with: chmod 600 ${WALLET_FILE}`,
      );
    }
  } catch { /* best-effort */ }
}

/**
 * Wraps `JSON.parse` on the wallet file with a message that explicitly warns
 * against deletion. A panicked user facing a raw `SyntaxError` might `rm` the
 * file — and that's the one action that destroys funds unrecoverably.
 */
function parseWalletFile(): RawWalletConfig {
  const raw = readFileSync(WALLET_FILE, "utf-8");
  try {
    return JSON.parse(raw) as RawWalletConfig;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Wallet file at ${WALLET_FILE} is corrupt (${detail}). ` +
        `DO NOT DELETE THIS FILE without a backup — your funds are tied to the ` +
        `private keys inside it. If you have the keys saved elsewhere (Phantom, ` +
        `MetaMask, password manager), delete the file and re-run --setup. ` +
        `Otherwise, restore ${WALLET_FILE} from a backup before doing anything else.`,
    );
  }
}

/**
 * Loads the wallet without ever generating one from scratch. Missing chain
 * keys are auto-generated and persisted (migration), but a missing file is
 * treated as an error — use `loadOrCreateWallet` if fresh creation is OK.
 *
 * Used by `--export-keys` (needs all keys to back up) and `--info` (wants a
 * fully-resolved view). Both benefit from migration persisting, so subsequent
 * runs don't re-migrate.
 */
export async function loadWallet(): Promise<WalletConfig> {
  warnIfPermissive();
  if (!existsSync(WALLET_FILE)) {
    throw new Error(`No wallet found at ${WALLET_FILE}`);
  }
  const loaded = parseWalletFile();
  const { wallet, keyChanges, schemaTagged } = await migrateLegacyWallet(loaded);
  if (keyChanges.length > 0 || schemaTagged) {
    saveWallet(wallet);
  }
  if (keyChanges.length > 0) {
    logMigrations(keyChanges);
  }
  return wallet;
}

/**
 * Marks the wallet file as "keys have been exported by the user". Called by
 * `--export-keys` after the private keys are displayed. Persists by rewriting
 * the wallet file with the new timestamp.
 *
 * Corrupt-JSON errors are propagated (not swallowed). Missing file is a no-op
 * (BYO env-var path calls this harmlessly). Legacy wallets are assumed
 * already migrated by the caller (`runExportKeys` calls `loadWallet` first).
 */
export function markBackupAcknowledged(): void {
  if (!existsSync(WALLET_FILE)) return;
  const wallet = parseWalletFile();
  if (wallet.backupAcknowledgedAt) return;
  wallet.backupAcknowledgedAt = new Date().toISOString();
  // parseWalletFile returned RawWalletConfig; if we're here, the caller already
  // ran migration so the on-disk file is complete. Cast is safe.
  saveWallet(wallet as WalletConfig);
}

function logMigrations(migrations: string[]): void {
  console.error([
    "",
    "  Wallet file migrated: " + migrations.join(", ") + ".",
    "  Any existing funds are preserved — no addresses were overwritten.",
    "  Run `npx @syntalic/mcp-server --export-keys` to back up the new key material.",
    "",
  ].join("\n"));
}

/**
 * Loads the wallet from ~/.crush/wallet.json, or generates a new multi-chain
 * wallet if none exists. If an existing file is missing keys for either chain
 * (v0.2.x wallets have no Solana keys; a hypothetical Solana-only file would
 * have no EVM keys), this function auto-migrates: it fills in the missing
 * material, saves, and surfaces a stderr banner so the user knows what
 * changed. Existing keys are never overwritten — any funds on already-funded
 * addresses are preserved.
 */
export async function loadOrCreateWallet(): Promise<{
  wallet: WalletConfig;
  isNew: boolean;
}> {
  warnIfPermissive();

  if (existsSync(WALLET_FILE)) {
    const loaded = parseWalletFile();
    const { wallet, keyChanges, schemaTagged } = await migrateLegacyWallet(loaded);
    if (keyChanges.length > 0 || schemaTagged) {
      saveWallet(wallet);
    }
    // Only announce user-visible changes. A silent schema tag doesn't need a
    // banner claiming "back up the new key material" — no new keys appeared.
    if (keyChanges.length > 0) {
      logMigrations(keyChanges);
    }
    return { wallet, isNew: false };
  }

  const [evm, solana] = await Promise.all([generateEvmWallet(), generateSolanaWallet()]);
  const wallet: WalletConfig = {
    schemaVersion: CURRENT_WALLET_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    evmPrivateKey: evm.privateKey,
    evmAddress: evm.address,
    solanaPrivateKey: solana.privateKey,
    solanaAddress: solana.address,
  };
  saveWallet(wallet);
  return { wallet, isNew: true };
}

/**
 * Brings a freshly-parsed wallet up to the current schema. Fills in any
 * missing chain keys without touching ones that already exist, so funds on
 * existing addresses are never stranded. Whenever new key material is
 * introduced we clear `backupAcknowledgedAt` — the user needs to export the
 * new keys before the backup state is meaningful again.
 *
 * Returns the complete `WalletConfig` plus two flags:
 *   - `keyChanges`: user-visible, shown in the migration banner.
 *   - `schemaTagged`: silent (persisted but not announced). Used to upgrade
 *     v0.3.0 wallets to the explicit schemaVersion=1 marker without spamming
 *     users with a banner about a field they don't care about.
 */
async function migrateLegacyWallet(
  loaded: RawWalletConfig,
): Promise<{ wallet: WalletConfig; keyChanges: string[]; schemaTagged: boolean }> {
  const keyChanges: string[] = [];
  let evmPrivateKey = loaded.evmPrivateKey;
  let evmAddress = loaded.evmAddress;
  let solanaPrivateKey = loaded.solanaPrivateKey;
  let solanaAddress = loaded.solanaAddress;
  let backupAcknowledgedAt = loaded.backupAcknowledgedAt;

  if (!evmPrivateKey || !evmAddress) {
    const evm = await generateEvmWallet();
    evmPrivateKey = evm.privateKey;
    evmAddress = evm.address;
    backupAcknowledgedAt = undefined;
    keyChanges.push("added EVM wallet (Base / Tempo)");
  }

  if (!solanaPrivateKey || !solanaAddress) {
    const solana = await generateSolanaWallet();
    solanaPrivateKey = solana.privateKey;
    solanaAddress = solana.address;
    backupAcknowledgedAt = undefined;
    keyChanges.push("added Solana wallet");
  }

  const schemaTagged = loaded.schemaVersion === undefined;

  const wallet: WalletConfig = {
    schemaVersion: loaded.schemaVersion ?? CURRENT_WALLET_SCHEMA_VERSION,
    createdAt: loaded.createdAt ?? new Date().toISOString(),
    evmPrivateKey,
    evmAddress,
    solanaPrivateKey,
    solanaAddress,
    backupAcknowledgedAt,
  };
  return { wallet, keyChanges, schemaTagged };
}
