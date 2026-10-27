import { AsyncLocalStorage } from "node:async_hooks";
import { access } from "node:fs/promises";
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
 * carries that connection's launch and subagent bridge into the transport.
 */
const connectionState = new AsyncLocalStorage<{
  bridge: SubagentBridge;
  launch?: ProviderLaunch;
}>();

const connector: AcpConnector = () => {
  const state = connectionState.getStore();
  if (!state) {
    throw new Error("Command Code ACP connector started outside a provider connection");
  }
  return createAcpConnector(state.launch, [CLI, "acp"], (message) =>
    state.bridge.observe(message),
  );
};

const acp = runAcpProvider({
  id: "command-code",
  label: "Command Code",
  description: "Command Code's coding agent, driven over the Agent Client Protocol.",
  icon: "icon.svg",
  connector,
  transformers: [normalizeFailedToolCalls],
});

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
      const state = { bridge, launch: request.launch };
      const connection = await connectionState.run(state, () => acp.connect(request));
      return bridge.wrap(connection, (operation) => connectionState.run(state, operation));
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
