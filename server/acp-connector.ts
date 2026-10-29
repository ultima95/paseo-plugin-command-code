import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { extractSystemPrompt, type PromptChannel } from "./system-prompt-mod";

/**
 * The ACP shim exposes a connector extension point precisely so a provider can
 * own its transport. We need that ownership to see `session/update`
 * notifications before the SDK consumes them: Command Code streams subagent
 * progress as plain content blocks on the parent's `task` tool call, and the
 * shim only keeps raw input/output snapshots.
 */
export function createAcpConnector(
  launch: ProviderLaunch | undefined,
  fallback: readonly [string, ...string[]],
  observe: (message: AcpStreamMessage) => void,
  promptChannel?: PromptChannel,
): AcpStream {
  // The channel names a directory, not a file: this function runs once per
  // spawned child, and one file shared across children would let a catalog or
  // discovery child's exit delete the prompt a session child has not read yet.
  const promptFile = promptChannel
    ? join(promptChannel.promptsDir, `${randomUUID()}.md`)
    : undefined;

  // Command Code takes mods after the subcommand (`cmd acp --mod ...`), so they
  // are appended to whatever launch the daemon resolved.
  const baseArgs = launch?.args ?? fallback.slice(1);
  const args = promptChannel && promptFile
    ? [
        ...baseArgs,
        "--mod",
        promptChannel.modPath,
        "--mod-option",
        `system-prompt-file=${promptFile}`,
      ]
    : baseArgs;

  const child = spawnProcess(launch?.command ?? fallback[0], args, {
    env: launch?.env ?? process.env,
    stdio: "pipe",
  });

  // The shim drains stderr in command mode; keep the pipe flowing here too.
  child.stderr.on("data", () => undefined);

  // The staged prompt belongs to this child alone; never leave one behind, and
  // never touch a file this child did not allocate.
  if (promptFile !== undefined) {
    const own = promptFile;
    child.once("close", () => {
      try {
        rmSync(own, { force: true });
      } catch {
        // Ignore: cleanup must never fail a finished session.
      }
    });
  }

  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        try {
          controller.close();
        } catch {
          // The reader already canceled.
        }
      };

      const receive = (line: string) => {
        const text = line.trim();
        if (!text) return;
        let message: AcpStreamMessage;
        try {
          message = JSON.parse(text) as AcpStreamMessage;
        } catch {
          return;
        }
        try {
          observe(message);
        } catch {
          // Observing is best-effort; never drop protocol traffic for it.
        }
        if (finished) return;
        try {
          controller.enqueue(hideQuestionInput(message));
        } catch {
          finished = true;
        }
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          receive(line);
          newline = buffer.indexOf("\n");
        }
      });
      child.stdout.once("end", () => {
        buffer += decoder.decode();
        if (buffer.trim()) receive(buffer);
        buffer = "";
        finish();
      });
      child.stdout.once("error", (error) => {
        if (finished) return;
        finished = true;
        try {
          controller.error(error);
        } catch {
          // The reader already canceled.
        }
      });
      child.once("error", (error) => {
        if (finished) return;
        finished = true;
        try {
          controller.error(error);
        } catch {
          // The reader already canceled.
        }
      });
      child.once("close", finish);
    },
    cancel() {
      void terminateProcess(child).catch(() => undefined);
    },
  });

  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      // The mod reads the file while the child handles the session request, so
      // the file has to land before the request is forwarded.
      if (promptFile !== undefined) {
        const prompt = extractSystemPrompt(message);
        if (prompt) {
          try {
            writeFileSync(promptFile, prompt, "utf8");
          } catch (error) {
            // Best-effort: a prompt we cannot stage must not break the session,
            // but stay diagnosable — the mod will simply append nothing.
            const reason = error instanceof Error ? error.message : String(error);
            process.stderr.write(`command-code: cannot stage system prompt (${reason})\n`);
          }
        }
      }
      if (!child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    close() {
      child.stdin.end();
    },
    abort() {
      void terminateProcess(child).catch(() => undefined);
    },
  });

  return { readable, writable };
}

type JsonRecord = Record<string, unknown>;

/**
 * Paseo renders a permission request's `input` as a raw JSON block. Command
 * Code asks questions through `ask_user_question`, whose question text is
 * already the card title and whose choices are already the action buttons, so
 * the JSON only repeats them. Blank the payload before the shim sees it.
 */
function hideQuestionInput(message: AcpStreamMessage): AcpStreamMessage {
  if (!("method" in message) || !("id" in message)) return message;
  if (message.method !== "session/request_permission") return message;
  const params = asRecord(message.params);
  const toolCall = asRecord(params?.toolCall);
  const rawInput = asRecord(toolCall?.rawInput);
  if (!rawInput || typeof rawInput.question !== "string" || !Array.isArray(rawInput.options)) {
    return message;
  }
  return {
    ...message,
    params: { ...params, toolCall: { ...toolCall, rawInput: {} } },
  };
}

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonRecord;
}
