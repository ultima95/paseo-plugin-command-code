import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";

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
): AcpStream {
  const child = spawnProcess(launch?.command ?? fallback[0], launch?.args ?? fallback.slice(1), {
    env: launch?.env ?? process.env,
    stdio: "pipe",
  });

  // The shim drains stderr in command mode; keep the pipe flowing here too.
  child.stderr.on("data", () => undefined);

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
          controller.enqueue(message);
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
