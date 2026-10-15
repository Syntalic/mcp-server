import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrompter, printHelp } from "./setup.js";

const here = dirname(fileURLToPath(import.meta.url));

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
        const run = spawnSync(process.execPath, ["--import", "tsx", join(here, "index.ts"), "--setup"], {
          input: stdin,
          env: { ...process.env, HOME: home, USERPROFILE: home },
          encoding: "utf8",
          timeout: 30_000,
        });
        assert.equal(run.status, 0, run.stderr);
        assert.doesNotMatch(run.stderr, /ERR_USE_AFTER_CLOSE/);
        assert.ok(existsSync(join(home, ".syntalic", "wallet.json")));
        assert.match(run.stdout, /Add this to ~\/\.claude\/settings\.json/);
        assert.doesNotMatch(run.stdout, /Running: /, "it must not run `claude mcp add` without a yes");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

describe("--help", () => {
  it("lists every tool the server registers", () => {
    const src = readFileSync(join(here, "server.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const tools = [...src.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
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
