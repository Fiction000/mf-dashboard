import type { Page } from "playwright";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * 一時的で、もう一度 goto すれば通る遷移エラーかどうか。
 *
 * - net::ERR_ABORTED: 遷移中に別の遷移が始まった（Chromium 側の表現）
 * - interrupted by another navigation: 同じ状況の Playwright 側の表現。
 *   MF の /accounts は更新中に自分で location.reload() するため、
 *   こちらの goto とぶつかるとこちらが出る。
 * - Timeout: MF 側の応答遅延
 */
export function isRetryableNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("net::ERR_ABORTED") ||
    message.includes("interrupted by another navigation") ||
    message.includes("Timeout")
  );
}

export interface GotoWithRetryOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  timeout?: number;
}

export async function gotoWithRetry(
  page: Page,
  url: string,
  options: GotoWithRetryOptions = {},
): Promise<void> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      });
      return;
    } catch (err) {
      if (page.isClosed() || !isRetryableNavigationError(err) || attempt === maxRetries) {
        throw err;
      }

      // A crashed Playwright page can reject page.waitForTimeout() and mask the
      // original navigation error. Use a process timer between attempts instead.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}
