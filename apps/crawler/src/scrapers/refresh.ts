import type { RefreshResult } from "@mf-dashboard/db/types";
import { mfUrls } from "@mf-dashboard/meta/urls";
import type { Page } from "playwright";
import { debug, info, warn } from "../logger.js";

const DEFAULT_MAX_WAIT_MINUTES = 20;
const POLL_INTERVAL_MS = 30000; // 30 seconds
const NAVIGATION_RETRY_DELAY_MS = 1000;
const NAVIGATION_TIMEOUT_MS = 60000;

interface NavigationOptions {
  retryDelayMs?: number;
}

function isRetryableNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("net::ERR_ABORTED") || message.includes("Timeout");
}

export async function navigateToAccountsPage(
  page: Page,
  options: NavigationOptions = {},
): Promise<void> {
  const MAX_RETRIES = 1;
  const retryDelayMs = options.retryDelayMs ?? NAVIGATION_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.goto(mfUrls.accounts, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      return;
    } catch (err) {
      if (page.isClosed()) {
        throw err;
      }

      if (!isRetryableNavigationError(err) || attempt === MAX_RETRIES) {
        throw err;
      }

      // A crashed Playwright page can reject page.waitForTimeout() and mask the
      // original navigation error. Use a process timer between attempts instead.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

export async function getRefreshStatus(
  page: Page,
): Promise<{ incompleteAccounts: string[]; remainingCount: number }> {
  const rows = page.locator("#account-table tr:has(td.account-status)");
  const count = await rows.count();
  const refreshRows: RefreshStatusRow[] = [];

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const statuses = await row.locator("td.account-status").allTextContents();
    const nameLink = row.locator("td.service a").first();
    refreshRows.push({
      name: statuses.some((status) => status.trim() === "更新中")
        ? await ((await nameLink.count()) > 0 ? nameLink : row.locator("td").first()).textContent()
        : null,
      statuses,
    });
  }

  return summarizeRefreshRows(refreshRows);
}

export interface RefreshStatusRow {
  name: string | null;
  statuses: string[];
}

export function summarizeRefreshRows(rows: readonly RefreshStatusRow[]): {
  incompleteAccounts: string[];
  remainingCount: number;
} {
  const incompleteAccounts: string[] = [];
  let remainingCount = 0;

  for (const row of rows) {
    if (!row.statuses.some((status) => status.trim() === "更新中")) {
      continue;
    }

    remainingCount++;
    const accountName = row.name?.trim();
    if (accountName) {
      incompleteAccounts.push(accountName);
    }
  }

  return { incompleteAccounts, remainingCount };
}

interface RefreshWaitProgress {
  elapsedSeconds: number;
  incompleteAccounts: string[];
  maxWaitMinutes: number;
  nextCheckSeconds: number;
  remainingCount: number;
}

interface RefreshOptions {
  maxWaitMinutes?: number;
  pollIntervalMs?: number;
  startWindowMs?: number;
  onWaiting?: (progress: RefreshWaitProgress) => Promise<void> | void;
}

type RefreshPollingState = { phase: "awaiting_loading" } | { phase: "loading_observed" };

const LOADING_STATUSES_URL = "https://moneyforward.com/accounts/loading_statuses";
const REFRESH_START_WINDOW_MS = 60000;

async function getLoadingCount(page: Page): Promise<number> {
  let response;
  try {
    response = await page.request.get(LOADING_STATUSES_URL, {
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
  } catch (error) {
    throw new Error(
      `GET ${LOADING_STATUSES_URL} failed with status unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const status = response.status();
  const responseUrl = response.url();
  const responsePath = (() => {
    try {
      const url = new URL(responseUrl);
      return `${url.origin}${url.pathname}`;
    } catch {
      return responseUrl;
    }
  })();
  if (status !== 200 || responsePath !== LOADING_STATUSES_URL) {
    throw new Error(
      `GET ${LOADING_STATUSES_URL} failed with status ${status} (response URL: ${responseUrl})`,
    );
  }

  const contentType = Object.entries(response.headers()).find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  if (!contentType?.toLowerCase().includes("application/json")) {
    throw new Error(
      `GET ${LOADING_STATUSES_URL} failed with status ${status}: expected application/json`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`GET ${LOADING_STATUSES_URL} failed with status ${status}: invalid JSON`);
  }
  if (!Array.isArray(body) || body.some((entry: unknown) => !isLoadingStatus(entry))) {
    throw new Error(
      `GET ${LOADING_STATUSES_URL} failed with status ${status}: expected an array of loading statuses`,
    );
  }

  return body.filter((entry: { loading: boolean }) => entry.loading).length;
}

function isLoadingStatus(value: unknown): value is { loading: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "loading" in value &&
    typeof value.loading === "boolean"
  );
}

export function getMaxWaitMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const configuredValue = Number(env.MAX_WAIT_MINUTES);
  return Number.isFinite(configuredValue) && configuredValue > 0
    ? configuredValue
    : DEFAULT_MAX_WAIT_MINUTES;
}

export async function clickRefreshButton(
  page: Page,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const maxWaitMinutes = options.maxWaitMinutes ?? getMaxWaitMinutes();
  const maxWaitTimeMs = maxWaitMinutes * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const startWindowMs = options.startWindowMs ?? REFRESH_START_WINDOW_MS;
  debug("Looking for refresh button...");

  // MF's home can stay busy past 30s after it renders, so networkidle is not a reliable gate.
  // click() already waits for the button.
  await page.goto(mfUrls.home, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });

  const refreshButton = page.locator('a:has-text("一括更新")').first();
  await refreshButton.click();

  info("Refreshing accounts...");

  const startTime = Date.now();
  let state: RefreshPollingState = { phase: "awaiting_loading" };
  let remainingCount = 0;

  while (Date.now() - startTime < maxWaitTimeMs) {
    remainingCount = await getLoadingCount(page);
    if (remainingCount > 0) {
      state = { phase: "loading_observed" };
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    info(`[${elapsed}s] 残り: ${remainingCount}`);
    await options.onWaiting?.({
      elapsedSeconds: elapsed,
      incompleteAccounts: [],
      maxWaitMinutes,
      nextCheckSeconds: Math.round(pollIntervalMs / 1000),
      remainingCount,
    });

    if (state.phase === "loading_observed" && remainingCount === 0) {
      info("All updates completed!");
      return { completed: true, incompleteAccounts: [] };
    }

    const elapsedMs = Date.now() - startTime;
    if (
      state.phase === "awaiting_loading" &&
      (elapsedMs >= startWindowMs || elapsedMs >= maxWaitTimeMs)
    ) {
      warn("Refresh loading was not observed within the start window.");
      return {
        completed: false,
        incompleteAccounts: [],
        remainingCount,
        reason: "not_observed",
      };
    }

    if (state.phase === "loading_observed" && elapsedMs >= maxWaitTimeMs) {
      break;
    }

    const timeUntilMaxWait = Math.max(0, maxWaitTimeMs - elapsedMs);
    await page.waitForTimeout(Math.min(pollIntervalMs, timeUntilMaxWait));
  }

  if (state.phase === "awaiting_loading") {
    warn("Refresh loading was not observed before the wait deadline.");
    return {
      completed: false,
      incompleteAccounts: [],
      remainingCount,
      reason: "not_observed",
    };
  }

  // Names are best-effort; the loading_statuses count remains authoritative on timeout.
  let incompleteAccounts: string[] = [];
  try {
    await navigateToAccountsPage(page);
    ({ incompleteAccounts } = await getRefreshStatus(page));
  } catch (error) {
    warn(
      `Could not name accounts still refreshing: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  warn(`Max wait time exceeded. ${remainingCount} accounts still updating:`);
  for (const account of incompleteAccounts) {
    warn(`  - ${account}`);
  }

  return { completed: false, incompleteAccounts, remainingCount, reason: "timeout" };
}
