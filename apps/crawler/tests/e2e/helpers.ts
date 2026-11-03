import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { initDb } from "@mf-dashboard/db";
import { mfUrls } from "@mf-dashboard/meta/urls";
import type { Browser, BrowserContext, Page } from "playwright";
import { createBrowserContext } from "../../src/browser/context.js";
import { launchCrawlerChromium } from "../../src/browser/launch.js";
import { SCREENSHOT_DIR, ensureScreenshotDir } from "./global-setup.js";

const NAVIGATION_TIMEOUT = 30000;

export async function launchLoggedInContext(): Promise<{
  browser: Browser;
  context: BrowserContext;
}> {
  const browser = await launchCrawlerChromium({ headless: true });
  const context = await createBrowserContext(browser, { useAuthState: true });
  return { browser, context };
}

export async function gotoHome(page: Page): Promise<void> {
  await page.goto(mfUrls.home, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT,
  });
}

export async function saveScreenshot(page: Page, filename: string): Promise<void> {
  ensureScreenshotDir();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, filename),
    fullPage: true,
  });
}

export async function withErrorScreenshot<T>(
  page: Page,
  filename: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await saveScreenshot(page, filename);
    throw err;
  }
}

export async function withNewPage<T>(
  context: BrowserContext,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

export async function setupTestDb(dbPath: string): Promise<void> {
  cleanupTestDb(dbPath);
  process.env.DB_PATH = dbPath;
  await initDb();
}

export function cleanupTestDb(dbPath: string): void {
  for (const suffix of ["", "-shm", "-wal"]) {
    const f = dbPath + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
}
