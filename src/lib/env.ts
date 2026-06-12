/**
 * Env vars were renamed CRUSH_* → SYNTALIC_* in v0.6.0 (the package predates
 * the Syntalic rebrand). SYNTALIC_* wins when both prefixes are set; legacy
 * CRUSH_* still works but emits a one-time deprecation note on stderr.
 */

export interface EnvVar {
  /** Resolved value, or undefined when neither prefix is set. */
  value: string | undefined;
  /** Name of the variable that supplied the value; SYNTALIC_* when unset. */
  name: string;
}

const warnedSuffixes = new Set<string>();

export function readEnv(suffix: string): EnvVar {
  const currentName = `SYNTALIC_${suffix}`;
  const current = process.env[currentName];
  if (current !== undefined) {
    return { value: current, name: currentName };
  }
  const legacyName = `CRUSH_${suffix}`;
  const legacy = process.env[legacyName];
  if (legacy !== undefined) {
    if (!warnedSuffixes.has(suffix)) {
      warnedSuffixes.add(suffix);
      console.error(
        `[syntalic-mcp] ${legacyName} is deprecated — rename it to ${currentName}.`,
      );
    }
    return { value: legacy, name: legacyName };
  }
  return { value: undefined, name: currentName };
}
