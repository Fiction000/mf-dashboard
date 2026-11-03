import type { Page } from "playwright";

const MAX_ABORT_RETRIES = 2;
const ABORT_RETRY_DELAY_MS = 2000;

interface AbortRetryOptions {
  retryDelayMs?: number;
}

function isAbortedNavigation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("net::ERR_ABORTED");
}

/**
 * MoneyForward は直前のページの遷移や自動リダイレクトと競合すると、
 * goto が ERR_ABORTED で中断されることがある。同じ URL へ数回だけ再試行する。
 */
export async function gotoWithAbortRetry(
  page: Page,
  url: string,
  options: AbortRetryOptions = {},
): Promise<void> {
  const retryDelayMs = options.retryDelayMs ?? ABORT_RETRY_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return;
    } catch (err) {
      if (page.isClosed() || !isAbortedNavigation(err) || attempt >= MAX_ABORT_RETRIES) {
        throw err;
      }
      // A crashed page rejects page.waitForTimeout(), so wait on a process timer.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}
