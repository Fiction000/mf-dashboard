import type { Page } from "playwright";
import { describe, expect, test, vi } from "vitest";
import { gotoWithAbortRetry } from "./navigation.js";

function createPage(gotoResults: Array<Error | undefined>, closed = false) {
  const goto = vi.fn<Page["goto"]>();
  for (const result of gotoResults) {
    if (result) goto.mockRejectedValueOnce(result);
    else goto.mockResolvedValueOnce(null);
  }
  return { goto, isClosed: vi.fn<Page["isClosed"]>(() => closed) } as unknown as Page & {
    goto: ReturnType<typeof vi.fn>;
  };
}

const aborted = () =>
  new Error("page.goto: net::ERR_ABORTED at https://moneyforward.com/bs/history");
const options = { retryDelayMs: 0 };

describe("gotoWithAbortRetry", () => {
  test("ERR_ABORTED は同じURLへ再試行して成功する", async () => {
    const page = createPage([aborted(), undefined]);

    await gotoWithAbortRetry(page, "https://moneyforward.com/bs/history", options);

    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.goto).toHaveBeenLastCalledWith("https://moneyforward.com/bs/history", {
      waitUntil: "domcontentloaded",
    });
  });

  test("連続で中断されても上限までは再試行する", async () => {
    const page = createPage([aborted(), aborted(), undefined]);

    await gotoWithAbortRetry(page, "https://moneyforward.com/bs/history", options);

    expect(page.goto).toHaveBeenCalledTimes(3);
  });

  test("上限を超えて中断が続いたら元のエラーを投げる", async () => {
    const page = createPage([aborted(), aborted(), aborted()]);

    await expect(
      gotoWithAbortRetry(page, "https://moneyforward.com/bs/history", options),
    ).rejects.toThrow("net::ERR_ABORTED");
    expect(page.goto).toHaveBeenCalledTimes(3);
  });

  test("ERR_ABORTED 以外のエラーは再試行しない", async () => {
    const page = createPage([new Error("page.goto: net::ERR_NAME_NOT_RESOLVED")]);

    await expect(
      gotoWithAbortRetry(page, "https://moneyforward.com/bs/history", options),
    ).rejects.toThrow("ERR_NAME_NOT_RESOLVED");
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  test("ページが閉じられていたら再試行しない", async () => {
    const page = createPage([aborted()], true);

    await expect(
      gotoWithAbortRetry(page, "https://moneyforward.com/bs/history", options),
    ).rejects.toThrow("net::ERR_ABORTED");
    expect(page.goto).toHaveBeenCalledTimes(1);
  });
});
