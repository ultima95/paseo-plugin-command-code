import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderPersistence,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";

type JsonRecord = Record<string, unknown>;
type TurnState = "completed" | "failed" | "canceled";

interface PendingAction {
  id: string;
  name: string;
  detail: ProviderToolCallDetail;
}

interface ChildAction {
  index: number;
  toolName: string;
  summary?: string;
}

interface ChildAgent {
  id: string;
  toolCallId: string;
  root: RootSession;
  task: string;
  subagentType?: string;
  background: boolean;
  agentId?: string;
  actionCount: number;
  resultCount: number;
  actions: ChildAction[];
  log: string;
  failure?: string;
  lastAction?: PendingAction;
  settled: boolean;
}

interface RootSession {
  nativeId: string;
  sessionId: string;
  cwd: string;
  children: Map<string, ChildAgent>;
  agentOutputs: Map<string, string>;
}

/**
 * Paseo renders a provider subagent from a child provider session: the host
 * turns `session.opened` with a `parentSessionId` into a Subagents entry and
 * forwards the child session's timeline into it.
 *
 * Command Code has no ACP child sessions. It delegates through a single `task`
 * tool call (titled `Agent: …`) and streams each inner tool as a text block on
 * that call's `tool_call_update`. This bridge reads those updates from the
 * transport, opens a synthetic child session per `task` call, and projects the
 * progress lines and final result into it.
 */
export class SubagentBridge {
  private readonly roots = new Map<string, RootSession>();
  private readonly rootsBySession = new Map<string, RootSession>();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private disposed = false;

  wrap(
    connection: ProviderConnection,
    run: <T>(operation: () => Promise<T>) => Promise<T>,
  ): ProviderConnection {
    connection.onEvent((event) => this.accept(event));
    const capabilities = connection.capabilities.includes("session.subsession")
      ? [...connection.capabilities]
      : [...connection.capabilities, "session.subsession"];
    return {
      version: connection.version,
      capabilities,
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
        this.roots.clear();
        this.rootsBySession.clear();
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
    const root = this.roots.get(nativeId);
    if (!root) return;
    const kind = asString(update.sessionUpdate);
    if (kind === "tool_call") this.observeToolCall(root, update);
    else if (kind === "tool_call_update") this.observeToolCallUpdate(root, update);
  }

  private accept(event: ProviderEvent): void {
    if (this.disposed) return;

    if (event.type === "session.opened" && !event.parentSessionId) {
      const nativeId = nativeSessionId(event.persistence);
      if (nativeId) {
        const root: RootSession = {
          nativeId,
          sessionId: event.sessionId,
          cwd: event.cwd,
          children: new Map(),
          agentOutputs: new Map(),
        };
        this.roots.set(nativeId, root);
        this.rootsBySession.set(event.sessionId, root);
      }
      this.deliver({
        ...event,
        capabilities: event.capabilities.includes("session.subsession")
          ? [...event.capabilities]
          : [...event.capabilities, "session.subsession"],
      });
      return;
    }

    if (event.type === "session.turn" && event.state !== "started") {
      const root = this.rootsBySession.get(event.sessionId);
      if (root) this.settleRoot(root, event.state === "canceled" ? "canceled" : event.state, false);
    } else if (event.type === "session.runtime_failed") {
      const root = this.rootsBySession.get(event.sessionId);
      if (root) {
        this.settleRoot(root, "failed", true);
        this.forget(root);
      }
    } else if (event.type === "session.closed") {
      const root = this.rootsBySession.get(event.sessionId);
      if (root) {
        this.settleRoot(root, "completed", true);
        this.forget(root);
      }
    }

    this.deliver(event);
  }

  private forget(root: RootSession): void {
    this.roots.delete(root.nativeId);
    this.rootsBySession.delete(root.sessionId);
  }

  private deliver(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private observeToolCall(root: RootSession, update: JsonRecord): void {
    const toolCallId = asString(update.toolCallId);
    if (!toolCallId) return;
    const input = asRecord(update.rawInput);

    const agentId = asString(input?.agent_id);
    if (agentId) {
      root.agentOutputs.set(toolCallId, agentId);
      return;
    }

    const task = readSubagentTask(update, input);
    if (!task) return;
    if (root.children.has(toolCallId)) return;

    const child: ChildAgent = {
      id: `subagent-${toolCallId}`,
      toolCallId,
      root,
      task: task.description,
      ...(task.subagentType ? { subagentType: task.subagentType } : {}),
      background: task.background,
      actionCount: 0,
      resultCount: 0,
      actions: [],
      log: "",
      settled: false,
    };
    root.children.set(toolCallId, child);

    this.deliver({
      type: "session.opened",
      sessionId: child.id,
      parentSessionId: root.sessionId,
      toolCallId,
      capabilities: [],
      restoration: "parent",
      title: task.description,
      ...(task.subagentType ? { description: task.subagentType } : {}),
      cwd: root.cwd,
    });
    this.emitTimeline(child, {
      type: "user_message",
      id: `${child.id}:prompt`,
      text: task.prompt,
    });
    this.emitParentCard(child, "running");
  }

  private observeToolCallUpdate(root: RootSession, update: JsonRecord): void {
    const toolCallId = asString(update.toolCallId);
    if (!toolCallId) return;
    const status = asString(update.status);
    const text = contentTexts(update.content).join("\n").trim();

    const child = root.children.get(toolCallId);
    if (child) {
      if (status === "completed") {
        const agentId = readAgentId(text);
        if (agentId || child.background || text.startsWith("Background agent launched")) {
          child.background = true;
          if (agentId) child.agentId = agentId;
          return;
        }
        this.finishChild(child, text, "completed");
        return;
      }
      if (status === "failed") {
        this.failChild(child, text || "Subagent failed");
        return;
      }
      if (text) this.appendProgress(child, text);
      return;
    }

    const agentId = root.agentOutputs.get(toolCallId);
    if (!agentId || status !== "completed") return;
    const background = findChildByAgentId(root, agentId);
    if (!background) return;
    this.appendResult(background, text);
    const state = readBackgroundState(text);
    if (state) this.settleChild(background, state);
  }

  private appendProgress(child: ChildAgent, text: string): void {
    for (const line of text.split("\n")) {
      const progress = readProgress(line);
      if (!progress) continue;
      this.completeLastAction(child);
      const action: ChildAction = {
        index: ++child.actionCount,
        toolName: progress.toolName,
        ...(progress.summary ? { summary: progress.summary } : {}),
      };
      child.actions.push(action);
      child.log = child.log ? `${child.log}\n${line.trim()}` : line.trim();
      child.lastAction = {
        id: `${child.id}:step:${action.index}`,
        name: action.toolName,
        detail: actionDetail(progress.toolName, progress.summary),
      };
      this.emitTimeline(child, toolItem(child.lastAction, "running"));
      this.emitParentCard(child, "running");
    }
  }

  private completeLastAction(child: ChildAgent): void {
    const action = child.lastAction;
    if (!action) return;
    child.lastAction = undefined;
    this.emitTimeline(child, toolItem(action, "completed"));
  }

  private appendResult(child: ChildAgent, text: string): void {
    if (!text) return;
    this.emitTimeline(child, {
      type: "assistant_message",
      id: `${child.id}:result:${++child.resultCount}`,
      text,
    });
  }

  private finishChild(child: ChildAgent, text: string, state: TurnState): void {
    this.completeLastAction(child);
    if (text) this.appendResult(child, text);
    this.settleChild(child, state);
  }

  private failChild(child: ChildAgent, message: string): void {
    child.failure = message;
    this.completeLastAction(child);
    this.emitTimeline(child, { type: "error", id: `${child.id}:error`, message });
    this.settleChild(child, "failed");
  }

  private settleChild(child: ChildAgent, state: TurnState): void {
    if (child.settled) return;
    this.completeLastAction(child);
    child.settled = true;
    this.emitParentCard(child, state);
    this.deliver({
      type: "session.turn",
      sessionId: child.id,
      turnId: `${child.id}:turn`,
      state,
    });
  }

  private settleRoot(root: RootSession, state: TurnState, force: boolean): void {
    for (const child of root.children.values()) {
      if (child.settled) continue;
      if (child.background && !force && state === "completed") continue;
      this.settleChild(child, state);
    }
  }

  private emitTimeline(child: ChildAgent, item: ProviderTimelineItem): void {
    this.deliver({ type: "timeline.item", sessionId: child.id, item });
  }

  /**
   * The parent transcript's card for this subagent. Paseo merges this into the
   * shim's own `Agent` tool row by call id, and keeps the richer `sub_agent`
   * detail over the shim's `unknown` one.
   */
  private emitParentCard(
    child: ChildAgent,
    status: "running" | "completed" | "failed" | "canceled",
  ): void {
    const detail: ProviderToolCallDetail = {
      type: "sub_agent",
      ...(child.subagentType ? { subAgentType: child.subagentType } : {}),
      description: child.task,
      childSessionId: child.id,
      log: child.log,
      actions: child.actions.map((action) => ({ ...action })),
    };
    const base = {
      type: "tool_call" as const,
      id: child.toolCallId,
      callId: child.toolCallId,
      name: "Agent",
      detail,
    };
    this.deliver({
      type: "timeline.item",
      sessionId: child.root.sessionId,
      item:
        status === "failed"
          ? { ...base, status, error: { message: child.failure ?? "Subagent failed" } }
          : { ...base, status, error: null },
    });
  }
}

function toolItem(action: PendingAction, status: "running" | "completed"): ProviderTimelineItem {
  return {
    type: "tool_call",
    id: action.id,
    callId: action.id,
    name: action.name,
    detail: action.detail,
    status,
    error: null,
  };
}

function readSubagentTask(
  update: JsonRecord,
  input: JsonRecord | null,
): { description: string; prompt: string; subagentType?: string; background: boolean } | null {
  const description = asString(input?.description)?.trim();
  const prompt = asString(input?.prompt);
  if (!description || !prompt) return null;
  const subagentType = asString(input?.subagent_type) ?? asString(input?.agent_type);
  const title = asString(update.title) ?? "";
  if (!subagentType && title !== "Agent" && !title.startsWith("Agent: ")) return null;
  return {
    description,
    prompt,
    ...(subagentType ? { subagentType } : {}),
    background: input?.run_in_background === true,
  };
}

const PROGRESS_LINE = /^([A-Za-z0-9_]+)\((.*)\)$/s;

function readProgress(line: string): { toolName: string; summary: string } | null {
  const match = PROGRESS_LINE.exec(line.trim());
  if (!match?.[1]) return null;
  return { toolName: match[1], summary: match[2] ?? "" };
}

function actionDetail(toolName: string, summary: string): ProviderToolCallDetail {
  switch (toolName) {
    case "read_file":
    case "read_directory":
      return { type: "read", filePath: summary };
    case "edit_file":
      return { type: "edit", filePath: summary };
    case "write_file":
      return { type: "write", filePath: summary };
    case "grep":
    case "glob":
      return { type: "search", query: summary, toolName };
    case "web_search":
      return { type: "search", query: summary, toolName: "web_search" };
    case "web_fetch":
      return { type: "fetch", url: summary };
    case "shell_command":
    case "run_command":
    case "monitor_command":
      return { type: "shell", command: summary };
    default:
      return { type: "plain_text", label: toolName, text: summary || undefined, icon: "wrench" };
  }
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

function readAgentId(text: string): string | undefined {
  return /(?:^|\n)agent_id:\s*(\S+)/.exec(text)?.[1];
}

function readBackgroundState(text: string): TurnState | null {
  const status = /(?:^|\n)status:\s*(\w+)/.exec(text)?.[1];
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "killed") return "canceled";
  return null;
}

function findChildByAgentId(root: RootSession, agentId: string): ChildAgent | undefined {
  for (const child of root.children.values()) {
    if (child.agentId === agentId) return child;
  }
  return undefined;
}

function nativeSessionId(persistence: ProviderPersistence | undefined): string | undefined {
  const data = asRecord(persistence?.data);
  return asString(data?.sessionId);
}

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
