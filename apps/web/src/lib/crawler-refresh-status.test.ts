import { describe, expect, it } from "vitest";
import { parseCrawlerRefreshStatus } from "./crawler-refresh-status";

describe("parseCrawlerRefreshStatus", () => {
  it("accepts an allowed refresh_incomplete warning in the latest run", () => {
    const status = parseCrawlerRefreshStatus({
      available: true,
      running: false,
      source: "scheduled",
      startedAt: "2026-11-12T12:00:00.000Z",
      latestRun: {
        version: 1,
        runId: "run-1",
        source: "scheduled",
        startedAt: "2026-11-12T12:00:00.000Z",
        finishedAt: "2026-11-12T12:01:00.000Z",
        runStatus: "success",
        current: null,
        progress: { completed: 1, total: 1 },
        reason: null,
        timeline: [
          {
            id: "refresh-1",
            label: "一括更新",
            step: "moneyforward_refresh",
            metadata: {
              kind: "refresh",
              maxWaitMinutes: 20,
              remainingAccounts: 0,
              incompleteAccounts: [],
            },
            status: "warning",
            startedAt: "2026-11-12T12:00:00.000Z",
            finishedAt: "2026-11-12T12:00:05.000Z",
            reason: {
              code: "refresh_incomplete",
              message: "一括更新開始を確認できませんでした",
              incompleteAccounts: [],
              accountIssues: [],
            },
          },
        ],
      },
    });

    expect(status.latestRun?.timeline[0]).toMatchObject({
      status: "warning",
      reason: { code: "refresh_incomplete" },
    });
  });
});
