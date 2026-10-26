import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execCommand } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration, ProviderStatus } from "@getpaseo/plugin/server/provider";

/**
 * Command Code ships its CLI as `cmd` everywhere except Windows, where `cmd` is
 * the shell; the package installs `cmdc` there as well. Both entries run the
 * same program.
 */
const CLI = process.platform === "win32" ? "cmdc" : "cmd";

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
 * Command Code runs its agent over ACP on stdio, so Paseo's ACP shim owns the
 * process, session lifecycle, permissions, and timeline conversion. We only
 * declare the launch command and add a status probe.
 */
export function createProvider(): ProviderRegistration {
  return {
    ...runAcpProvider({
      id: "command-code",
      label: "Command Code",
      description: "Command Code's coding agent, driven over the Agent Client Protocol.",
      icon: "icon.svg",
      command: [CLI, "acp"],
    }),

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
