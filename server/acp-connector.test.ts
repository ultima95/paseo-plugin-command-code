import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { describe, expect, it } from "vitest";
import { addPaseoCommands } from "./acp-connector";

function commandUpdate(commands: Array<{ name: string; description?: string }>): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: commands.map((command) => ({
          name: command.name,
          description: command.description ?? "",
          input: { hint: "arguments" },
        })),
      },
    },
  } as AcpStreamMessage;
}

function names(message: AcpStreamMessage): string[] {
  const update = (message as { params: { update: { availableCommands: Array<{ name: string }> } } })
    .params.update;
  return update.availableCommands.map((command) => command.name);
}

describe("addPaseoCommands", () => {
  it("advertises the commands the ACP server filters out", () => {
    const message = addPaseoCommands(commandUpdate([{ name: "compact" }]));
    expect(names(message)).toEqual(["compact", "help", "init", "review", "btw"]);
    const update = (
      message as {
        params: {
          update: {
            availableCommands: Array<{ name: string; description: string; input: { hint: string } }>;
          };
        };
      }
    ).params.update;
    expect(update.availableCommands.find((command) => command.name === "review")).toMatchObject({
      description: expect.stringContaining("pull request"),
      input: { hint: "arguments" },
    });
  });

  it("does not duplicate a command the child already lists", () => {
    const message = addPaseoCommands(commandUpdate([{ name: "help", description: "from the mod" }]));
    expect(names(message).filter((name) => name === "help")).toHaveLength(1);
    const update = (
      message as {
        params: { update: { availableCommands: Array<{ name: string; description: string }> } };
      }
    ).params.update;
    expect(update.availableCommands.find((command) => command.name === "help")?.description).toBe(
      "from the mod",
    );
  });

  it("leaves other notifications alone", () => {
    const message = { jsonrpc: "2.0", method: "session/update", params: { update: {} } } as AcpStreamMessage;
    expect(addPaseoCommands(message)).toBe(message);
  });
});
