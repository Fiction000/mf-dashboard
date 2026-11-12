import type { Page } from "playwright";
import { describe, expect, test, vi } from "vitest";
import {
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
  ])("一時的な遷移エラーを1回だけ再試行する: %s", async (message) => {
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
  const loadingResponse = (loading: boolean[], status = 200) => ({
    status: () => status,
    headers: () => ({ "content-type": "application/json" }),
    url: () => "https://moneyforward.com/accounts/loading_statuses",
    json: vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(
        loading.map((isLoading, index) => ({ id: "9007199254740993" + index, loading: isLoading })),
      ),
  });

  function makePage(responses: ReturnType<typeof loadingResponse>[]) {
    const click = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const goto = vi.fn<(...args: any[]) => any>().mockResolvedValue(null);
    const get = vi.fn<(...args: any[]) => any>();
    for (const response of responses) get.mockResolvedValueOnce(response);
    if (responses.length > 0) get.mockResolvedValue(responses[responses.length - 1]);

    const rows = {
      count: vi.fn<() => Promise<number>>().mockResolvedValue(1),
      nth: vi.fn<() => any>().mockReturnValue({
        locator: (selector: string) => {
          if (selector === "td.account-status") {
            return { allTextContents: async () => ["更新中"] };
          }
          if (selector === "td.service a") {
            return { first: () => ({ count: async () => 1, textContent: async () => "Bank A" }) };
          }
          return { first: () => ({ textContent: async () => "Bank A" }) };
        },
      }),
    };
    const now = { value: 0 };
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now.value);
    const page = {
      goto,
      isClosed: vi.fn<() => boolean>().mockReturnValue(false),
      request: { get },
      waitForTimeout: vi.fn<(ms: number) => Promise<void>>().mockImplementation(async (ms) => {
        now.value += ms;
      }),
      locator: vi.fn<(selector: string) => any>((selector) =>
        selector === 'a:has-text("一括更新")' ? { first: () => ({ click }) } : rows,
      ),
    } as unknown as Page;
    return { click, dateNow, get, goto, page };
  }

  test("loadingを観測後に0件となれば完了し、polling中にaccountsへ遷移しない", async () => {
    const { click, dateNow, get, goto, page } = makePage([
      loadingResponse([true]),
      loadingResponse([false]),
    ]);
    try {
      await expect(
        clickRefreshButton(page, { maxWaitMinutes: 0.001, pollIntervalMs: 10 }),
      ).resolves.toEqual({ completed: true, incompleteAccounts: [] });
      expect(click).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledTimes(2);
      expect(get).toHaveBeenCalledWith("https://moneyforward.com/accounts/loading_statuses", {
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      expect(goto.mock.calls.map(([url]) => url)).toEqual(["https://moneyforward.com/"]);
    } finally {
      dateNow.mockRestore();
    }
  });

  test("start window内にloadingが観測されなければnot_observedを返す", async () => {
    const { dateNow, get, goto, page } = makePage([loadingResponse([false])]);
    try {
      await expect(
        clickRefreshButton(page, { maxWaitMinutes: 0.001, pollIntervalMs: 10, startWindowMs: 25 }),
      ).resolves.toEqual({
        completed: false,
        incompleteAccounts: [],
        remainingCount: 0,
        reason: "not_observed",
      });
      expect(get).toHaveBeenCalledTimes(3);
      expect(goto.mock.calls.map(([url]) => url)).toEqual(["https://moneyforward.com/"]);
    } finally {
      dateNow.mockRestore();
    }
  });

  test("timeout時にaccountsへ1回だけ遷移して更新中の名称を返す", async () => {
    const { dateNow, get, goto, page } = makePage([loadingResponse([true])]);
    try {
      await expect(
        clickRefreshButton(page, { maxWaitMinutes: 0.001, pollIntervalMs: 10, startWindowMs: 5 }),
      ).resolves.toEqual({ completed: false, incompleteAccounts: ["Bank A"], remainingCount: 1 });
      expect(get).toHaveBeenCalled();
      expect(goto.mock.calls.map(([url]) => url)).toEqual([
        "https://moneyforward.com/",
        "https://moneyforward.com/accounts",
      ]);
    } finally {
      dateNow.mockRestore();
    }
  });

  test("timeout時の名称取得に失敗してもloading件数を保って返す", async () => {
    const { dateNow, goto, page } = makePage([loadingResponse([true])]);
    try {
      goto.mockImplementation(async (url: string) => {
        if (url.endsWith("/accounts")) throw new Error("accounts visit failed");
        return null;
      });
      await expect(
        clickRefreshButton(page, { maxWaitMinutes: 0.001, pollIntervalMs: 10, startWindowMs: 5 }),
      ).resolves.toEqual({ completed: false, incompleteAccounts: [], remainingCount: 1 });
      expect(goto.mock.calls.map(([url]) => url)).toEqual([
        "https://moneyforward.com/",
        "https://moneyforward.com/accounts",
      ]);
    } finally {
      dateNow.mockRestore();
    }
  });

  test.each([
    [302, [{ id: "1", loading: true }]],
    [500, [{ id: "1", loading: true }]],
    [200, { id: "1", loading: true }],
  ])("invalid endpoint response status=%s rejects", async (status, body) => {
    const { dateNow, get, page } = makePage([loadingResponse([false])]);
    try {
      const response = {
        ...loadingResponse([false], status),
        json: vi.fn<() => Promise<unknown>>().mockResolvedValue(body),
      };
      get.mockResolvedValue(response);
      await expect(
        clickRefreshButton(page, { maxWaitMinutes: 0.001, pollIntervalMs: 10 }),
      ).rejects.toThrow(/https:\/\/moneyforward\.com\/accounts\/loading_statuses.*status/);
    } finally {
      dateNow.mockRestore();
    }
  });
});
