import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { afterEach, describe, expect, it } from "vitest";
import { QuestionBridge, normalizeQuestions } from "./questions";

const scratch: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-questions-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met before timeout");
}

function fakeConnection() {
  const sent: ProviderInput[] = [];
  let listener: (event: ProviderEvent) => void = () => undefined;
  const connection: ProviderConnection = {
    version: 1,
    capabilities: [],
    send: async (input) => {
      sent.push(input);
    },
    onEvent: (next) => {
      listener = next;
      return () => undefined;
    },
    close: async () => undefined,
  };
  return { connection, emit: (event: ProviderEvent) => listener(event), sent };
}

const opened = {
  type: "session.opened",
  sessionId: "paseo-session",
  capabilities: [],
  restoration: "core",
  cwd: "/tmp",
  persistence: { version: 1, data: { sessionId: "native-session" } },
} as ProviderEvent;

describe("normalizeQuestions", () => {
  it("gives every question the header and labels the form requires", () => {
    const questions = normalizeQuestions({
      questions: [
        {
          question: "Which approach should the implementation take?",
          options: [{ label: "A", description: "First" }, "B"],
          multiSelect: true,
        },
      ],
    });
    expect(questions).toEqual([
      {
        header: "Which approa",
        question: "Which approach should the implementation take?",
        options: [{ label: "A", description: "First" }, { label: "B" }],
        multiSelect: true,
        allowOther: true,
        allowEmpty: false,
      },
    ]);
  });

  it("keeps the model's header and honors hideCustomInput", () => {
    const questions = normalizeQuestions({
      hideCustomInput: true,
      questions: [{ header: "Scope", question: "How far?", options: ["One file"] }],
    });
    expect(questions?.[0]).toMatchObject({ header: "Scope", allowOther: false });
  });

  it("drops entries the form cannot render", () => {
    expect(normalizeQuestions({ questions: [{ options: ["A"] }] })).toBeNull();
    expect(normalizeQuestions({ questions: [] })).toBeNull();
    expect(normalizeQuestions({})).toBeNull();
  });
});

describe("QuestionBridge", () => {
  it("turns a mod request into a Paseo question and hands the answer back", async () => {
    const dir = await makeDir();
    const { connection, emit } = fakeConnection();
    const bridge = new QuestionBridge();
    const events: ProviderEvent[] = [];
    const wrapped = bridge.wrap(connection, (operation) => operation());
    wrapped.onEvent((event) => events.push(event));
    emit(opened);
    bridge.register(dir);

    await writeFile(
      join(dir, "request-call-1.json"),
      JSON.stringify({
        id: "call-1",
        sessionId: "native-session",
        questions: [{ header: "Approach", question: "Which one?", options: ["A", "B"] }],
      }),
      "utf8",
    );

    await waitFor(() => events.some((event) => event.type === "session.permission"));
    const permission = events.find((event) => event.type === "session.permission");
    if (permission?.type !== "session.permission") throw new Error("no permission event");
    expect(permission.sessionId).toBe("paseo-session");
    expect(permission.request.kind).toBe("question");
    expect(permission.request.input).toMatchObject({
      questions: [
        {
          header: "Approach",
          question: "Which one?",
          options: [{ label: "A" }, { label: "B" }],
          allowOther: true,
        },
      ],
    });

    await wrapped.send({
      type: "session.permission",
      sessionId: "paseo-session",
      permissionId: permission.request.id,
      response: {
        behavior: "allow",
        updatedInput: { answers: { Approach: "Ship the smaller change" } },
      },
    });

    const answer = JSON.parse(await readFile(join(dir, "answer-call-1.json"), "utf8")) as unknown;
    expect(answer).toEqual({ answers: { Approach: "Ship the smaller change" } });
    expect(events.some((event) => event.type === "session.permission_resolved")).toBe(true);
    await wrapped.close();
  });

  it("passes a dismiss through as a cancellation", async () => {
    const dir = await makeDir();
    const { connection, emit } = fakeConnection();
    const bridge = new QuestionBridge();
    const events: ProviderEvent[] = [];
    const wrapped = bridge.wrap(connection, (operation) => operation());
    wrapped.onEvent((event) => events.push(event));
    emit(opened);
    bridge.register(dir);
    await writeFile(
      join(dir, "request-call-2.json"),
      JSON.stringify({
        id: "call-2",
        sessionId: "native-session",
        questions: [{ header: "Approach", question: "Which one?", options: ["A"] }],
      }),
      "utf8",
    );
    await waitFor(() => events.some((event) => event.type === "session.permission"));

    await wrapped.send({
      type: "session.permission",
      sessionId: "paseo-session",
      permissionId: "question:call-2",
      response: { behavior: "deny", message: "Dismissed by user" },
    });
    const answer = JSON.parse(await readFile(join(dir, "answer-call-2.json"), "utf8")) as unknown;
    expect(answer).toEqual({ cancelled: true, message: "Dismissed by user" });
    await wrapped.close();
  });

  it("leaves ordinary permission responses for the ACP shim", async () => {
    const { connection, sent } = fakeConnection();
    const bridge = new QuestionBridge();
    const wrapped = bridge.wrap(connection, (operation) => operation());
    const input: ProviderInput = {
      type: "session.permission",
      sessionId: "paseo-session",
      permissionId: "permission:tool-1",
      response: { behavior: "allow", selectedActionId: "allow_once" },
    };
    await wrapped.send(input);
    expect(sent).toEqual([input]);
    await wrapped.close();
  });
});
