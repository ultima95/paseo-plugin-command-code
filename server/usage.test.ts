import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageSource } from "./usage";

const scratch: string[] = [];

async function authFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-command-code-usage-"));
  scratch.push(dir);
  const path = join(dir, "auth.json");
  await writeFile(path, JSON.stringify({ apiKey: "test-key", userName: "ultima95" }), "utf8");
  return path;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Command Code usage source", () => {
  it("shows the credit amount in the card but only percent and countdown when pinned", async () => {
    const periodEnd = new Date(Date.now() + 22 * 86_400_000 + 3_600_000).toISOString();
    const periodStart = new Date(Date.now() - 8 * 86_400_000).toISOString();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/alpha/whoami")) {
          return json({
            user: { id: "user-1", userName: "ultima95" },
            org: { id: "org-1" },
            orgLimits: [],
          });
        }
        if (path.endsWith("/alpha/billing/credits")) {
          return json({
            credits: {
              planId: "individual-goat",
              monthlyCredits: 19.55,
              purchasedCredits: 0,
              freeCredits: 0,
            },
            sandboxAccess: false,
          });
        }
        if (path.endsWith("/alpha/billing/subscriptions")) {
          return json({
            success: true,
            data: {
              status: "active",
              planId: "individual-goat",
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
            },
          });
        }
        if (path.endsWith("/alpha/usage/summary")) {
          return json({ totalCost: 53.19 });
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    const report = await createUsageSource().fetch({ store: "file", path: await authFile() });
    expect(report.status).toBe("available");
    if (report.status !== "available") return;

    const credits = report.windows.find((window) => window.id === "credits");
    expect(credits).toMatchObject({
      id: "credits",
      label: "Credits · 19.55 left",
      shortLabel: "22d left",
      usedPct: 72.07,
      resetsAt: periodEnd,
      tone: "warning",
    });
    expect(credits?.remainingPct).toBeCloseTo(27.93);
    expect(report.balances).toEqual([]);
  });
});
