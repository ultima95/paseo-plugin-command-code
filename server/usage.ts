import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  UsageAccount,
  UsageBalance,
  UsageDetail,
  UsageReport,
  UsageScope,
  UsageSourceRegistration,
  UsageWindow,
} from "@getpaseo/plugin/server/usage";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
} from "@getpaseo/plugin/server/usage";

const API_BASE = "https://api.commandcode.ai";
const REQUEST_TIMEOUT_MS = 15_000;

const inputSchema = z.discriminatedUnion("store", [
  z.object({ store: z.literal("env"), locator: z.string().min(1) }).strict(),
  z.object({ store: z.literal("file"), path: z.string().min(1) }).strict(),
  z.object({ store: z.literal("memory"), id: z.string().min(1) }).strict(),
]);
type UsageInput = z.infer<typeof inputSchema>;

const authFileSchema = z.object({
  apiKey: z.string().optional(),
  userId: z.string().optional(),
  userName: z.string().optional(),
});

const number = z.coerce.number().finite();
const optionalNumber = z.preprocess(
  (value) => (value == null ? undefined : value),
  number.optional(),
);
const optionalString = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.string().optional(),
);
const resetAtNumber = optionalNumber;

const usageWindowSchema = z.object({
  used: optionalNumber,
  cap: optionalNumber,
  exceeded: z.boolean().nullish(),
  resetAt: resetAtNumber,
});

const orgLimitsSchema = z
  .array(
    z.object({
      label: optionalString,
      name: optionalString,
      scope: optionalString,
      spent: optionalNumber,
      limit: optionalNumber,
      resetAt: optionalString,
      resetInterval: optionalString,
      exceeded: z.boolean().nullish(),
    }),
  )
  .nullish();

const creditsBodySchema = z
  .object({
    credits: z
      .object({
        planId: optionalString,
        monthlyCredits: optionalNumber,
        purchasedCredits: optionalNumber,
        freeCredits: optionalNumber,
        belowThreshold: z.boolean().nullish(),
        creditThreshold: optionalNumber,
      })
      .nullish(),
    windowLimits: z
      .object({
        limited: z.boolean().nullish(),
        fiveHour: usageWindowSchema.nullish(),
        weekly: usageWindowSchema.nullish(),
      })
      .nullish(),
    sandboxAccess: z.boolean().nullish(),
    sandboxMinutes: z
      .object({
        usedMinutes: optionalNumber,
        limitMinutes: optionalNumber,
        resetAt: resetAtNumber,
      })
      .nullish(),
    orgLimits: orgLimitsSchema,
  })
  .passthrough();

const subscriptionBodySchema = z
  .object({
    success: z.boolean().optional(),
    data: z
      .object({
        status: optionalString,
        planId: optionalString,
        currentPeriodStart: optionalString,
        currentPeriodEnd: optionalString,
        cancelAtPeriodEnd: z.boolean().nullish(),
      })
      .nullish(),
  })
  .passthrough();

const summaryBodySchema = z
  .object({
    totalCount: optionalNumber,
    totalCost: optionalNumber,
    totalTokens: optionalNumber,
    totalCredits: optionalNumber,
    totalMonthlyCredits: optionalNumber,
    totalPurchasedCredits: optionalNumber,
    totalFreeCredits: optionalNumber,
    periodBasis: optionalString,
    periodStart: optionalString,
    periodEnd: optionalString,
  })
  .passthrough();

const whoamiBodySchema = z
  .object({
    success: z.boolean().optional(),
    user: z
      .object({
        id: optionalString,
        userName: optionalString,
      })
      .nullish(),
    org: z
      .object({
        id: optionalString,
        login: optionalString,
        name: optionalString,
      })
      .nullish(),
    orgLimits: orgLimitsSchema,
  })
  .passthrough();

type CreditsBody = z.infer<typeof creditsBodySchema>;
type SubscriptionBody = z.infer<typeof subscriptionBodySchema>;
type SummaryBody = z.infer<typeof summaryBodySchema>;
type WhoamiBody = z.infer<typeof whoamiBodySchema>;

interface Credentials {
  apiKey: string;
  userId?: string;
  userName?: string;
}

const memoryCredentials = new Map<string, Credentials>();

const plans = [
  { prefix: "individual-provider", name: "Provider", monthlyCredits: 15 },
  { prefix: "individual-goat", name: "GOAT", monthlyCredits: 70 },
  { prefix: "individual-ultra", name: "Ultra", monthlyCredits: 300 },
  { prefix: "individual-pro-v1", name: "Pro", monthlyCredits: 80 },
  { prefix: "individual-go-v1", name: "Go", monthlyCredits: 10 },
  { prefix: "individual-max", name: "Max", monthlyCredits: 150 },
  { prefix: "individual-pro", name: "Pro", monthlyCredits: 30 },
  { prefix: "individual-go", name: "Go", monthlyCredits: 10 },
  { prefix: "teams-pro", name: "Teams Pro", monthlyCredits: 40 },
].sort((a, b) => b.prefix.length - a.prefix.length);

function planFor(planId: string | undefined): { name: string; monthlyCredits: number } | null {
  if (!planId) return null;
  const normalized = planId.toLowerCase().replace(/_/g, "-");
  const match = plans.find((plan) => normalized.startsWith(plan.prefix));
  return match ? { name: match.name, monthlyCredits: match.monthlyCredits } : null;
}

function planLabel(planId: string | undefined): string | undefined {
  if (!planId) return undefined;
  const plan = planFor(planId);
  if (plan) return plan.name;
  return planId
    .replace(/^individual-/, "")
    .replace(/^teams-/, "")
    .replace(/-v\d+$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isoFromMilliseconds(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoFromString(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentOf(used: number | undefined, limit: number | undefined): number | null {
  if (used == null || limit == null || !Number.isFinite(used) || !Number.isFinite(limit)) {
    return null;
  }
  if (limit <= 0) return null;
  return round2(Math.max(0, Math.min(100, (used / limit) * 100)));
}

function formatCredits(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function homeFrom(env: NodeJS.ProcessEnv | Record<string, string>): string {
  return env.HOME || env.USERPROFILE || homedir();
}

function fileInput(home: string): UsageInput {
  return { store: "file", path: join(home, ".commandcode", "auth.json") };
}

function rememberEnvCredentials(apiKey: string): UsageInput {
  const id = hashAccountKey(apiKey);
  memoryCredentials.set(id, { apiKey });
  if (memoryCredentials.size > 8) {
    const oldest = memoryCredentials.keys().next().value;
    if (oldest !== undefined) memoryCredentials.delete(oldest);
  }
  return { store: "memory", id };
}

async function readCredentials(input: UsageInput): Promise<Credentials | null> {
  if (input.store === "env") {
    const apiKey = process.env[input.locator]?.trim();
    return apiKey ? { apiKey } : null;
  }
  if (input.store === "memory") return memoryCredentials.get(input.id) ?? null;
  try {
    const parsed = authFileSchema.safeParse(JSON.parse(await readFile(input.path, "utf8")));
    if (!parsed.success || !parsed.data.apiKey) return null;
    return {
      apiKey: parsed.data.apiKey,
      ...(parsed.data.userId ? { userId: parsed.data.userId } : {}),
      ...(parsed.data.userName ? { userName: parsed.data.userName } : {}),
    };
  } catch {
    return null;
  }
}

async function routeFor(scope: UsageScope): Promise<UsageInput | null> {
  const env = scope.kind === "global" ? process.env : scope.env;
  if (scope.kind === "session" && scope.provider !== "command-code") return null;

  const home = homeFrom(env);
  const file = fileInput(home);
  const envKey = env.COMMAND_CODE_API_KEY?.trim();

  if (envKey) {
    const fileCredentials = await readCredentials(file);
    if (fileCredentials?.apiKey === envKey) return file;
    if (process.env.COMMAND_CODE_API_KEY?.trim() === envKey) {
      return { store: "env", locator: "COMMAND_CODE_API_KEY" };
    }
    return rememberEnvCredentials(envKey);
  }

  return file;
}

async function discover(scope: UsageScope): Promise<UsageAccount[]> {
  const input = await routeFor(scope);
  if (!input) return [];
  const credentials = await readCredentials(input);
  if (!credentials) return [];

  const key =
    credentials.userId ??
    (input.store === "file" ? hashAccountKey(input.path) : hashAccountKey(credentials.apiKey));
  return [
    {
      key,
      label: credentials.userName ?? "Command Code",
      harness: "Command Code",
      input,
    },
  ];
}

async function getJson<T>(
  path: string,
  apiKey: string,
  schema: z.ZodType<T>,
  fetchApi: typeof fetch,
): Promise<{ status: number; body: T | null }> {
  const response = await fetchApi(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 401 || response.status === 403) {
    return { status: response.status, body: null };
  }
  if (!response.ok) throw new Error(`Command Code usage API returned ${response.status}`);

  const text = await response.text();
  if (text.trim().startsWith("<")) throw new Error("Command Code usage API returned HTML");
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `Command Code usage response was not in the expected shape: ${parsed.error.message}`,
    );
  }
  return { status: response.status, body: parsed.data };
}

async function getOptionalJson<T>(
  path: string,
  apiKey: string,
  schema: z.ZodType<T>,
  fetchApi: typeof fetch,
): Promise<T | null> {
  try {
    const response = await getJson(path, apiKey, schema, fetchApi);
    return response.body;
  } catch {
    return null;
  }
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

function windowFromUsed(input: {
  id: string;
  label: string;
  shortLabel?: string;
  summary?: boolean;
  used: number | undefined;
  cap: number | undefined;
  resetsAt: string | null;
}): UsageWindow | null {
  if (input.used == null || input.cap == null || input.cap <= 0) return null;
  const usedPct = percentOf(input.used, input.cap);
  return windowFromUsedPct({
    id: input.id,
    label: input.label,
    ...(input.shortLabel !== undefined ? { shortLabel: input.shortLabel } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    utilizationPct: usedPct,
    resetsAt: input.resetsAt,
    tone: toneFromUsedPct(usedPct),
  });
}

function buildWindows(credits: CreditsBody | null, details: UsageDetail[]): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const limits = credits?.windowLimits ?? null;

  if (limits?.limited) {
    const fiveHour = windowFromUsed({
      id: "five_hour",
      label: "5-hour",
      shortLabel: "5h",
      summary: true,
      used: limits.fiveHour?.used,
      cap: limits.fiveHour?.cap,
      resetsAt: isoFromMilliseconds(limits.fiveHour?.resetAt),
    });
    if (fiveHour) windows.push(fiveHour);

    const weekly = windowFromUsed({
      id: "weekly",
      label: "Weekly",
      shortLabel: "wk",
      summary: true,
      used: limits.weekly?.used,
      cap: limits.weekly?.cap,
      resetsAt: isoFromMilliseconds(limits.weekly?.resetAt),
    });
    if (weekly) windows.push(weekly);
  }

  const sandbox = credits?.sandboxMinutes;
  if (credits?.sandboxAccess && sandbox) {
    const cloudMinutes = windowFromUsed({
      id: "cloud_minutes",
      label: "Cloud minutes",
      shortLabel: "mo",
      used: sandbox.usedMinutes,
      cap: sandbox.limitMinutes,
      resetsAt: isoFromMilliseconds(sandbox.resetAt),
    });
    if (cloudMinutes) {
      windows.push(cloudMinutes);
    } else if ((sandbox.usedMinutes ?? 0) > 0) {
      details.push({
        id: "cloud_minutes_used",
        label: "Cloud minutes used",
        value: `${formatCredits(sandbox.usedMinutes ?? 0)} min`,
      });
    }
  }

  return windows;
}

function buildBalances(
  credits: CreditsBody | null,
  subscription: SubscriptionBody | null,
  summary: SummaryBody | null,
  whoami: WhoamiBody | null,
  details: UsageDetail[],
): UsageBalance[] {
  const balances: UsageBalance[] = [];
  const rawCredits = credits?.credits;

  if (rawCredits) {
    const monthly = round2(Math.max(0, rawCredits.monthlyCredits ?? 0));
    const purchased = round2(Math.max(0, rawCredits.purchasedCredits ?? 0));
    const free = round2(Math.max(0, rawCredits.freeCredits ?? 0));
    const remaining = round2(monthly + purchased + free);

    const subscriptionData = subscription?.data;
    const plan = planFor(subscriptionData?.planId ?? rawCredits.planId);
    const activePlanCredits =
      subscriptionData?.status === "active" ? (plan?.monthlyCredits ?? null) : null;
    const spent = round2(Math.max(0, summary?.totalCost ?? 0));
    const pool = round2(
      activePlanCredits !== null
        ? Math.max(activePlanCredits, monthly) + purchased + free
        : spent + remaining,
    );

    if (pool > 0 || remaining > 0) {
      const used = round2(Math.max(0, pool - remaining));
      const usedPct = percentOf(used, pool);
      balances.push({
        id: "credits",
        label: usedPct === null ? "Credits" : `Credits · ${usedPct}% used`,
        ...(pool > 0 ? { used, limit: pool } : {}),
        remaining,
        unit: "credits",
        resetsAt: isoFromString(subscriptionData?.currentPeriodEnd),
        tone: toneFromUsedPct(usedPct),
      });
    }

    if (monthly > 0) {
      details.push({
        id: "monthly_credits",
        label: "Monthly credits left",
        value: formatCredits(monthly),
      });
    }
    if (purchased > 0) {
      details.push({
        id: "purchased_credits",
        label: "Purchased credits",
        value: formatCredits(purchased),
      });
    }
    if (free > 0) {
      details.push({ id: "free_credits", label: "Free credits", value: formatCredits(free) });
    }
  }

  for (const [index, limit] of (whoami?.orgLimits ?? []).entries()) {
    const used = limit.spent;
    const cap = limit.limit;
    if (used == null || cap == null) continue;
    balances.push({
      id: `org_limit_${index}`,
      label: limit.label ?? limit.name ?? limit.scope ?? `Spend limit ${index + 1}`,
      used: round2(used),
      remaining: round2(Math.max(0, cap - used)),
      limit: round2(cap),
      unit: "usd",
      resetsAt: isoFromString(limit.resetAt),
      tone: toneFromUsedPct(percentOf(used, cap)),
    });
  }

  return balances;
}

function buildDetails(
  subscription: SubscriptionBody | null,
  summary: SummaryBody | null,
): UsageDetail[] {
  const details: UsageDetail[] = [];
  const subscriptionData = subscription?.data;

  if (subscriptionData?.status) {
    details.push({ id: "status", label: "Status", value: subscriptionData.status });
  }
  if (summary?.totalCount != null) {
    details.push({
      id: "requests",
      label: summary.periodBasis === "billing-period" ? "Requests this period" : "Requests",
      value: summary.totalCount.toLocaleString(),
    });
  }
  if (summary?.totalCost != null) {
    details.push({ id: "spent", label: "Spent this period", value: `$${summary.totalCost.toFixed(2)}` });
  }
  if (summary?.totalTokens != null) {
    details.push({ id: "tokens", label: "Tokens", value: summary.totalTokens.toLocaleString() });
  }

  const renews = formatDate(isoFromString(subscriptionData?.currentPeriodEnd));
  if (renews) details.push({ id: "renews", label: "Renews", value: renews });

  const periodStart = formatDate(isoFromString(subscriptionData?.currentPeriodStart));
  if (periodStart && renews) {
    details.push({ id: "period", label: "Billing period", value: `${periodStart} – ${renews}` });
  }

  return details;
}

async function fetchUsage(input: unknown, fetchApi: typeof fetch = fetch): Promise<UsageReport> {
  const credentials = await readCredentials(inputSchema.parse(input));
  if (!credentials) return { status: "error", error: "Command Code login no longer exists" };

  try {
    const whoamiPath = `/alpha/whoami${query({ limits: "1" })}`;
    const whoami = await getJson(whoamiPath, credentials.apiKey, whoamiBodySchema, fetchApi);
    if (whoami.status === 401 || whoami.status === 403) {
      return unavailable({ kind: "rejected", status: whoami.status });
    }
    if (!whoami.body) return { status: "error", error: "Command Code identity API returned no data" };

    const orgId = whoami.body.org?.id;
    const creditsPath = `/alpha/billing/credits${query({ orgId })}`;
    const subscriptionPath = `/alpha/billing/subscriptions${query({ orgId })}`;

    const [credits, subscription] = await Promise.all([
      getJson(creditsPath, credentials.apiKey, creditsBodySchema, fetchApi),
      getOptionalJson(subscriptionPath, credentials.apiKey, subscriptionBodySchema, fetchApi),
    ]);

    if (credits.status === 401 || credits.status === 403) {
      return unavailable({ kind: "rejected", status: credits.status });
    }
    if (!credits.body) return { status: "error", error: "Command Code usage API returned no data" };

    const since = subscription?.data?.currentPeriodStart;
    const summaryPath = `/alpha/usage/summary${query({ orgId, since })}`;
    const summary =
      (await getOptionalJson(summaryPath, credentials.apiKey, summaryBodySchema, fetchApi)) ?? null;

    const details = buildDetails(subscription, summary);
    const windows = buildWindows(credits.body, details);
    const balances = buildBalances(credits.body, subscription, summary, whoami.body, details);
    const planId = subscription?.data?.planId ?? credits.body.credits?.planId;
    const label = planLabel(planId);

    if (windows.length === 0 && balances.length === 0 && details.length === 0) {
      return unavailable({ kind: "no_quota", detail: "No billing data found" });
    }

    return {
      status: "available",
      planLabel: label,
      windows,
      balances,
      details,
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createUsageSource(): UsageSourceRegistration {
  return {
    id: "command-code",
    label: "Command Code",
    icon: "icon.svg",
    input: inputSchema,
    discover,
    fetch: (input) => fetchUsage(input),
  };
}
