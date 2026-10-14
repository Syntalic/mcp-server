import { address as asSolanaAddress } from "@solana/kit";
import { readEnv } from "./env.js";
import { DEFAULT_SOLANA_RPC_URL, DEFAULT_TEMPO_RPC_URL, resolveRpcUrl } from "./fetch.js";
import { deriveAssociatedTokenAccount, getTokenAccountBalance } from "./solana-rpc.js";
import { getErc20Balance } from "./tempo-rpc.js";

/** The tokens the API accepts, one per chain. All three have 6 decimals. */
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const TEMPO_USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";
export const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";
const DECIMALS = 6;

export interface ChainBalance {
  chain: "Solana" | "Base" | "Tempo";
  token: string;
  /** Atomic units; undefined when the balance could not be read. */
  atomic?: bigint;
  error?: string;
}

/** 12345678n -> "12.345678". */
export function formatUnits(atomic: bigint, decimals = DECIMALS): string {
  const s = atomic.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

function rpcUrls() {
  const sol = readEnv("SOLANA_RPC_URL");
  const base = readEnv("BASE_RPC_URL");
  const tempo = readEnv("TEMPO_RPC_URL");
  return {
    solana: resolveRpcUrl(sol.name, sol.value, DEFAULT_SOLANA_RPC_URL),
    base: resolveRpcUrl(base.name, base.value, DEFAULT_BASE_RPC_URL),
    tempo: resolveRpcUrl(tempo.name, tempo.value, DEFAULT_TEMPO_RPC_URL),
  };
}

async function settle(chain: ChainBalance["chain"], token: string, read: () => Promise<bigint>): Promise<ChainBalance> {
  try {
    return { chain, token, atomic: await read() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { chain, token, error: msg.length > 120 ? msg.slice(0, 120) + "…" : msg };
  }
}

/**
 * The wallet's live balance on each chain, read in parallel from the same RPCs the payment
 * pre-checks use (2-second timeout each). A chain whose RPC fails says so instead of reading 0,
 * because "did my funding land?" must never be answered by an RPC outage.
 */
export async function readBalances(evmAddress: string, solanaAddress: string): Promise<ChainBalance[]> {
  const rpc = rpcUrls();
  return Promise.all([
    settle("Solana", "USDC", async () => {
      const ata = await deriveAssociatedTokenAccount(asSolanaAddress(solanaAddress), asSolanaAddress(SOLANA_USDC_MINT));
      return getTokenAccountBalance(rpc.solana, ata);
    }),
    settle("Base", "USDC", () => getErc20Balance(rpc.base, BASE_USDC, evmAddress)),
    settle("Tempo", "USDC.e", () => getErc20Balance(rpc.tempo, TEMPO_USDC_E, evmAddress)),
  ]);
}

export function formatBalances(balances: ChainBalance[]): string[] {
  return balances.map((b) => {
    const label = `${b.chain}:`.padEnd(8);
    return b.atomic === undefined
      ? `  ${label}unavailable (${b.error ?? "unknown error"}); this is not a zero balance`
      : `  ${label}${formatUnits(b.atomic)} ${b.token}`;
  });
}
