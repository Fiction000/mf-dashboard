import type { RefreshAccountIssue, RefreshResult } from "@mf-dashboard/db/types";
import { mfUrls } from "@mf-dashboard/meta/urls";
import type { Page } from "playwright";
import { debug, info, warn } from "../logger.js";
import { gotoWithRetry } from "./navigation.js";

const DEFAULT_MAX_WAIT_MINUTES = 20;
const POLL_INTERVAL_MS = 30000; // 30 seconds
const NAVIGATION_RETRY_DELAY_MS = 1000;
const NAVIGATION_TIMEOUT_MS = 60000;

interface NavigationOptions {
  retryDelayMs?: number;
}

export async function navigateToAccountsPage(
  page: Page,
  options: NavigationOptions = {},
): Promise<void> {
  await gotoWithRetry(page, mfUrls.accounts, {
    retryDelayMs: options.retryDelayMs ?? NAVIGATION_RETRY_DELAY_MS,
    timeout: NAVIGATION_TIMEOUT_MS,
  });
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

export type AccountIssue = RefreshAccountIssue;

export interface AccountIssueSummary {
  /** Accounts that a refresh applies to (正常・更新中・エラー). 停止中 and blank rows are not counted. */
  checkedCount: number;
  issues: AccountIssue[];
}

/**
 * Classify /accounts rows the same way as registered-accounts.ts:
 * 正常 → ok, 更新中 → updating, 取得を停止しています → not counted, any other text → error.
 */
export function classifyAccountIssues(rows: readonly RefreshStatusRow[]): AccountIssueSummary {
  const issues: AccountIssue[] = [];
  let checkedCount = 0;

  for (const row of rows) {
    const message = row.statuses
      .map((status) => status.trim())
      .filter(Boolean)
      .join(" ");
    if (!message || message.includes("取得を停止しています")) {
      continue;
    }
    checkedCount++;
    if (message.includes("正常")) {
      continue;
    }
    issues.push({
      name: row.name?.trim() || "名称不明",
      status: message.includes("更新中") ? "updating" : "error",
      message,
    });
  }

  return { checkedCount, issues };
}

/** Read every account's refresh state from /accounts after the bulk refresh. */
export async function getAccountIssues(
  page: Page,
  options: { alreadyOnAccountsPage?: boolean } = {},
): Promise<AccountIssueSummary> {
  if (!options.alreadyOnAccountsPage) await navigateToAccountsPage(page);
  const rows = page.locator("#account-table tr:has(td.account-status)");
  const count = await rows.count();
  const statusRows: RefreshStatusRow[] = [];

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const statuses = await row.locator("td.account-status").allTextContents();
    const nameLink = row.locator("td.service a").first();
    const rawName = await ((await nameLink.count()) > 0 ? nameLink : row.locator("td").first())
      .textContent()
      .catch(() => null);
    statusRows.push({ name: rawName?.split(/[\n\r]/)[0] ?? null, statuses });
  }

  return classifyAccountIssues(statusRows);
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

  await page.goto(mfUrls.home, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  const refreshButton = page.locator('a:has-text("一括更新")').first();
  await refreshButton.click();
  info("Refreshing accounts...");

  let lastCount = 0;
  try {
    const startedAt = Date.now();
    let loadingObserved = false;
    while (Date.now() - startedAt < maxWaitTimeMs) {
      lastCount = await getLoadingCount(page);
      if (lastCount > 0) loadingObserved = true;
      const elapsedMs = Date.now() - startedAt;
      const elapsed = Math.round(elapsedMs / 1000);
      info(`[${elapsed}s] 残り: ${lastCount}`);
      await options.onWaiting?.({
        elapsedSeconds: elapsed,
        incompleteAccounts: [],
        maxWaitMinutes,
        nextCheckSeconds: Math.round(pollIntervalMs / 1000),
        remainingCount: lastCount,
      });
      if (!loadingObserved && elapsedMs >= startWindowMs) {
        warn("Refresh loading was not observed within the start window.");
        return {
          completed: false,
          incompleteAccounts: [],
          remainingCount: lastCount,
          reason: "not_observed",
        };
      }
      if (loadingObserved && lastCount === 0) {
        info("All updates completed!");
        return { completed: true, incompleteAccounts: [] };
      }
      await page.waitForTimeout(Math.min(pollIntervalMs, Math.max(0, maxWaitTimeMs - elapsedMs)));
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("GET https://moneyforward.com/accounts/loading_statuses")
    ) {
      throw error;
    }
    warn(
      `Stopped waiting for the refresh: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      completed: false,
      incompleteAccounts: [],
      remainingCount: lastCount,
      reason: "wait_failed",
    };
  }

  if (lastCount === 0) {
    warn("Refresh loading was not observed before the wait deadline.");
    return { completed: false, incompleteAccounts: [], remainingCount: 0, reason: "not_observed" };
  }

  let accountSummary: AccountIssueSummary | undefined;
  try {
    await navigateToAccountsPage(page);
    accountSummary = await getAccountIssues(page, { alreadyOnAccountsPage: true });
  } catch (error) {
    warn(
      `Could not name accounts still refreshing: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const incompleteAccounts = accountSummary?.issues.map(({ name }) => name) ?? [];
  warn(`Max wait time exceeded. ${lastCount} accounts still updating:`);
  for (const account of incompleteAccounts) warn(`  - ${account}`);
  return {
    completed: false,
    incompleteAccounts,
    remainingCount: lastCount,
    reason: "timeout",
    accountStatusChecked: true,
    ...(accountSummary ? { accountSummary } : {}),
  };
}
