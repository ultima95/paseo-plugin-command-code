import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { describe, expect, it } from "vitest";
import { ToolCallProjector } from "./tool-calls";

function fakeConnection() {
  let listener: (event: ProviderEvent) => void = () => undefined;
  const connection: ProviderConnection = {
    version: 1,
    capabilities: [],
    send: async (_input: ProviderInput) => undefined,
    onEvent: (next) => {
      listener = next;
      return () => undefined;
    },
    close: async () => undefined,
  };
  return { connection, emit: (event: ProviderEvent) => listener(event) };
}

const opened = {
  type: "session.opened",
  sessionId: "paseo-session",
  capabilities: [],
  restoration: "core",
  cwd: "/tmp",
  persistence: { version: 1, data: { sessionId: "native-session" } },
} as ProviderEvent;

function toolCall(toolCallId: string, rawInput: unknown): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "native-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Ask user question",
        status: "pending",
        rawInput,
      },
    },
  } as AcpStreamMessage;
}

function toolUpdate(
  toolCallId: string,
  status: string,
  text: string,
): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "native-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status,
        content: [{ type: "content", content: { type: "text", text } }],
      },
    },
  } as AcpStreamMessage;
}

function questionDetails(projector: ToolCallProjector) {
  const { connection, emit } = fakeConnection();
  const items: Array<{ detail?: ProviderToolCallDetail }> = [];
  const wrapped = projector.wrap(connection, (operation) => operation());
  wrapped.onEvent((event) => {
    if (event.type === "timeline.item") items.push(event.item as { detail?: ProviderToolCallDetail });
  });
  emit(opened);
  return { items, wrapped };
}

describe("ToolCallProjector questions", () => {
  it("shows the question text instead of the raw input", () => {
    const projector = new ToolCallProjector();
    const { items, wrapped } = questionDetails(projector);

    projector.observe(
      toolCall("call-1", {
        questions: [
          {
            header: "Bố cục site",
            question: "Site nên chia trang theo hướng nào?",
            options: [{ label: "Studio nhiều trang", preview: "```\n/home\n```" }],
          },
        ],
      }),
    );

    const detail = items.at(-1)?.detail;
    expect(detail).toEqual({
      type: "plain_text",
      label: "Question",
      text: "Site nên chia trang theo hướng nào?",
    });
    void wrapped.close();
  });

  it("shows the answer once the question completes", () => {
    const projector = new ToolCallProjector();
    const { items, wrapped } = questionDetails(projector);

    projector.observe(
      toolCall("call-2", {
        questions: [
          {
            header: "Bố cục site",
            question: "Site nên chia trang theo hướng nào?",
            options: ["Studio nhiều trang"],
          },
        ],
      }),
    );
    projector.observe(
      toolUpdate(
        "call-2",
        "completed",
        "Site nên chia trang theo hướng nào? → Studio nhiều trang",
      ),
    );

    const detail = items.at(-1)?.detail;
    expect(detail?.type).toBe("plain_text");
    expect(detail && "text" in detail ? detail.text : "").toBe(
      "Site nên chia trang theo hướng nào? → Studio nhiều trang",
    );
    void wrapped.close();
  });
});
