# Paseo Command Code provider

Adds [Command Code](https://commandcode.ai) as a provider in [Paseo](https://paseo.sh).

Command Code's CLI ships an Agent Client Protocol server (`cmd acp`), and Paseo has a
first-class ACP shim (`runAcpProvider`). This plugin is a thin registration: Paseo owns the
process, session lifecycle, permissions, and timeline conversion, and Command Code supplies
the models, modes, and tools.

## Requirements

- Paseo 0.12.0 or later on the daemon.
- The Command Code CLI on the daemon machine, signed in:

  ```bash
  npm i -g command-code
  cmd login
  ```

  For unattended daemons, set `COMMAND_CODE_API_KEY` instead of running `cmd login`.

## Install

```bash
paseo plugin install /absolute/path/to/command-code-provider
paseo plugin ls
```

The provider id is `command-code`. Pick it in the model picker, or set it as a default via
`agents.providers`.

## What you get

- **Models and effort**: Command Code's catalog and reasoning-effort options appear in the
  composer. The list is discovered from the running CLI, so it stays current with your plan.
- **Modes**: Standard, Accept Edits, Plan, Don't Ask, and Bypass Permissions.
- **Persistence**: the ACP server supports session load and resume, so agents reopen where
  they left off.
- **Permissions**: file edits and shell commands surface as normal Paseo permission prompts.
- **Images**: image prompts are supported; audio is not.

## Configuration

Override the launch command or environment in `~/.paseo/config.json`, then run `paseo reload`:

```json
{
  "agents": {
    "providers": {
      "command-code": {
        "command": ["cmd", "acp"],
        "env": { "COMMAND_CODE_API_KEY": "..." }
      }
    }
  }
}
```

## Development

```bash
npm install --include=dev   # dev dependencies are needed for typechecking
npm run typecheck
paseo plugin install /absolute/path/to/command-code-provider
paseo plugin reload command-code
paseo plugin logs command-code
```

Paseo supplies the runtime modules (`@getpaseo/plugin`, `zod`); they are development
dependencies here only so the plugin typechecks locally.

## Layout

```
paseo-plugin.json     plugin manifest
index.server.ts       server entry, registers the provider
server/provider.ts    the ACP provider registration and status probe
icon.svg              provider icon
```
