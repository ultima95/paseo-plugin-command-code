import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpConnector } from "./acp-connector";
import {
  SYSTEM_PROMPT_MOD_SOURCE,
  ensureModFile,
  extractSystemPrompt,
} from "./system-prompt-mod";

const scratch: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-system-prompt-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function request(method: string, params?: unknown): AcpStreamMessage {
  return { jsonrpc: "2.0", id: 1, method, params } as AcpStreamMessage;
}

function metaPrompt(prompt: unknown): unknown {
  return { cwd: "/tmp", mcpServers: [], _meta: { _paseo: { systemPrompt: prompt } } };
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met before timeout");
}

describe("SYSTEM_PROMPT_MOD_SOURCE", () => {
  it("is a plain-JS mod that appends a prompt read from a flag", () => {
    expect(SYSTEM_PROMPT_MOD_SOURCE).toContain("appendSystemPrompt");
    expect(SYSTEM_PROMPT_MOD_SOURCE).toContain('addFlag("system-prompt-file"');
    expect(SYSTEM_PROMPT_MOD_SOURCE).toContain("system-prompt-file");
    expect(SYSTEM_PROMPT_MOD_SOURCE).toContain("export default function");
  });
});

describe("extractSystemPrompt", () => {
  it("reads the prompt a session/new request carries", () => {
    expect(extractSystemPrompt(request("session/new", metaPrompt("ROLE")))).toBe("ROLE");
  });

  it("reads the prompt a session/load request carries", () => {
    expect(extractSystemPrompt(request("session/load", metaPrompt("ROLE")))).toBe("ROLE");
  });

  it("ignores a session/prompt request", () => {
    expect(extractSystemPrompt(request("session/prompt", metaPrompt("ROLE")))).toBeUndefined();
  });

  it("ignores a response even when it carries the prompt shape", () => {
    expect(
      extractSystemPrompt({
        jsonrpc: "2.0",
        id: 1,
        result: metaPrompt("ROLE"),
      } as AcpStreamMessage),
    ).toBeUndefined();
  });

  it("ignores a session/new request without metadata", () => {
    expect(
      extractSystemPrompt(request("session/new", { cwd: "/tmp", mcpServers: [] })),
    ).toBeUndefined();
  });

  it("ignores a session/new request without the Paseo namespace", () => {
    expect(extractSystemPrompt(request("session/new", { _meta: {} }))).toBeUndefined();
  });

  it("ignores a non-string prompt", () => {
    expect(extractSystemPrompt(request("session/new", metaPrompt({ role: "x" })))).toBeUndefined();
    expect(extractSystemPrompt(request("session/new", metaPrompt(42)))).toBeUndefined();
  });

  it("ignores an empty prompt", () => {
    expect(extractSystemPrompt(request("session/new", metaPrompt("")))).toBeUndefined();
  });

  it("survives params that are not an object", () => {
    expect(extractSystemPrompt(request("session/new", "nope"))).toBeUndefined();
    expect(extractSystemPrompt(request("session/new"))).toBeUndefined();
  });
});

describe("ensureModFile", () => {
  it("writes the mod source and returns its path", async () => {
    const dir = await makeDir();
    const file = await ensureModFile(dir);
    expect(file).toBe(join(dir, "system-prompt-mod.mjs"));
    await expect(readFile(file, "utf8")).resolves.toBe(SYSTEM_PROMPT_MOD_SOURCE);
  });

  it("leaves an identical file untouched", async () => {
    const dir = await makeDir();
    const file = await ensureModFile(dir);
    const first = await stat(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ensureModFile(dir);
    const second = await stat(file);
    expect(second.mtimeMs).toBe(first.mtimeMs);
  });

  it("rewrites a file whose content differs", async () => {
    const dir = await makeDir();
    const file = join(dir, "system-prompt-mod.mjs");
    await writeFile(file, "// stale mod\n", "utf8");
    expect(await ensureModFile(dir)).toBe(file);
    await expect(readFile(file, "utf8")).resolves.toBe(SYSTEM_PROMPT_MOD_SOURCE);
  });

  it("creates the directory when it is missing", async () => {
    const parent = await makeDir();
    const dir = join(parent, "plugin-data", "command-code");
    const file = await ensureModFile(dir);
    expect(existsSync(file)).toBe(true);
  });
});

describe("createAcpConnector prompt channel", () => {
  const describeUnix = process.platform === "win32" ? describe.skip : describe;

  async function startConnector(promptChannel?: { modPath: string; promptFile: string }) {
    const dir = await makeDir();
    const script = join(dir, "child.mjs");
    await writeFile(
      script,
      [
        'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "child/argv", params: { argv: process.argv.slice(2) } }) + "\\n");',
        'let buffer = "";',
        "process.stdin.on(\"data\", (chunk) => {",
        "  buffer += chunk.toString();",
        '  let index = buffer.indexOf("\\n");',
        "  while (index >= 0) {",
        "    const line = buffer.slice(0, index);",
        "    buffer = buffer.slice(index + 1);",
        "    if (line.trim()) process.stdout.write(`${line}\\n`);",
        '    index = buffer.indexOf("\\n");',
        "  }",
        "});",
        "process.stdin.on(\"end\", () => process.exit(0));",
        "",
      ].join("\n"),
      "utf8",
    );
    const stream = createAcpConnector(
      { command: process.execPath, args: [script], env: { ...process.env } as Record<string, string> },
      ["cmd", "acp"],
      () => undefined,
      promptChannel,
    );
    const reader = stream.readable.getReader();
    const seen: AcpStreamMessage[] = [];
    const next = async (method: string): Promise<AcpStreamMessage> => {
      for (;;) {
        const existing = seen.find((message) => "method" in message && message.method === method);
        if (existing) return existing;
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${method}`);
        seen.push(value);
      }
    };
    return { stream, reader, next };
  }

  describeUnix("forwards the prompt it extracts", () => {
    it("passes the mod flags, writes the prompt before forwarding, and cleans up", async () => {
      const dir = await makeDir();
      const modPath = join(dir, "system-prompt-mod.mjs");
      const promptDir = join(dir, "prompts");
      await mkdir(promptDir, { recursive: true });
      const promptFile = join(promptDir, "session.md");
      const { stream, reader, next } = await startConnector({ modPath, promptFile });

      const argv = await next("child/argv");
      expect((argv as { params: { argv: string[] } }).params.argv).toEqual([
        "--mod",
        modPath,
        "--mod-option",
        `system-prompt-file=${promptFile}`,
      ]);

      const writer = stream.writable.getWriter();
      await writer.write(request("session/prompt", metaPrompt("IGNORED")) as AcpStreamMessage);
      expect(existsSync(promptFile)).toBe(false);

      await writer.write(request("session/new", metaPrompt("ROLE")) as AcpStreamMessage);
      expect(existsSync(promptFile)).toBe(true);
      await expect(readFile(promptFile, "utf8")).resolves.toBe("ROLE");

      // The child echoes the forwarded request, so the write reached it too.
      await next("session/new");

      await writer.close();
      await waitFor(() => !existsSync(promptFile));
      await reader.cancel().catch(() => undefined);
    });

    it("spawns without mod flags when no prompt channel is given", async () => {
      const { stream, reader, next } = await startConnector();
      const argv = await next("child/argv");
      expect((argv as { params: { argv: string[] } }).params.argv).toEqual([]);
      await stream.writable.getWriter().close();
      await reader.cancel().catch(() => undefined);
    });
  });
});
