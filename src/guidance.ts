import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PLAYBOOKS, RULES, type Playbook } from "./playbooks.generated.js";

/**
 * What a client is told at connection: sent as the server's `instructions`, which most clients
 * add to the model's context. Short on purpose: the rules are a resource and the procedures are
 * prompts, so this only says where they are and the three things that cost the most when missed.
 */
export const SERVER_INSTRUCTIONS =
  "Syntalic prices, brands and shelves. Free: ontology_resolve (what a name means: ids, " +
  "coverage, and suggested_next_calls), ontology_neighbors, ontology_coverage, and the catalog " +
  "discovery tools. Every paid tool states its cost in its description. " +
  "When a question names a brand, category, product type, retailer or product, call " +
  "ontology_resolve once per conversation (one concept per term) and scope the paid calls with the " +
  "ids it returns (spt, gpc, brand_id) instead of guessed names. A name that fits several things " +
  "returns all of them as co-equals: never pick one silently. Say 'not seen at X' only when X is in " +
  "retailers_scanned. The ontology tools need a free API key in SYNTALIC_API_KEY. " +
  "Read the resource syntalic://ontology/rules for the six rules, and use the playbook prompts " +
  "(position-on-shelf, diagnose-price-move, promo-pressure, retail-coverage, category-brief, " +
  "buyer-pitch) for questions that take more than one call.";

const MARKDOWN = "text/markdown";

function promptText(p: Playbook, question: string | undefined): string {
  const head = `Playbook: ${p.name}. Follow it for this question. The tools it names are this server's.`;
  const ask = question?.trim() ? `\n\nThe question: ${question.trim()}\n` : "";
  return `${head}\n\n${p.text}${ask}`;
}

function indexText(): string {
  const lines = PLAYBOOKS.map((p) => `- **${p.name}** (syntalic://playbooks/${p.name}): ${p.description}`);
  return `# Playbooks\n\nProcedures for questions that take more than one call. Each is also a prompt of the same name.\n\n${lines.join("\n")}\n`;
}

/**
 * The playbooks as prompts and resources, and the six ontology rules as one resource. The text
 * is rendered from shared/playbooks in the Syntalic repository (src/playbooks.generated.ts), the
 * same sources Eve's skills are rendered from, so the two surfaces give the same advice.
 */
export function registerGuidance(server: McpServer): void {
  for (const p of PLAYBOOKS) {
    server.registerPrompt(
      p.name,
      {
        title: p.name,
        description: p.description,
        argsSchema: {
          question: z.string().optional().describe("The user's question, to quote beside the playbook."),
        },
      },
      ({ question }) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: promptText(p, question) } }],
      }),
    );
  }

  server.registerResource(
    "ontology-rules",
    "syntalic://ontology/rules",
    {
      title: "The six rules for using the ontology tools",
      description: RULES.description,
      mimeType: MARKDOWN,
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: MARKDOWN, text: RULES.text }] }),
  );

  server.registerResource(
    "playbooks-index",
    "syntalic://playbooks",
    {
      title: "Playbooks",
      description: "The playbooks, each with its 'use when' line.",
      mimeType: MARKDOWN,
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: MARKDOWN, text: indexText() }] }),
  );

  for (const p of PLAYBOOKS) {
    server.registerResource(
      `playbook-${p.name}`,
      `syntalic://playbooks/${p.name}`,
      { title: p.name, description: p.description, mimeType: MARKDOWN },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: MARKDOWN, text: p.text }] }),
    );
  }
}
