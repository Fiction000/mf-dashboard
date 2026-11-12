import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCrawlerProgressReporter } from "./crawler-progress.js";
import { scrapeAllGroups } from "./scraper.js";
import { getAssetHistory } from "./scrapers/asset-history.js";
import { getAssetItems } from "./scrapers/asset-items.js";
import { getAssetSummary } from "./scrapers/asset-summary.js";
import { getCashFlow } from "./scrapers/cash-flow.js";
import { getAllGroups, getCurrentGroup, switchGroup } from "./scrapers/group.js";
import { getLiabilities } from "./scrapers/liabilities.js";
import { getManualHoldingAccountMap } from "./scrapers/manual-holding-accounts.js";
import { getLinkedAccountDetailSource, getPortfolio } from "./scrapers/portfolio.js";
import { clickRefreshButton, getAccountIssues } from "./scrapers/refresh.js";
import { getRegisteredAccounts } from "./scrapers/registered-accounts.js";
import { getSpendingTargets } from "./scrapers/spending-targets.js";

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn<(...args: unknown[]) => void>(),
  log: vi.fn<(...args: unknown[]) => void>(),
  phase: vi.fn<(title: string) => void>(),
  warn: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock("./logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./logger.js")>()),
  ...loggerMocks,
}));

vi.mock("./scrapers/asset-history.js", () => ({ getAssetHistory: vi.fn<() => void>() }));
vi.mock("./scrapers/asset-items.js", () => ({ getAssetItems: vi.fn<() => void>() }));
vi.mock("./scrapers/asset-summary.js", () => ({ getAssetSummary: vi.fn<() => void>() }));
vi.mock("./scrapers/cash-flow.js", () => ({ getCashFlow: vi.fn<() => void>() }));
vi.mock("./scrapers/group.js", () => ({
  NO_GROUP_ID: "0",
  isNoGroup: (id: string) => id === "0",
  getAllGroups: vi.fn<() => void>(),
  getCurrentGroup: vi.fn<() => void>(),
  switchGroup: vi.fn<() => void>(),
}));
vi.mock("./scrapers/liabilities.js", () => ({ getLiabilities: vi.fn<() => void>() }));
vi.mock("./scrapers/manual-holding-accounts.js", () => ({
  getManualHoldingAccountMap: vi.fn<() => void>(),
}));
vi.mock("./scrapers/portfolio.js", () => ({
  getLinkedAccountDetailSource: vi.fn<() => void>(),
  getPortfolio: vi.fn<() => void>(),
}));
vi.mock("./scrapers/refresh.js", () => ({
  clickRefreshButton: vi.fn<() => void>(),
  getAccountIssues: vi.fn<() => void>(),
  getMaxWaitMinutes: () => 20,
}));
vi.mock("./scrapers/registered-accounts.js", () => ({
  getRegisteredAccounts: vi.fn<() => void>(),
}));
vi.mock("./scrapers/spending-targets.js", () => ({
  getSpendingTargets: vi.fn<() => void>(),
}));

let tempDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tempDir = await mkdtemp(path.join(os.tmpdir(), "crawler-scraper-progress-"));
  vi.mocked(getCurrentGroup).mockResolvedValue(null);
  vi.mocked(getAllGroups).mockResolvedValue([{ id: "group-a", name: "Group A", isCurrent: false }]);
  vi.mocked(clickRefreshButton).mockResolvedValue({
    completed: false,
    incompleteAccounts: ["Institution A", "Institution B"],
  });
  vi.mocked(getAccountIssues).mockResolvedValue({ issues: [], checkedCount: 0 });
  vi.mocked(getRegisteredAccounts).mockResolvedValue({ accounts: [] });
  vi.mocked(getManualHoldingAccountMap).mockResolvedValue(new Map());
  vi.mocked(getLinkedAccountDetailSource).mockResolvedValue({
    complete: true,
    fingerprints: [],
    items: [],
    scheduledWithdrawals: new Map(),
  });
  vi.mocked(getPortfolio).mockResolvedValue({ items: [], totalAssets: 0 });
  vi.mocked(getLiabilities).mockResolvedValue({ items: [], totalLiabilities: 0 });
  vi.mocked(getCashFlow).mockResolvedValue({
    month: "2026-07",
    totalIncome: 0,
    totalExpense: 0,
    balance: 0,
    items: [],
  });
  vi.mocked(getAssetSummary).mockResolvedValue({
    totalAssets: "0",
    dailyChange: "0",
    dailyChangePercent: "0%",
    monthlyChange: "0",
    monthlyChangePercent: "0%",
  });
  vi.mocked(getAssetItems).mockResolvedValue([]);
  vi.mocked(getAssetHistory).mockResolvedValue({ points: [] });
  vi.mocked(getSpendingTargets).mockResolvedValue({ categories: [] });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("scraper progress", () => {
  test("scrape logsにgroup名や残高を含めない", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getCurrentGroup).mockResolvedValue({
      id: "private-group-id",
      name: "private-group-name",
      isCurrent: true,
    });
    vi.mocked(getAllGroups).mockResolvedValue([
      { id: "private-group-id", name: "private-group-name", isCurrent: true },
    ]);
    vi.mocked(getAssetSummary).mockResolvedValue({
      totalAssets: "private-balance",
      dailyChange: "0",
      dailyChangePercent: "0%",
      monthlyChange: "0",
      monthlyChangePercent: "0%",
    });
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    try {
      await scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress, {
        skipRefresh: true,
      });
      const diagnostics = JSON.stringify([
        ...consoleLog.mock.calls,
        ...consoleWarn.mock.calls,
        ...consoleError.mock.calls,
        ...loggerMocks.log.mock.calls,
        ...loggerMocks.warn.mock.calls,
        ...loggerMocks.error.mock.calls,
        ...loggerMocks.phase.mock.calls,
      ]);
      expect(diagnostics).not.toContain("private-group-id");
      expect(diagnostics).not.toContain("private-group-name");
      expect(diagnostics).not.toContain("private-balance");
    } finally {
      consoleLog.mockRestore();
      consoleWarn.mockRestore();
      consoleError.mockRestore();
    }
  });

  test("group discovery 失敗をグループ一覧 step に記録する", async () => {
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });
    vi.mocked(getAllGroups).mockRejectedValueOnce(new Error("page closed"));

    await expect(
      scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress),
    ).rejects.toThrow("page closed");

    expect(progress.getState().timeline).toContainEqual(
      expect.objectContaining({ step: "group_list", status: "failed" }),
    );
    expect(switchGroup).not.toHaveBeenCalled();
  });

  test("初期 group 切り替え失敗を一括更新 step に記録する", async () => {
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });
    vi.mocked(switchGroup).mockRejectedValueOnce(new Error("selector not found"));

    await expect(
      scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress),
    ).rejects.toThrow("selector not found");

    expect(progress.getState().timeline).toContainEqual(
      expect.objectContaining({
        step: "moneyforward_refresh",
        status: "failed",
        reason: expect.objectContaining({ code: "selector_not_found" }),
      }),
    );
    expect(clickRefreshButton).not.toHaveBeenCalled();
  });

  test("refresh 前に group なし view へ切り替える", async () => {
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress);

    expect(vi.mocked(switchGroup).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(clickRefreshButton).mock.invocationCallOrder[0]!,
    );
  });

  test.each([
    ["登録口座", getRegisteredAccounts, "registered_accounts"],
    ["通常口座詳細", getLinkedAccountDetailSource, "portfolio"],
    ["ポートフォリオ", getPortfolio, "portfolio"],
    ["負債", getLiabilities, "liabilities"],
  ] as const)("%s の取得失敗を対応する step に記録する", async (_label, getData, step) => {
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });
    vi.mocked(getData).mockRejectedValueOnce(new Error("request failed"));

    await expect(
      scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress),
    ).rejects.toThrow("request failed");

    expect(progress.getState().timeline).toContainEqual(
      expect.objectContaining({ step, status: "failed" }),
    );
  });

  test("SKIP_REFRESH の refresh step を skipped にする", async () => {
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });

    await scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress, {
      skipRefresh: true,
    });

    expect(progress.getState().timeline).toContainEqual(
      expect.objectContaining({ step: "moneyforward_refresh", status: "skipped" }),
    );
    expect(clickRefreshButton).not.toHaveBeenCalled();
  });

  test("refresh 完了時に待機中の未完了機関 metadata を消去する", async () => {
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });
    vi.mocked(clickRefreshButton).mockImplementation(async (_page, options) => {
      await options?.onWaiting?.({
        elapsedSeconds: 30,
        incompleteAccounts: ["Institution A"],
        maxWaitMinutes: 20,
        nextCheckSeconds: 30,
        remainingCount: 1,
      });
      return { completed: true, incompleteAccounts: [] };
    });

    await scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress);

    expect(progress.getState().timeline).toContainEqual(
      expect.objectContaining({
        step: "moneyforward_refresh",
        status: "done",
        metadata: expect.objectContaining({ remainingAccounts: 0, incompleteAccounts: [] }),
      }),
    );
  });

  test("group 切り替え失敗を対象 group name の failed step にする", async () => {
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });
    vi.mocked(switchGroup)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("selector not found"));

    await expect(
      scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress),
    ).rejects.toThrow("selector not found");

    expect(progress.getState().timeline).toContainEqual(
      expect.objectContaining({
        step: "group_data",
        status: "failed",
        metadata: { kind: "group", groupName: "Group A" },
        reason: expect.objectContaining({ code: "selector_not_found" }),
      }),
    );
  });

  test("refresh timeout を warning にし、未完了機関と group name を保持する", async () => {
    const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
      id: "run-a",
      source: "test",
      startedAt: "2026-07-01T00:00:00.000Z",
    });
    let waitingState = progress.getState();
    vi.mocked(clickRefreshButton).mockImplementation(async (_page, options) => {
      await options?.onWaiting?.({
        elapsedSeconds: 30,
        incompleteAccounts: ["Institution A", "Institution B"],
        maxWaitMinutes: 20,
        nextCheckSeconds: 30,
        remainingCount: 2,
      });
      waitingState = progress.getState();
      return {
        completed: false,
        incompleteAccounts: ["Institution A", "Institution B"],
      };
    });

    await scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress);

    expect(waitingState).toMatchObject({
      current: {
        step: "moneyforward_refresh",
        metadata: expect.objectContaining({
          kind: "refresh",
          maxWaitMinutes: 20,
          remainingAccounts: 2,
          incompleteAccounts: ["Institution A", "Institution B"],
        }),
      },
    });
    expect(progress.getState().timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: "moneyforward_refresh",
          status: "warning",
          reason: expect.objectContaining({ code: "refresh_timeout" }),
          metadata: expect.objectContaining({
            kind: "refresh",
            maxWaitMinutes: 20,
            remainingAccounts: 2,
            incompleteAccounts: ["Institution A", "Institution B"],
          }),
        }),
        expect.objectContaining({
          step: "group_data",
          status: "done",
          metadata: { kind: "group", groupName: "Group A" },
        }),
      ]),
    );
  });

  describe("一部の口座だけ更新できなかったとき", () => {
    async function newProgress() {
      return createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
        id: "run-a",
        source: "test",
        startedAt: "2026-07-01T00:00:00.000Z",
      });
    }

    test("待機上限を超えても取得を続け、未完了・失敗の口座だけを状態付きで warning に残す", async () => {
      const progress = await newProgress();
      vi.mocked(clickRefreshButton).mockResolvedValue({
        completed: false,
        incompleteAccounts: ["Bank A"],
        remainingCount: 1,
        reason: "timeout",
      });
      vi.mocked(getAccountIssues).mockResolvedValue({
        checkedCount: 5,
        issues: [
          { name: "Bank A", status: "updating", message: "更新中" },
          { name: "Card B", status: "error", message: "重要なお知らせがあります" },
        ],
      });

      await expect(
        scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress),
      ).resolves.toBeDefined();

      const refresh = progress
        .getState()
        .timeline.find((item) => item.step === "moneyforward_refresh");
      expect(refresh).toMatchObject({
        status: "warning",
        reason: {
          code: "refresh_timeout",
          incompleteAccounts: ["Bank A", "Card B"],
          accountIssues: [
            { name: "Bank A", status: "updating", message: "更新中" },
            { name: "Card B", status: "error", message: "重要なお知らせがあります" },
          ],
        },
        metadata: expect.objectContaining({
          remainingAccounts: 2,
          incompleteAccounts: ["Bank A", "Card B"],
        }),
      });
      expect(progress.getState().timeline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ step: "registered_accounts", status: "done" }),
          expect.objectContaining({ step: "portfolio", status: "done" }),
          expect.objectContaining({ step: "group_data", status: "done" }),
        ]),
      );
      const warnings = JSON.stringify(loggerMocks.warn.mock.calls);
      expect(warnings).toContain("Bank A: 更新中のまま");
      expect(warnings).toContain("Card B: エラー（重要なお知らせがあります）");
    });

    test("一括更新は終わったがエラー表示の口座があれば、その口座だけを warning に残す", async () => {
      const progress = await newProgress();
      vi.mocked(clickRefreshButton).mockResolvedValue({ completed: true, incompleteAccounts: [] });
      vi.mocked(getAccountIssues).mockResolvedValue({
        checkedCount: 3,
        issues: [{ name: "Card B", status: "error", message: "ログインに失敗しました" }],
      });

      await scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress);

      expect(progress.getState().timeline).toContainEqual(
        expect.objectContaining({
          step: "moneyforward_refresh",
          status: "warning",
          reason: expect.objectContaining({
            code: "refresh_incomplete",
            incompleteAccounts: ["Card B"],
            accountIssues: [{ name: "Card B", status: "error", message: "ログインに失敗しました" }],
          }),
        }),
      );
    });

    test("更新待ちの途中で画面遷移が失敗しても、run を落とさず warning にして取得を続ける", async () => {
      const progress = await newProgress();
      vi.mocked(clickRefreshButton).mockResolvedValue({
        completed: false,
        incompleteAccounts: [],
        remainingCount: 1,
        reason: "wait_failed",
      });
      vi.mocked(getAccountIssues).mockRejectedValue(new Error("page.goto: Page crashed"));

      await scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress);

      expect(progress.getState().timeline).toContainEqual(
        expect.objectContaining({
          step: "moneyforward_refresh",
          status: "warning",
          reason: expect.objectContaining({ code: "refresh_incomplete", accountIssues: [] }),
        }),
      );
      expect(getRegisteredAccounts).toHaveBeenCalled();
    });

    test("一括更新は終わったが口座ごとの状態を読めなければ、done にせず warning で残す", async () => {
      const progress = await newProgress();
      vi.mocked(clickRefreshButton).mockResolvedValue({
        completed: true,
        incompleteAccounts: [],
        remainingCount: 0,
      });
      vi.mocked(getAccountIssues).mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));

      await scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress);

      expect(progress.getState().timeline).toContainEqual(
        expect.objectContaining({
          step: "moneyforward_refresh",
          status: "warning",
          reason: expect.objectContaining({
            code: "refresh_incomplete",
            message: "口座ごとの更新状態を確認できませんでした",
          }),
        }),
      );
      expect(progress.getState().timeline).not.toContainEqual(
        expect.objectContaining({ step: "moneyforward_refresh", status: "done" }),
      );
    });

    test("一括更新は終わったが口座一覧を開けなければ、run を失敗させる", async () => {
      const progress = await newProgress();
      vi.mocked(clickRefreshButton).mockResolvedValue({
        completed: true,
        incompleteAccounts: [],
        remainingCount: 0,
      });
      vi.mocked(getAccountIssues).mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));
      vi.mocked(getRegisteredAccounts).mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));

      await expect(
        scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress),
      ).rejects.toThrow("net::ERR_CONNECTION_RESET");
      expect(progress.getState().timeline).toContainEqual(
        expect.objectContaining({ step: "registered_accounts", status: "failed" }),
      );
      expect(progress.getState().timeline).not.toContainEqual(
        expect.objectContaining({ step: "moneyforward_refresh", status: "done" }),
      );
    });

    test("待機上限を超えても、再確認で全口座が正常なら done にする", async () => {
      const progress = await newProgress();
      vi.mocked(clickRefreshButton).mockResolvedValue({
        completed: false,
        incompleteAccounts: ["Bank A"],
        remainingCount: 1,
        reason: "timeout",
      });
      vi.mocked(getAccountIssues).mockResolvedValue({ checkedCount: 3, issues: [] });

      await scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress);

      expect(progress.getState().timeline).toContainEqual(
        expect.objectContaining({ step: "moneyforward_refresh", status: "done" }),
      );
      expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain("更新できなかった口座");
    });

    test("再確認に失敗しても、待機中に分かっていた口座名で報告する", async () => {
      const progress = await newProgress();
      vi.mocked(clickRefreshButton).mockResolvedValue({
        completed: false,
        incompleteAccounts: ["Bank A"],
        remainingCount: 2,
        reason: "timeout",
      });
      vi.mocked(getAccountIssues).mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));

      await scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress);

      const refresh = progress
        .getState()
        .timeline.find((item) => item.step === "moneyforward_refresh");
      expect(refresh).toMatchObject({
        status: "warning",
        reason: {
          incompleteAccounts: ["Bank A"],
          accountIssues: [{ name: "Bank A", status: "updating", message: "更新中" }],
        },
      });
      const warnings = JSON.stringify(loggerMocks.warn.mock.calls);
      expect(warnings).toContain("Bank A: 更新中のまま");
      expect(warnings).toContain("口座名を取得できなかった口座: 1件");
    });

    test("全口座が成功なら報告を出さない", async () => {
      const progress = await newProgress();
      vi.mocked(clickRefreshButton).mockResolvedValue({ completed: true, incompleteAccounts: [] });
      vi.mocked(getAccountIssues).mockResolvedValue({ checkedCount: 4, issues: [] });

      await scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress);

      expect(progress.getState().timeline).toContainEqual(
        expect.objectContaining({ step: "moneyforward_refresh", status: "done", reason: null }),
      );
      expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain("更新できなかった口座");
    });
  });

  describe("何も取れなかったとき", () => {
    test("全口座が更新できなかったら refresh step を failed にして run を失敗させる", async () => {
      const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
        id: "run-a",
        source: "test",
        startedAt: "2026-07-01T00:00:00.000Z",
      });
      vi.mocked(clickRefreshButton).mockResolvedValue({
        completed: false,
        incompleteAccounts: ["Bank A", "Card B"],
        remainingCount: 2,
        reason: "timeout",
      });
      vi.mocked(getAccountIssues).mockResolvedValue({
        checkedCount: 2,
        issues: [
          { name: "Bank A", status: "updating", message: "更新中" },
          { name: "Card B", status: "error", message: "エラー" },
        ],
      });

      await expect(
        scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress),
      ).rejects.toThrow(/All MoneyForward accounts failed to refresh/);

      expect(progress.getState().timeline).toContainEqual(
        expect.objectContaining({
          step: "moneyforward_refresh",
          status: "failed",
          reason: expect.objectContaining({ code: "refresh_incomplete" }),
        }),
      );
      expect(getRegisteredAccounts).not.toHaveBeenCalled();
    });

    test("更新待ちのあと口座一覧も開けなければ、今まで通り失敗する", async () => {
      const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
        id: "run-a",
        source: "test",
        startedAt: "2026-07-01T00:00:00.000Z",
      });
      vi.mocked(clickRefreshButton).mockResolvedValue({
        completed: false,
        incompleteAccounts: [],
        reason: "wait_failed",
      });
      vi.mocked(getAccountIssues).mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));
      vi.mocked(getRegisteredAccounts).mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));

      await expect(
        scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress),
      ).rejects.toThrow("net::ERR_CONNECTION_RESET");
      expect(progress.getState().timeline).toContainEqual(
        expect.objectContaining({ step: "registered_accounts", status: "failed" }),
      );
    });

    test("一括更新ボタンを押せないときは今まで通り失敗する", async () => {
      const progress = await createCrawlerProgressReporter(path.join(tempDir, "state.json"), {
        id: "run-a",
        source: "test",
        startedAt: "2026-07-01T00:00:00.000Z",
      });
      vi.mocked(clickRefreshButton).mockRejectedValue(
        new Error("locator.click: Timeout 30000ms exceeded."),
      );

      await expect(
        scrapeAllGroups({} as Parameters<typeof scrapeAllGroups>[0], progress),
      ).rejects.toThrow("locator.click");
      expect(progress.getState().timeline).toContainEqual(
        expect.objectContaining({ step: "moneyforward_refresh", status: "failed" }),
      );
    });
  });
});
