import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_MCP_ADD_ARGS, createPrompter, printHelp } from "./setup.js";
import { HIDDEN_ROUTE_TOOLS } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The key env vars, under both prefixes: a test sets the ones it means and inherits none. */
const KEY_VARS = ["EVM_PRIVATE_KEY", "SOLANA_PRIVATE_KEY"].flatMap((k) => [`SYNTALIC_${k}`, `CRUSH_${k}`]);

/** `--setup` through the real entry point, in a throwaway HOME. PATH holds only node, so a "yes" can
 *  never reach the real `claude` CLI and change the user's own Claude Code config. */
function setup(home: string, stdin: string, env: Record<string, string> = {}, args: string[] = []) {
  const base: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PATH: dirname(process.execPath) };
  for (const k of KEY_VARS) delete base[k];
  return spawnSync(process.execPath, ["--import", "tsx", join(here, "index.ts"), "--setup", ...args], {
    input: stdin,
    env: { ...base, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function piped(text: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  input.end(text);
  return createPrompter(input, output);
}

describe("setup prompts", () => {
  it("answers each question from piped lines, in order, even when they all arrive at once", async () => {
    const p = piped("1\nn\n");
    assert.equal(await p.ask("a? "), "1");
    assert.equal(await p.ask("b? "), "n");
    assert.equal(await p.ask("c? "), null, "past the end of stdin there is no answer, not a crash");
    p.close();
  });

  it("answers null when stdin is closed with nothing on it", async () => {
    const p = piped("");
    assert.equal(await p.ask("a? "), null);
    p.close();
  });

  // The 0.11.0 crash: `printf '1\nn\n' | npx @syntalic/mcp-server --setup` created the wallet and
  // then threw ERR_USE_AFTER_CLOSE. Run the real entry point the same way, in a throwaway HOME.
  for (const [label, stdin] of [
    ["piped answers", "1\nn\n"],
    ["a closed stdin", ""],
  ] as const) {
    it(`--setup with ${label} finishes, creates the wallet and does not configure Claude Code`, () => {
      const home = mkdtempSync(join(tmpdir(), "syntalic-setup-"));
      try {
        const run = setup(home, stdin);
        assert.equal(run.status, 0, run.stderr);
        assert.doesNotMatch(run.stderr, /ERR_USE_AFTER_CLOSE/);
        assert.ok(existsSync(join(home, ".syntalic", "wallet.json")));
        assert.doesNotMatch(run.stdout, /Running: /, "it must not run `claude mcp add` without a yes");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

describe("registering with Claude Code (SYNLBS-270)", () => {
  it("registers @latest, so npx does not keep running the version it cached first", () => {
    assert.equal(CLAUDE_MCP_ADD_ARGS.at(-1), "@syntalic/mcp-server@latest");
    assert.deepEqual(CLAUDE_MCP_ADD_ARGS.slice(0, 6), ["mcp", "add", "-s", "user", "syntalic", "--"]);
  });

  it("declined, prints the claude mcp add command, not a settings.json snippet Claude Code never reads", () => {
    const home = mkdtempSync(join(tmpdir(), "syntalic-setup-"));
    try {
      const run = setup(home, "1\nn\n");
      assert.equal(run.status, 0, run.stderr);
      assert.ok(run.stdout.includes("claude mcp add -s user syntalic -- npx -y @syntalic/mcp-server@latest"), run.stdout);
      assert.doesNotMatch(run.stdout, /settings\.json|mcpServers/);
      assert.match(run.stdout, /npx @syntalic\/mcp-server@latest --export-keys/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("--setup with both key env vars set (SYNLBS-271)", () => {
  // The server pays from the env keys and never reads the wallet file, so setup must not create one or
  // show addresses to fund: they would be a wallet nothing spends from.
  const keys = {
    SYNTALIC_EVM_PRIVATE_KEY: "0x" + "11".repeat(32),
    SYNTALIC_SOLANA_PRIVATE_KEY: "not-read-by-setup",
  };
  for (const [label, stdin, args] of [
    ["answering the prompts", "n\n", []],
    ["--yes", "", ["--yes", "--no-claude"]],
  ] as const) {
    it(`creates no wallet and prints no addresses to fund (${label})`, () => {
      const home = mkdtempSync(join(tmpdir(), "syntalic-setup-"));
      try {
        const run = setup(home, stdin, keys, [...args]);
        assert.equal(run.status, 0, run.stderr);
        assert.equal(existsSync(join(home, ".syntalic", "wallet.json")), false, "a wallet file was created");
        assert.match(run.stdout, /Using your own keys: SYNTALIC_EVM_PRIVATE_KEY and SYNTALIC_SOLANA_PRIVATE_KEY/);
        assert.match(run.stdout, /creates no wallet file/);
        assert.doesNotMatch(run.stdout, /Fund any chain|Generated new|Base \/ Tempo \(EVM\): 0x/);
        assert.doesNotMatch(run.stdout, /How do you want to set up\?/);
        assert.doesNotMatch(run.stdout, /Running: /);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it("says an existing wallet file is not used while both are set", () => {
    const home = mkdtempSync(join(tmpdir(), "syntalic-setup-"));
    try {
      assert.equal(setup(home, "1\nn\n").status, 0);
      const before = readFileSync(join(home, ".syntalic", "wallet.json"), "utf8");
      const run = setup(home, "n\n", keys);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /wallet\.json is not used while both are set/);
      assert.doesNotMatch(run.stdout, /Existing wallet at|Fund any chain/);
      assert.equal(readFileSync(join(home, ".syntalic", "wallet.json"), "utf8"), before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("warns when only one is set, since the server will not start that way", () => {
    const home = mkdtempSync(join(tmpdir(), "syntalic-setup-"));
    try {
      const run = setup(home, "1\nn\n", { SYNTALIC_EVM_PRIVATE_KEY: keys.SYNTALIC_EVM_PRIVATE_KEY });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /SYNTALIC_EVM_PRIVATE_KEY is set but SYNTALIC_SOLANA_PRIVATE_KEY is not/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("--help", () => {
  it("lists every tool the server registers", () => {
    const src = readFileSync(join(here, "server.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // A tool whose route is dark on the API is not registered, and not listed.
    const tools = [...src.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)]
      .map((m) => m[1]!)
      .filter((t) => !HIDDEN_ROUTE_TOOLS.includes(t));
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      printHelp();
    } finally {
      console.log = realLog;
    }
    const help = lines.join("\n");
    const missing = tools.filter((t) => !new RegExp(`\\b${t}\\b`).test(help));
    assert.deepEqual(missing, [], `--help does not list: ${missing.join(", ")}`);
  });
});
