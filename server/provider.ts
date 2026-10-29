import { AsyncLocalStorage } from "node:async_hooks";
import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  AcpConnector,
  AcpToolCallSnapshot,
  AcpTransformer,
} from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnectRequest,
  ProviderLaunch,
  ProviderRegistration,
  ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { createAcpConnector } from "./acp-connector";
import { SubagentBridge } from "./subagents";
import { ensureModFile, type PromptChannel } from "./system-prompt-mod";
import { ToolCallProjector } from "./tool-calls";

/**
 * Command Code ships its CLI as `cmd` everywhere except Windows, where `cmd` is
 * the shell; the package installs `cmdc` there as well. Both entries run the
 * same program.
 */
const CLI = process.platform === "win32" ? "cmdc" : "cmd";

/**
 * Command Code reports a failed tool call with the error text only in the ACP
 * `content` blocks and no `rawOutput`. Paseo derives a failed call's error from
 * its raw output, so the timeline item would carry `error: null`, which the
 * wire schema rejects and the client reports as a failed timeline fetch. Give
 * failed calls without output a message so the item stays valid.
 */
const normalizeFailedToolCalls: AcpTransformer = {
  toolCall(toolCall: AcpToolCallSnapshot): AcpToolCallSnapshot {
    if (toolCall.status !== "failed" || toolCall.output != null) return toolCall;
    return { ...toolCall, output: { message: "Tool call failed" } };
  },
};

/**
 * Command Code names edit inputs `file_path`, `old_string`, `new_string`, and a
 * write's payload `content`. Paseo's shim only reads the camelCase spellings,
 * so it built an empty diff and the card said "No changes to display". Mirror
 * the fields the shim looks for, and turn a write's content into an all-added
 * diff.
 */
const normalizeEditInputs: AcpTransformer = {
  toolCall(toolCall: AcpToolCallSnapshot): AcpToolCallSnapshot {
    if (toolCall.kind !== "edit") return toolCall;
    const input = asRecord(toolCall.input);
    if (!input) return toolCall;

    const filePath =
      firstString(input.filePath, input.file_path, input.path) ?? toolCall.locations[0];
    const isWrite =
      input.content !== undefined && input.old_string === undefined && input.new_string === undefined;
    const oldString =
      firstString(input.oldString, input.old_string) ?? (isWrite ? "" : undefined);
    const newString =
      firstString(input.newString, input.new_string) ?? (isWrite ? firstString(input.content) : undefined);

    return {
      ...toolCall,
      input: {
        ...input,
        ...(filePath ? { filePath } : {}),
        ...(oldString !== undefined ? { oldString } : {}),
        ...(newString !== undefined ? { newString } : {}),
      },
    };
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Command Code's ACP server advertises a single auth method: the account saved
 * by `cmd login`. Automation setups can authenticate with an API key instead.
 * Neither is checked by opening a session, so we look for evidence locally and
 * only use it to explain the state, never to hide the provider.
 */
async function isSignedIn(): Promise<boolean> {
  if (process.env.COMMAND_CODE_API_KEY) return true;
  try {
    await access(join(homedir(), ".commandcode", "auth.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * A connector runs inside the provider connection that created it. The store
 * carries that connection's launch, subagent bridge, and prompt channel into the
 * transport.
 */
const connectionState = new AsyncLocalStorage<{
  bridge: SubagentBridge;
  tools: ToolCallProjector;
  launch?: ProviderLaunch;
  promptChannel?: PromptChannel;
}>();

const connector: AcpConnector = () => {
  const state = connectionState.getStore();
  if (!state) {
    throw new Error("Command Code ACP connector started outside a provider connection");
  }
  return createAcpConnector(
    state.launch,
    [CLI, "acp"],
    (message) => {
      state.bridge.observe(message);
      state.tools.observe(message);
    },
    state.promptChannel,
  );
};

const acp = runAcpProvider({
  id: "command-code",
  label: "Command Code",
  description: "Command Code's coding agent, driven over the Agent Client Protocol.",
  icon: "icon.svg",
  connector,
  transformers: [normalizeFailedToolCalls, normalizeEditInputs],
});

/**
 * Command Code has no ACP field for a system prompt, so each connection stages
 * the prompt through a mod: the plugin keeps one mod file in its data directory,
 * and the connector allocates one fresh prompt file per spawned child inside the
 * prompts directory created here.
 */
function pluginDataDir(): string {
  return join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "command-code");
}

async function preparePromptChannel(): Promise<PromptChannel | undefined> {
  try {
    const dir = pluginDataDir();
    const modPath = await ensureModFile(dir);
    const promptsDir = join(dir, "prompts");
    // Created here, once per connection; the per-child files are the connector's.
    await mkdir(promptsDir, { recursive: true });
    return { modPath, promptsDir };
  } catch (error) {
    // Losing the prompt is much better than losing the provider entirely.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`command-code: system prompt channel unavailable (${message})\n`);
    return undefined;
  }
}

/**
 * Command Code runs its agent over ACP on stdio, so Paseo's ACP shim owns the
 * session lifecycle, permissions, and timeline conversion. We own the transport
 * because Command Code has no ACP child sessions: the connector observes the
 * `task` tool updates and the bridge projects each one into a Paseo subagent.
 * `command` stays declared so the daemon still resolves config overrides into
 * the launch the connector receives.
 */
export function createProvider(): ProviderRegistration {
  return {
    ...acp,
    command: [CLI, "acp"],

    async connect(request: ProviderConnectRequest) {
      const bridge = new SubagentBridge();
      const tools = new ToolCallProjector();
      const state = {
        bridge,
        tools,
        launch: request.launch,
        promptChannel: await preparePromptChannel(),
      };
      const run = <T>(operation: () => Promise<T>) => connectionState.run(state, operation);
      const connection = await run(() => acp.connect(request));
      return tools.wrap(bridge.wrap(connection, run), run);
    },

    async status({ launch }): Promise<ProviderStatus> {
      const command = launch?.command ?? CLI;
      let version = "";
      try {
        const { stdout } = await execCommand(command, ["--version"], {
          env: launch?.env ?? process.env,
          timeout: 5_000,
        });
        version = stdout.trim().split("\n")[0]?.trim() ?? "";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          available: false,
          diagnostic:
            `Cannot run \`${command}\` (${message}). Install Command Code on the daemon machine with ` +
            "`npm i -g command-code`.",
        };
      }

      const label = version ? `Command Code ${version}` : "Command Code";
      return {
        available: true,
        diagnostic: (await isSignedIn())
          ? label
          : `${label} is installed but not signed in. Run \`cmd login\` on the daemon machine, or set COMMAND_CODE_API_KEY.`,
      };
    },
  };
}
