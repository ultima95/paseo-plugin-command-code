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
 * An empty read is not cached: a child whose first hook call lands before the
 * session request wrote the file (or whose scan finds the file missing) must
 * read again on the next call instead of memoizing "no prompt" for the session.
 *
 * The same mod answers `ask_user_question`. Command Code's ACP permission path
 * can only return one of the option ids it sent, so the tool itself would never
 * see free text. Blocking the call in `beforeToolCall` and writing the question
 * to a per-child folder lets the plugin render Paseo's question form, which has
 * an "Other" field and a Dismiss action, then hand the answer back as the tool
 * result.
 */
export const SYSTEM_PROMPT_MOD_SOURCE = `import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default function (cmd) {
  cmd.addFlag("system-prompt-file", { type: "string", default: "", description: "File with the Paseo session system prompt" });
  cmd.addFlag("question-dir", { type: "string", default: "", description: "Folder for Paseo question requests and answers" });
  let cached;
  let sessionId = "";
  if (cmd.on) {
    cmd.on("run_start", (event) => {
      if (event && typeof event.sessionId === "string") sessionId = event.sessionId;
    });
  }
  cmd.addCommand({
    name: "help",
    description: "Explain which Command Code commands Paseo supports",
    handler: () => ({ message: helpText() }),
  });
  cmd.addCommand({
    name: "init",
    description: "Create or update AGENTS.md for this project",
    handler: ({ args }) => ({ prompt: initPrompt(args) }),
  });
  cmd.addCommand({
    name: "review",
    description: "Review a pull request or the current branch changes",
    argumentHint: "[PR]",
    handler: ({ args }) => ({ prompt: reviewPrompt(args.trim()) }),
  });
  cmd.addCommand({
    name: "btw",
    description: "Ask a quick side question (runs as a normal turn in Paseo)",
    argumentHint: "<question>",
    handler: ({ args }) => {
      const question = args.trim();
      return question ? { prompt: question } : { message: "Usage: /btw <question>" };
    },
  });
  cmd.hooks({
    appendSystemPrompt() {
      if (cached === undefined || cached === "") {
        const file = cmd.getFlag("system-prompt-file");
        try { cached = file ? readFileSync(file, "utf8") : ""; } catch { cached = ""; }
      }
      return cached || undefined;
    },
    async beforeToolCall({ toolCallId, toolName, input, signal }) {
      if (toolName !== "ask_user_question") return undefined;
      const dir = cmd.getFlag("question-dir");
      if (!dir) return undefined;
      const id = String(toolCallId || "").replace(/[^A-Za-z0-9_.-]/g, "_");
      if (!id) return undefined;
      const questions = input && Array.isArray(input.questions) ? input.questions : [];
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "request-" + id + ".json"), JSON.stringify({
          id,
          sessionId,
          questions,
          hideCustomInput: Boolean(input && input.hideCustomInput === true),
        }), "utf8");
      } catch {
        return undefined;
      }
      const answerFile = join(dir, "answer-" + id + ".json");
      const deadline = Date.now() + 30 * 60 * 1000;
      while (Date.now() < deadline) {
        if (signal && signal.aborted) {
          return { result: [{ type: "text", text: "The user cancelled the question." }] };
        }
        let raw;
        try {
          raw = readFileSync(answerFile, "utf8");
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 120));
          continue;
        }
        try { unlinkSync(answerFile); } catch {}
        return { result: [{ type: "text", text: answerText(questions, raw) }] };
      }
      return { result: [{ type: "text", text: "The user did not answer the question." }] };
    },
  });
}
function answerText(questions, raw) {
  let payload = null;
  try { payload = JSON.parse(raw); } catch {}
  if (payload && payload.cancelled) return "User declined to answer questions";
  const answers = payload && typeof payload.answers === "object" && payload.answers !== null ? payload.answers : {};
  const lines = [];
  for (const question of questions) {
    if (!question || typeof question !== "object") continue;
    const header = typeof question.header === "string" ? question.header : "";
    const value = header && typeof answers[header] === "string" ? answers[header].trim() : "";
    if (!value) continue;
    const text = typeof question.question === "string" && question.question ? question.question : header;
    lines.push(text + " \\u2192 " + value);
  }
  if (lines.length === 0) return "User declined to answer questions";
  return lines.join("\\n");
}
function helpText() {
  return [
    "Command Code's terminal-only commands (/login, /logout, /theme, /language, /statusline, /model, /effort, /mode, /usage, /upgrade, /sessions, /resume, /rewind, /tree, /clear, /exit, /config, /mcp, /agents, /memory, /provider, /skills, /mods, /plans, /todos, /copy, /export, /share, /trace, /status, /context, /goal) run inside the Command Code TUI and are not reachable over the Agent Client Protocol.",
    "Use Paseo for their equivalents: the composer selects model, effort, and permission mode; the usage view shows plan limits; the workspace and agent list handle sessions and history.",
    "Commands available in this session: /help, /init, /review [PR], /btw <question>, /compact.",
  ].join("\\n");
}
function initPrompt(args) {
  const extra = args.trim();
  return [
    "Initialize repository guidance for future agents.",
    "Explore the codebase first, then create or update AGENTS.md at the repository root.",
    "Cover what the project is, how to build, test, and typecheck, the architecture and module boundaries, code style and conventions, and any non-obvious workflows or gotchas.",
    "Cite exact commands, keep it concise and actionable, and preserve correct existing content instead of rewriting it. If AGENTS.md already exists, merge your findings into it.",
    extra ? "Extra instructions from the user: " + extra : "",
  ].filter(Boolean).join("\\n\\n");
}
function reviewPrompt(target) {
  const subject = target
    ? "pull request " + target + ". Gather context with gh pr view " + target + " and gh pr diff " + target
    : "the current branch's changes. Gather context with git status, git diff, and git log against the repository's default branch";
  return [
    "Review " + subject + ".",
    "Report only real defects: correctness, security, data loss, broken edge cases, and regressions. Ignore style preferences.",
    "For each finding give file:line, the problem, why it is wrong, and a concrete fix. Order findings by severity. If you find nothing, say so plainly.",
  ].join("\\n\\n");
}
`;

/**
 * Where the connector finds the mod, and the directory it stages one prompt file
 * per spawned child in. The file itself is allocated inside the connector: one
 * provider connection runs a connector per child, and a file shared by all of
 * them would let any child's exit delete the prompt another child's mod has not
 * read yet.
 */
export interface PromptChannel {
  modPath: string;
  promptsDir: string;
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
