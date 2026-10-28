import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";

/**
 * Command Code's ACP server has no field for a session system prompt, but its
 * mod API exposes an `appendSystemPrompt` hook. A tiny mod reads the prompt from
 * a file named by a flag, and the transport answers each session start by
 * writing what Paseo put in `_meta._paseo.systemPrompt` to that file.
 *
 * The prompt is read once on the first hook call so every round replays the same
 * bytes; re-reading would let a later session change an earlier one's prompt.
 */
export const SYSTEM_PROMPT_MOD_SOURCE = `import { readFileSync } from "node:fs";
export default function (cmd) {
  cmd.addFlag("system-prompt-file", { type: "string", default: "", description: "File with the Paseo session system prompt" });
  let cached;
  cmd.hooks({
    appendSystemPrompt() {
      if (cached === undefined) {
        const file = cmd.getFlag("system-prompt-file");
        try { cached = file ? readFileSync(file, "utf8") : ""; } catch { cached = ""; }
      }
      return cached || undefined;
    },
  });
}
`;

/** Where the connector finds the mod and the file the mod reads. */
export interface PromptChannel {
  modPath: string;
  promptFile: string;
}

const MOD_FILE_NAME = "system-prompt-mod.mjs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Paseo passes the system prompt to ACP providers through the session metadata,
 * so it only arrives on the request that opens a session. Everything else in the
 * stream — including a `session/prompt` turn and every response — carries no
 * prompt and must not be mistaken for one.
 */
export function extractSystemPrompt(message: AcpStreamMessage): string | undefined {
  if (!("method" in message)) return undefined;
  const method = message.method;
  if (method !== "session/new" && method !== "session/load") return undefined;
  const params = message.params;
  if (!isRecord(params)) return undefined;
  const meta = params._meta;
  if (!isRecord(meta)) return undefined;
  const paseo = meta._paseo;
  if (!isRecord(paseo)) return undefined;
  const prompt = paseo.systemPrompt;
  return typeof prompt === "string" && prompt.length > 0 ? prompt : undefined;
}

/**
 * Keep the mod on disk in sync with the source compiled into this plugin, so an
 * upgraded plugin never runs a stale mod. Returns the path the CLI should load.
 */
export async function ensureModFile(dir: string): Promise<string> {
  const file = join(dir, MOD_FILE_NAME);
  const existing = await readFile(file, "utf8").catch(() => undefined);
  if (existing === SYSTEM_PROMPT_MOD_SOURCE) return file;
  await mkdir(dir, { recursive: true });
  await writeFile(file, SYSTEM_PROMPT_MOD_SOURCE, "utf8");
  return file;
}
