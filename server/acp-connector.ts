import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { extractSystemPrompt, type PromptChannel } from "./system-prompt-mod";

/**
 * The per-child question folders live under one base directory; the bridge
 * watches only the folders it is told about, and the folder is removed with the
 * child that owns it.
 */
export interface QuestionChannel {
  dir: string;
  register(dir: string): void;
  unregister(dir: string): void;
}

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
  questionChannel?: QuestionChannel,
): AcpStream {
  // The channel names a directory, not a file: this function runs once per
  // spawned child, and one file shared across children would let a catalog or
  // discovery child's exit delete the prompt a session child has not read yet.
  const promptFile = promptChannel
    ? join(promptChannel.promptsDir, `${randomUUID()}.md`)
    : undefined;

  // Each child gets its own question folder, allocated here so it can never
  // collide with another child's in-flight question or cleanup.
  const questionDir =
    promptChannel && questionChannel
      ? join(questionChannel.dir, randomUUID())
      : undefined;
  if (questionDir !== undefined) {
    mkdirSync(questionDir, { recursive: true });
    questionChannel?.register(questionDir);
  }

  // Command Code takes mods after the subcommand (`cmd acp --mod ...`), so they
  // are appended to whatever launch the daemon resolved.
  const baseArgs = launch?.args ?? fallback.slice(1);
  const modArgs: string[] = [];
  if (promptChannel && promptFile) {
    modArgs.push(
      "--mod",
      promptChannel.modPath,
      "--mod-option",
      `system-prompt-file=${promptFile}`,
    );
  }
  if (questionDir !== undefined) {
    modArgs.push("--mod-option", `question-dir=${questionDir}`);
  }
  const args = modArgs.length > 0 ? [...baseArgs, ...modArgs] : baseArgs;

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

  // Same rule for the question folder: a closing child drops only its own.
  if (questionDir !== undefined) {
    const own = questionDir;
    child.once("close", () => {
      questionChannel?.unregister(own);
      try {
        rmSync(own, { recursive: true, force: true });
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
          controller.enqueue(addPaseoCommands(hideQuestionInput(message)));
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

/**
 * Command Code's ACP `listCommands` drops every built-in slash command, and a
 * mod command that reuses a built-in name is deduped from the menu before that
 * filter runs. The staged mod still resolves these names (its commands are in
 * the mod host), so advertise them in the command update the shim turns into
 * Paseo's slash menu.
 */
export const PASEO_COMMANDS = [
  { name: "help", description: "Explain which Command Code commands Paseo supports" },
  { name: "init", description: "Create or update AGENTS.md for this project" },
  { name: "review", description: "Review a pull request or the current branch changes" },
  { name: "btw", description: "Ask a quick side question (runs as a normal turn in Paseo)" },
] as const;

export function addPaseoCommands(message: AcpStreamMessage): AcpStreamMessage {
  if (!("method" in message) || message.method !== "session/update") return message;
  const params = asRecord(message.params);
  const update = asRecord(params?.update);
  if (!update || update.sessionUpdate !== "available_commands_update") return message;
  const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
  const names = new Set(
    commands
      .map((command) => asRecord(command)?.name)
      .filter((name): name is string => typeof name === "string"),
  );
  const missing = PASEO_COMMANDS.filter((command) => !names.has(command.name));
  if (missing.length === 0) return message;
  return {
    ...message,
    params: {
      ...params,
      update: {
        ...update,
        availableCommands: [
          ...commands,
          ...missing.map((command) => ({
            name: command.name,
            description: command.description,
            input: { hint: "arguments" },
          })),
        ],
      },
    },
  };
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
