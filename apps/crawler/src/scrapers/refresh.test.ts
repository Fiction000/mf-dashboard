import type { Page } from "playwright";
import { describe, expect, test, vi } from "vitest";
import {
  classifyAccountIssues,
  clickRefreshButton,
  getMaxWaitMinutes,
  getRefreshStatus,
  navigateToAccountsPage,
  summarizeRefreshRows,
  type RefreshStatusRow,
} from "./refresh.js";

describe("getMaxWaitMinutes", () => {
  test.each([undefined, "", "0", "-1", "Infinity", "NaN"])(
    "invalid MAX_WAIT_MINUTES=%s は default 値を返す",
    (value) => {
      expect(getMaxWaitMinutes({ MAX_WAIT_MINUTES: value })).toBe(20);
    },
  );

  test("有限の正数を返す", () => {
    expect(getMaxWaitMinutes({ MAX_WAIT_MINUTES: "12.5" })).toBe(12.5);
  });
});

describe("summarizeRefreshRows", () => {
  test.each<{
    expected: { incompleteAccounts: string[]; remainingCount: number };
    name: string;
    rows: RefreshStatusRow[];
  }>([
    {
      name: "更新中のアカウント名と件数を返す",
      rows: [
        { name: "Institution A", statuses: ["更新中"] },
        { name: "Institution B", statuses: ["正常"] },
        { name: "Institution C", statuses: ["更新中"] },
      ],
      expected: {
        incompleteAccounts: ["Institution A", "Institution C"],
        remainingCount: 2,
      },
    },
    {
      name: "複数の状態セルに更新中があれば1件として数える",
      rows: [{ name: "Institution A", statuses: ["更新中", "正常"] }],
      expected: { incompleteAccounts: ["Institution A"], remainingCount: 1 },
    },
    {
      name: "完全一致しない状態は更新中として数えない",
      rows: [
        { name: "Institution A", statuses: ["更新中 → 一時停止中"] },
        { name: "Institution B", statuses: ["再更新中"] },
      ],
      expected: { incompleteAccounts: [], remainingCount: 0 },
    },
    {
      name: "空の行一覧は0件を返す",
      rows: [],
      expected: { incompleteAccounts: [], remainingCount: 0 },
    },
    {
      name: "名称がない更新中行も件数には含める",
      rows: [{ name: null, statuses: [" 更新中 "] }],
      expected: { incompleteAccounts: [], remainingCount: 1 },
    },
    {
      name: "空白のみの名称は除外し更新中行を件数には含める",
      rows: [{ name: " \t ", statuses: ["更新中"] }],
      expected: { incompleteAccounts: [], remainingCount: 1 },
    },
  ])("$name", ({ rows, expected }) => {
    expect(summarizeRefreshRows(rows)).toEqual(expected);
  });
});

describe("getRefreshStatus", () => {
  test("service linkがない更新中行は先頭セルの名称を使う", async () => {
    const statusCells = {
      allTextContents: vi.fn<() => Promise<string[]>>().mockResolvedValue(["更新中"]),
    };
    const nameLink = {
      count: vi.fn<() => Promise<number>>().mockResolvedValue(0),
    };
    const firstCell = {
      textContent: vi.fn<() => Promise<string | null>>().mockResolvedValue(" Institution A "),
    };
    const allCells = {
      first: vi.fn<() => typeof firstCell>().mockReturnValue(firstCell),
    };
    const nameLinkLocator = {
      first: vi.fn<() => typeof nameLink>().mockReturnValue(nameLink),
    };
    const row = {
      locator: vi.fn<
        (selector: string) => typeof statusCells | typeof nameLinkLocator | typeof allCells
      >((selector) => {
        if (selector === "td.account-status") return statusCells;
        if (selector === "td.service a") return nameLinkLocator;
        return allCells;
      }),
    };
    const rows = {
      count: vi.fn<() => Promise<number>>().mockResolvedValue(1),
      nth: vi.fn<() => typeof row>().mockReturnValue(row),
    };
    const page = {
      locator: vi.fn<() => typeof rows>().mockReturnValue(rows),
    } as unknown as Page;

    await expect(getRefreshStatus(page)).resolves.toEqual({
      incompleteAccounts: ["Institution A"],
      remainingCount: 1,
    });
    expect(firstCell.textContent).toHaveBeenCalledOnce();
  });
});

describe("navigateToAccountsPage", () => {
  test.each([
    "page.goto: net::ERR_ABORTED at https://moneyforward.com/accounts",
    "page.goto: Timeout 30000ms exceeded.",
    'page.goto: Navigation to "https://moneyforward.com/accounts" is interrupted by another navigation to "https://moneyforward.com/accounts"',
  ])("一時的な遷移エラーを再試行する: %s", async (message) => {
    const goto = vi
      .fn<(...args: any[]) => any>()
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce(null);
    const isClosed = vi.fn<(...args: any[]) => any>().mockReturnValue(false);
    const retryPage = { goto, isClosed } as unknown as Page;

    await navigateToAccountsPage(retryPage, { retryDelayMs: 0 });

    expect(goto).toHaveBeenCalledTimes(2);
    expect(goto).toHaveBeenCalledWith(
      "https://moneyforward.com/accounts",
      expect.objectContaining({ timeout: 60000, waitUntil: "domcontentloaded" }),
    );
  });

  test("Page crashedは再試行せず元のエラーを返す", async () => {
    const error = new Error("page.goto: Page crashed");
    const goto = vi.fn<(...args: any[]) => any>().mockRejectedValue(error);
    const page = {
      goto,
      isClosed: vi.fn<(...args: any[]) => any>().mockReturnValue(false),
    } as unknown as Page;

    await expect(navigateToAccountsPage(page, { retryDelayMs: 0 })).rejects.toBe(error);
    expect(goto).toHaveBeenCalledOnce();
  });
});

describe("clickRefreshButton", () => {
  test("ホームが networkidle にならなくても一括更新を押して完了まで進む", async () => {
    const click = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const statusRows = { count: vi.fn<() => Promise<number>>().mockResolvedValue(0) };
    const page = {
      goto: vi.fn<(...args: any[]) => any>().mockResolvedValue(null),
      isClosed: vi.fn<() => boolean>().mockReturnValue(false),
      waitForLoadState: vi
        .fn<(state?: string) => Promise<void>>()
        .mockImplementation(async (state) => {
          if (state === "networkidle") {
            throw new Error("page.waitForLoadState: Timeout 30000ms exceeded.");
          }
        }),
      waitForTimeout: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      locator: vi.fn<(selector: string) => any>((selector) =>
        selector === 'a:has-text("一括更新")' ? { first: () => ({ click }) } : statusRows,
      ),
    } as unknown as Page;

    await expect(
      clickRefreshButton(page, { maxWaitMinutes: 1, pollIntervalMs: 0 }),
    ).resolves.toEqual({ completed: true, incompleteAccounts: [] });
    expect(click).toHaveBeenCalledOnce();
  });
});

describe("classifyAccountIssues", () => {
  test("正常と停止中は数えず、更新中とエラー表示の口座だけを状態付きで返す", () => {
    expect(
      classifyAccountIssues([
        { name: " Bank A ", statuses: ["正常"] },
        { name: "Bank B", statuses: ["更新中"] },
        { name: "Card C", statuses: [" 重要なお知らせがあります "] },
        { name: "Old D", statuses: ["取得を停止しています"] },
        { name: "Empty E", statuses: [" "] },
      ]),
    ).toEqual({
      checkedCount: 3,
      issues: [
        { name: "Bank B", status: "updating", message: "更新中" },
        { name: "Card C", status: "error", message: "重要なお知らせがあります" },
      ],
    });
  });

  test("名前のない行は「名称不明」として残す", () => {
    expect(classifyAccountIssues([{ name: null, statuses: ["エラー"] }]).issues).toEqual([
      { name: "名称不明", status: "error", message: "エラー" },
    ]);
  });
});

describe("clickRefreshButton の更新待ち", () => {
  test("一括更新を押したあと /accounts への遷移が失敗しても throw せず wait_failed を返す", async () => {
    const click = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const goto = vi.fn<(url: string) => Promise<null>>().mockImplementation(async (url) => {
      if (url.endsWith("/accounts")) throw new Error("page.goto: Page crashed");
      return null;
    });
    const page = {
      goto,
      isClosed: vi.fn<() => boolean>().mockReturnValue(false),
      waitForTimeout: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      locator: vi.fn<(selector: string) => any>(() => ({ first: () => ({ click }) })),
    } as unknown as Page;

    await expect(
      clickRefreshButton(page, { maxWaitMinutes: 1, pollIntervalMs: 0 }),
    ).resolves.toMatchObject({ completed: false, reason: "wait_failed" });
    expect(click).toHaveBeenCalledOnce();
  });

  test("一括更新ボタンを押す前の失敗はそのまま throw する", async () => {
    const page = {
      goto: vi
        .fn<() => Promise<null>>()
        .mockRejectedValue(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED")),
      isClosed: vi.fn<() => boolean>().mockReturnValue(false),
    } as unknown as Page;

    await expect(
      clickRefreshButton(page, { maxWaitMinutes: 1, pollIntervalMs: 0 }),
    ).rejects.toThrow("ERR_NAME_NOT_RESOLVED");
  });
});
