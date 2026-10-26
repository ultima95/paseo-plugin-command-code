Runs Command Code agents inside Paseo as a provider, so a Command Code session sits beside your Claude Code, Codex, and other agents with the same worktrees, diffs, terminals, and mobile clients.

Command Code exposes its agent over the Agent Client Protocol on stdio. This plugin registers that ACP server as a Paseo provider, so Paseo owns the process and session lifecycle and Command Code keeps supplying the models, modes, and tools.

Setup: install the Command Code CLI on the daemon machine (`npm i -g command-code`) and sign in once with `cmd login`. The provider appears in the model picker as Command Code. For headless or CI daemons, set `COMMAND_CODE_API_KEY` instead of signing in. The plugin looks for the CLI as `cmd` (or `cmdc` on Windows) and reports it as unavailable when the binary or the login is missing.

Command Code's own model catalog, reasoning effort options, and permission modes (Standard, Accept Edits, Plan, Don't Ask, Bypass Permissions) are available in the composer, along with image prompts. Sessions persist and can be resumed, because the ACP server supports session load and resume. Paseo tools are not injected: the agent uses its own tools, and file edits and shell commands flow through Paseo's normal permission prompts.

The plugin reads `~/.commandcode/auth.json` only to check whether a login exists; it never reads or sends its contents. To point at a different binary or environment, set `command` or `env` under `agents.providers.command-code` in `~/.paseo/config.json`.
