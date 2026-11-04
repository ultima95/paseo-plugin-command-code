import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderPermissionRequest,
} from "@getpaseo/plugin/server/provider";

type JsonRecord = Record<string, unknown>;

interface PendingQuestion {
  sessionId: string;
  dir: string;
  fileId: string;
}

/**
 * Command Code answers `ask_user_question` over ACP `session/request_permission`,
 * whose choices are fixed option ids: the CLI maps the selected id back to one of
 * the labels it sent, so free text and editing a choice never reach the model.
 *
 * Paseo already has the richer contract: a permission request of kind `question`
 * with `input.questions` opens its question form, which offers an "Other" text
 * field, a Dismiss action, and a Submit step. The bundled mod answers
 * `ask_user_question` itself instead of running the tool, and exchanges the
 * question and its answer with this bridge through files in a per-child
 * directory. That keeps the model's tool result exact while Paseo owns the UI.
 */
export class QuestionBridge {
  private readonly sessions = new Map<string, string>();
  private readonly nativeByToolCall = new Map<string, string>();
  private readonly channels = new Set<string>();
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly seen = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private timer?: NodeJS.Timeout;
  private draining = false;
  private disposed = false;

  register(dir: string): void {
    if (this.disposed) return;
    this.channels.add(dir);
    void this.drain();
  }

  unregister(dir: string): void {
    this.channels.delete(dir);
  }

  observe(message: AcpStreamMessage): void {
    if (this.disposed || !("method" in message) || message.method !== "session/update") return;
    const params = asRecord(message.params);
    const nativeId = asString(params?.sessionId);
    const update = asRecord(params?.update);
    const toolCallId = asString(update?.toolCallId);
    if (!nativeId || !toolCallId) return;
    this.nativeByToolCall.set(toolCallId, nativeId);
  }

  wrap(
    connection: ProviderConnection,
    run: <T>(operation: () => Promise<T>) => Promise<T>,
  ): ProviderConnection {
    connection.onEvent((event) => this.accept(event));
    this.timer = setInterval(() => void this.drain(), 200);
    this.timer.unref?.();
    return {
      version: connection.version,
      capabilities: connection.capabilities,
      send: async (input) => {
        if (await this.answer(input)) return;
        await run(() => connection.send(input));
      },
      onEvent: (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      close: async () => {
        this.disposed = true;
        if (this.timer) clearInterval(this.timer);
        this.listeners.clear();
        this.channels.clear();
        this.pending.clear();
        this.sessions.clear();
        this.nativeByToolCall.clear();
        this.seen.clear();
        this.attempts.clear();
        await connection.close();
      },
    };
  }

  private accept(event: ProviderEvent): void {
    if (this.disposed) return;
    if (event.type === "session.opened" && !event.parentSessionId) {
      const nativeId = asString(asRecord(event.persistence?.data)?.sessionId);
      if (nativeId) this.sessions.set(nativeId, event.sessionId);
    } else if (event.type === "session.closed") {
      for (const [nativeId, sessionId] of this.sessions) {
        if (sessionId === event.sessionId) this.sessions.delete(nativeId);
      }
    }
    this.emit(event);
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.draining || this.channels.size === 0) return;
    this.draining = true;
    try {
      for (const dir of this.channels) {
        const names = await readdir(dir).catch(() => [] as string[]);
        for (const name of names) {
          if (!name.startsWith("request-") || !name.endsWith(".json")) continue;
          const file = join(dir, name);
          if (this.seen.has(file)) continue;
          this.seen.add(file);
          await this.acceptRequest(dir, file);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async acceptRequest(dir: string, file: string): Promise<void> {
    const raw = await readFile(file, "utf8").catch(() => undefined);
    if (raw === undefined) {
      this.seen.delete(file);
      return;
    }
    let request: JsonRecord;
    try {
      request = JSON.parse(raw) as JsonRecord;
    } catch {
      return;
    }
    const fileId = asString(request.id);
    if (!fileId) return;
    const questions = normalizeQuestions(request);
    if (!questions) {
      // Nothing the form can render: unblock the mod instead of letting it
      // wait out its timeout.
      await this.decline(dir, fileId, "The question could not be displayed.");
      return;
    }

    const nativeId =
      asString(request.sessionId) ??
      this.nativeByToolCall.get(fileId) ??
      "";
    const sessionId = this.sessions.get(nativeId);
    if (!sessionId) {
      // The session opened event can land just after the child writes the
      // request. Reconsider the same file a bounded number of times.
      const attempt = (this.attempts.get(file) ?? 0) + 1;
      this.attempts.set(file, attempt);
      if (attempt <= 25) {
        this.seen.delete(file);
        setTimeout(() => void this.drain(), 200).unref?.();
      } else {
        await this.decline(dir, fileId, "Paseo could not display the question.");
      }
      return;
    }

    const permissionId = `question:${fileId}`;
    this.pending.set(permissionId, { sessionId, dir, fileId: sanitizeId(fileId) });
    this.emit({
      type: "session.permission",
      sessionId,
      request: {
        id: permissionId,
        name: "Question",
        kind: "question",
        title: asString(questions[0]?.header),
        input: { questions } as unknown as ProviderPermissionRequest["input"],
      },
    });
  }

  private async answer(input: ProviderInput): Promise<boolean> {
    if (input.type !== "session.permission") return false;
    const pending = this.pending.get(input.permissionId);
    if (!pending) return false;
    this.pending.delete(input.permissionId);

    const payload =
      input.response.behavior === "allow"
        ? { answers: asRecord(input.response.updatedInput?.answers) ?? {} }
        : {
            cancelled: true,
            message: asString(input.response.message) ?? "The user dismissed the question.",
          };
    await writeFile(
      join(pending.dir, `answer-${pending.fileId}.json`),
      JSON.stringify(payload),
      "utf8",
    ).catch(() => undefined);
    this.emit({
      type: "session.permission_resolved",
      sessionId: pending.sessionId,
      permissionId: input.permissionId,
    });
    return true;
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async decline(dir: string, fileId: string, message: string): Promise<void> {
    await writeFile(
      join(dir, `answer-${sanitizeId(fileId)}.json`),
      JSON.stringify({ cancelled: true, message }),
      "utf8",
    ).catch(() => undefined);
  }
}

/**
 * The question form requires a non-empty `header` on every entry and labels on
 * every option; Command Code's tool input can omit either. Keep the form usable
 * rather than dropping the request back to a bare permission card.
 */
export function normalizeQuestions(
  request: JsonRecord,
): Array<Record<string, unknown>> | null {
  const list = Array.isArray(request.questions) ? request.questions : [];
  const hideCustomInput = request.hideCustomInput === true;
  const questions: Array<Record<string, unknown>> = [];
  for (const [index, value] of list.entries()) {
    const question = asRecord(value);
    if (!question) continue;
    const text = asString(question.question);
    if (!text) continue;
    const header =
      asString(question.header) ??
      asString(question.question)?.slice(0, 12) ??
      `Question ${index + 1}`;
    const options: Array<Record<string, unknown>> = [];
    for (const entry of Array.isArray(question.options) ? question.options : []) {
      if (typeof entry === "string" && entry.length > 0) {
        options.push({ label: entry });
        continue;
      }
      const option = asRecord(entry);
      const label = asString(option?.label);
      if (!label) continue;
      options.push({
        label,
        ...(asString(option?.description) ? { description: asString(option?.description) } : {}),
        // Paseo renders an option's `preview` beside the choice list.
        ...(asString(option?.preview) ? { preview: asString(option?.preview) } : {}),
      });
    }
    questions.push({
      header,
      question: text,
      options,
      multiSelect: question.multiSelect === true,
      allowOther: !hideCustomInput && question.hideCustomInput !== true,
      allowEmpty: false,
    });
  }
  return questions.length > 0 ? questions : null;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
