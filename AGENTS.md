# Memory

## Project Overview

Paseo plugin that registers Command Code as an ACP provider, so Paseo can run Command Code agents with its own worktrees, permissions, timeline, and subagent view. See @README.md for installation and configuration, and @OVERVIEW.md for the user-facing behavior.

The plugin runs inside Paseo's daemon. Paseo supplies `@getpaseo/plugin` and `zod` at runtime; they are dev dependencies here only for local typechecking.

## Code Style Guidelines

- TypeScript with native ESM, `strict` mode, and `moduleResolution: "Bundler"`.
- Import Node built-ins with the `node:` prefix and extensions omitted for local modules.
- Follow the existing per-module pattern: a class or factory with small private helpers, and exported constructors only where the entry point needs them.
- Keep changes socketed into the Paseo SDK contracts; do not reimplement session lifecycle, permissions, or timeline conversion that the ACP shim already owns.
- Comments are reserved for non-obvious protocol or host behavior, such as camelCase field normalization and per-child prompt files. Do not narrate straightforward code.
- No new runtime dependencies unless the SDK cannot cover the need.
- Tests live beside the module as `server/*.test.ts` and use Vitest with `vi.stubGlobal` for network or process boundaries.

## Architecture Notes

- `index.server.ts` registers both contributions: the provider and the usage source.
- `server/provider.ts` wraps `runAcpProvider`, resolves the `cmd`/`cmdc` binary, normalizes ACP tool inputs and failed calls, and prepares the system-prompt channel.
- `server/acp-connector.ts` owns the stdio transport so the plugin can observe `session/update` messages before the SDK consumes them; it also stages one prompt file per spawned child.
- `server/subagents.ts` projects Command Code's single `task` tool call into synthetic Paseo child sessions with their own timelines.
- `server/tool-calls.ts` replays tool calls as typed timeline items because Paseo's shim only derives edit and unknown details from `rawInput`.
- `server/system-prompt-mod.ts` contains the Command Code mod source; the mod reads the staged prompt file in its `appendSystemPrompt` hook.
- `server/usage.ts` reads Command Code's billing endpoints and maps them to Paseo usage windows, balances, and details. Credits are a pinnable window; org spend limits stay balances.
- ACP notifications are JSON-RPC over newline-delimited stdio. Paseo renders tool rows by call id and prefers typed details over the shim's `unknown` ones.

## Common Workflows

```bash
npm install --include=dev   # needed for typechecking and tests
npm test
npm run typecheck
```

Install and inspect the plugin on a daemon:

```bash
paseo plugin install /absolute/path/to/command-code-provider
paseo plugin reload command-code
paseo plugin logs command-code
```

The provider can be overridden with `command` and `env` under `agents.providers.command-code` in `~/.paseo/config.json`. Usage reads `COMMAND_CODE_API_KEY` or `~/.commandcode/auth.json`.
