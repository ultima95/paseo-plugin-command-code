import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderPersistence,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";

type JsonRecord = Record<string, unknown>;
type ToolStatus = "running" | "completed" | "failed";

interface ToolState {
  id: string;
  label: string;
  input: JsonRecord;
  locations: string[];
  texts: string[];
  status: ToolStatus;
}

/**
 * Paseo's ACP shim derives a tool row's detail from `rawInput` alone and only
 * knows two shapes: an `edit` diff and an opaque `unknown` blob. Command Code
 * reports file reads, shell output, and search results as ACP content blocks,
 * so those rows render with no body.
 *
 * The shim keeps forwarding its own (sparser) row for every call, and the
 * client merges rows by call id, preferring any typed detail over `unknown`.
 * This projector replays the same calls as typed timeline items, so the richer
 * detail wins no matter which row lands first.
 */
export class ToolCallProjector {
  private readonly sessions = new Map<string, string>();
  private readonly tools = new Map<string, ToolState>();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private disposed = false;

  wrap(
    connection: ProviderConnection,
    run: <T>(operation: () => Promise<T>) => Promise<T>,
  ): ProviderConnection {
    connection.onEvent((event) => this.accept(event));
    return {
      version: connection.version,
      capabilities: connection.capabilities,
      send: (input) => run(() => connection.send(input)),
      onEvent: (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      close: async () => {
        this.disposed = true;
        this.listeners.clear();
        this.sessions.clear();
        this.tools.clear();
        await connection.close();
      },
    };
  }

  observe(message: AcpStreamMessage): void {
    if (this.disposed || !("method" in message) || message.method !== "session/update") return;
    const params = asRecord(message.params);
    const nativeId = asString(params?.sessionId);
    const update = asRecord(params?.update);
    if (!nativeId || !update) return;

    const sessionId = this.sessions.get(nativeId);
    if (!sessionId) return;

    const kind = asString(update.sessionUpdate);
    if (kind !== "tool_call" && kind !== "tool_call_update") return;

    const toolCallId = asString(update.toolCallId);
    if (!toolCallId) return;

    const key = `${sessionId}:${toolCallId}`;
    const state = mergeState(this.tools.get(key), toolCallId, update);
    this.tools.set(key, state);

    const detail = buildDetail(state);
    if (!detail) return;

    this.emit(sessionId, toolItem(state, detail));
  }

  private accept(event: ProviderEvent): void {
    if (this.disposed) return;
    if (event.type === "session.opened" && !event.parentSessionId) {
      const nativeId = nativeSessionId(event.persistence);
      if (nativeId) this.sessions.set(nativeId, event.sessionId);
    } else if (event.type === "session.closed") {
      for (const [nativeId, sessionId] of this.sessions) {
        if (sessionId === event.sessionId) this.sessions.delete(nativeId);
      }
      for (const key of this.tools.keys()) {
        if (key.startsWith(`${event.sessionId}:`)) this.tools.delete(key);
      }
    }
    this.deliver(event);
  }

  private emit(sessionId: string, item: ProviderTimelineItem): void {
    this.deliver({ type: "timeline.item", sessionId, item });
  }

  private deliver(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function mergeState(current: ToolState | undefined, id: string, update: JsonRecord): ToolState {
  const input = asRecord(update.rawInput) ?? current?.input ?? {};
  const locations = stringArray(update.locations)
    .map((location) => asString(asRecord(location)?.path))
    .filter((path): path is string => Boolean(path));
  const texts = contentTexts(update.content);
  const status = statusOf(asString(update.status) ?? (current ? "in_progress" : "pending"));
  // `tool_running` replaces the title with a progress description; the queued
  // `tool_call` title is the one carrying the tool name.
  const label = current?.label ?? asString(update.title) ?? "Tool";

  return {
    id,
    label,
    input: current ? { ...current.input, ...input } : input,
    locations: locations.length > 0 ? locations : (current?.locations ?? []),
    texts:
      status === "completed" || status === "failed"
        ? texts.length > 0
          ? texts
          : (current?.texts ?? [])
        : mergeTexts(current?.texts ?? [], texts),
    status,
  };
}

/**
 * Partial tool results can arrive as deltas or as growing snapshots of the same
 * text. Keep whichever form the CLI uses without duplicating it.
 */
function mergeTexts(previous: string[], incoming: string[]): string[] {
  const texts = [...previous];
  for (const text of incoming) {
    if (texts.includes(text)) continue;
    const last = texts[texts.length - 1];
    if (last !== undefined && text.startsWith(last)) {
      texts[texts.length - 1] = text;
      continue;
    }
    texts.push(text);
  }
  return texts;
}

function toolItem(state: ToolState, detail: ProviderToolCallDetail): ProviderTimelineItem {
  const label = state.label.split(": ")[0];
  const base = {
    type: "tool_call" as const,
    id: state.id,
    callId: state.id,
    name: label,
    detail,
  };
  if (state.status === "failed") {
    return {
      ...base,
      status: "failed",
      error: { message: state.texts.join("\n") || "Tool call failed" },
    };
  }
  return { ...base, status: state.status, error: null };
}

function buildDetail(state: ToolState): ProviderToolCallDetail | null {
  const label = state.label.split(": ")[0];
  const output = state.texts.join("\n").trim();
  const summary = state.label.includes(": ") ? state.label.slice(state.label.indexOf(": ") + 2) : "";
  const input = state.input;

  if (input.question !== undefined && Array.isArray(input.options)) {
    return { type: "plain_text", label: "Question", text: asString(input.question) };
  }

  switch (label) {
    case "Read":
    case "List": {
      const filePath =
        firstString(input.file_path, input.path, input.include) ?? state.locations[0] ?? "";
      if (!filePath && !output) return null;
      return {
        type: "read",
        filePath,
        ...(output ? { content: output } : {}),
        ...(numberValue(input.offset) !== undefined ? { offset: numberValue(input.offset) } : {}),
        ...(numberValue(input.limit) !== undefined ? { limit: numberValue(input.limit) } : {}),
      };
    }
    case "Shell":
    case "Monitor":
    case "Command":
    case "Kill":
      return {
        type: "shell",
        command: firstString(input.command) ?? summary,
        ...(firstString(input.cwd) ? { cwd: firstString(input.cwd) } : {}),
        ...(output ? { output } : {}),
      };
    case "Search":
    case "Glob": {
      const query = firstString(input.pattern, input.query) ?? summary;
      if (!query && !output) return null;
      return {
        type: "search",
        query,
        toolName: label === "Glob" ? "glob" : firstString(input.query) ? "web_search" : "grep",
        ...(output ? { content: output } : {}),
      };
    }
    case "Fetch":
      return {
        type: "fetch",
        url: firstString(input.url) ?? summary,
        ...(output ? { result: output } : {}),
      };
    case "Diagnostics":
      return output ? { type: "plain_text", label: "Diagnostics", text: output } : null;
    default:
      return null;
  }
}

function statusOf(status: string): ToolStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "running";
}

function contentTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const texts: string[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    if (asString(record.type) === "text") {
      const text = asString(record.text);
      if (text) texts.push(text);
      continue;
    }
    const content = asRecord(record.content);
    if (content && asString(content.type) === "text") {
      const text = asString(content.text);
      if (text) texts.push(text);
    }
  }
  return texts;
}

function stringArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
    if (Array.isArray(value)) {
      const joined = value.filter((entry) => typeof entry === "string").join(", ");
      if (joined) return joined;
    }
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nativeSessionId(persistence: ProviderPersistence | undefined): string | undefined {
  return asString(asRecord(persistence?.data)?.sessionId);
}

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
