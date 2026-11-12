import type { RefreshResult } from "@mf-dashboard/db/types";
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

type AccountIssueStatus = "updating" | "error";

export interface AccountIssue {
  name: string;
  status: AccountIssueStatus;
  message: string;
}

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
export async function getAccountIssues(page: Page): Promise<AccountIssueSummary> {
  await navigateToAccountsPage(page);
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
  onWaiting?: (progress: RefreshWaitProgress) => Promise<void> | void;
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
  debug("Looking for refresh button...");

  // Navigate to home and click refresh button
  // MF's home can stay busy past 30s after it renders, so networkidle is not a reliable gate.
  // click() already waits for the button.
  await page.goto(mfUrls.home, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });

  const refreshButton = page.locator('a:has-text("一括更新")').first();
  await refreshButton.click();

  info("Refreshing accounts...");

  // From here on the refresh has been requested. A failure while watching its progress
  // must not throw away the crawl: report it and let the caller check each account.
  let last = { incompleteAccounts: [] as string[], remainingCount: 0 };
  try {
    return await waitForRefresh(
      page,
      options,
      maxWaitMinutes,
      maxWaitTimeMs,
      pollIntervalMs,
      (s) => {
        last = s;
      },
    );
  } catch (error) {
    warn(
      `Stopped waiting for the refresh: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { completed: false, ...last, reason: "wait_failed" };
  }
}

async function waitForRefresh(
  page: Page,
  options: RefreshOptions,
  maxWaitMinutes: number,
  maxWaitTimeMs: number,
  pollIntervalMs: number,
  remember: (status: { incompleteAccounts: string[]; remainingCount: number }) => void,
): Promise<RefreshResult> {
  // Wait for refresh to start
  await page.waitForTimeout(3000);

  // Navigate to accounts page to check update status
  await navigateToAccountsPage(page);

  info("Waiting for all updates to complete on /accounts page...");

  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTimeMs) {
    const { incompleteAccounts, remainingCount } = await getRefreshStatus(page);
    remember({ incompleteAccounts, remainingCount });
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    info(`[${elapsed}s] 残り: ${remainingCount}`);

    await options.onWaiting?.({
      elapsedSeconds: elapsed,
      incompleteAccounts,
      maxWaitMinutes,
      nextCheckSeconds: Math.round(pollIntervalMs / 1000),
      remainingCount,
    });

    if (remainingCount === 0) {
      info("All updates completed!");
      return { completed: true, incompleteAccounts: [] };
    }

    // Wait and navigate to accounts page again to get fresh status
    // Using goto instead of reload to avoid ERR_ABORTED when frame is detached
    await page.waitForTimeout(pollIntervalMs);
    await navigateToAccountsPage(page);
  }

  // Timeout: get list of accounts still updating
  const { incompleteAccounts, remainingCount } = await getRefreshStatus(page);
  remember({ incompleteAccounts, remainingCount });

  warn(`Max wait time exceeded. ${remainingCount} accounts still updating:`);
  for (const account of incompleteAccounts) {
    warn(`  - ${account}`);
  }

  return { completed: false, incompleteAccounts, remainingCount, reason: "timeout" };
}
