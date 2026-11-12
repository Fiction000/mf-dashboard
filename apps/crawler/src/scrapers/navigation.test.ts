import type { Page } from "playwright";
import { describe, expect, test, vi } from "vitest";
import { gotoWithRetry, isRetryableNavigationError } from "./navigation.js";

const INTERRUPTED =
  'page.goto: Navigation to "https://moneyforward.com/accounts" is interrupted by another navigation to "https://moneyforward.com/accounts"';

function fakePage(goto: ReturnType<typeof vi.fn>, closed = false): Page {
  return {
    goto,
    isClosed: vi.fn<() => boolean>().mockReturnValue(closed),
  } as unknown as Page;
}

describe("isRetryableNavigationError", () => {
  test.each([
    "page.goto: net::ERR_ABORTED at https://moneyforward.com/accounts",
    "page.goto: Timeout 30000ms exceeded.",
    INTERRUPTED,
  ])("一時的な遷移エラーは再試行対象: %s", (message) => {
    expect(isRetryableNavigationError(new Error(message))).toBe(true);
  });

  test.each(["page.goto: Page crashed", "page.goto: net::ERR_NAME_NOT_RESOLVED"])(
    "それ以外は再試行しない: %s",
    (message) => {
      expect(isRetryableNavigationError(new Error(message))).toBe(false);
    },
  );
});

describe("gotoWithRetry", () => {
  test("MF 自身の再読み込みに2回割り込まれても3回目で遷移できる", async () => {
    const goto = vi
      .fn<(...args: any[]) => any>()
      .mockRejectedValueOnce(new Error(INTERRUPTED))
      .mockRejectedValueOnce(new Error(INTERRUPTED))
      .mockResolvedValueOnce(null);

    await gotoWithRetry(fakePage(goto), "https://moneyforward.com/accounts", {
      retryDelayMs: 0,
      timeout: 60000,
    });

    expect(goto).toHaveBeenCalledTimes(3);
    expect(goto).toHaveBeenLastCalledWith(
      "https://moneyforward.com/accounts",
      expect.objectContaining({ timeout: 60000, waitUntil: "domcontentloaded" }),
    );
  });

  test("再試行を使い切ったら最後のエラーを返す", async () => {
    const last = new Error(INTERRUPTED);
    const goto = vi
      .fn<(...args: any[]) => any>()
      .mockRejectedValueOnce(new Error(INTERRUPTED))
      .mockRejectedValueOnce(new Error(INTERRUPTED))
      .mockRejectedValueOnce(last);

    await expect(
      gotoWithRetry(fakePage(goto), "https://moneyforward.com/accounts", { retryDelayMs: 0 }),
    ).rejects.toBe(last);
    expect(goto).toHaveBeenCalledTimes(3);
  });

  test("ページが閉じていたら再試行しない", async () => {
    const error = new Error(INTERRUPTED);
    const goto = vi.fn<(...args: any[]) => any>().mockRejectedValue(error);

    await expect(
      gotoWithRetry(fakePage(goto, true), "https://moneyforward.com/", { retryDelayMs: 0 }),
    ).rejects.toBe(error);
    expect(goto).toHaveBeenCalledOnce();
  });
});
