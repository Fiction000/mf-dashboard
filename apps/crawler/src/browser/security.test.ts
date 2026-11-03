import { chromium, type Browser } from "playwright";
import { afterEach, expect, test } from "vitest";

let browser: Browser | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

test("crawler Chromium is patched, sandboxed, and renders local content", async () => {
  browser = await chromium.launch({ headless: true, args: ["--enable-automation"] });
  const page = await browser.newPage();
  await page.setContent("<title>browser-security-smoke</title><main>local-only</main>");
  const commandLine = await (
    await browser.newBrowserCDPSession()
  ).send("Browser.getBrowserCommandLine");

  expect(browser.version()).toBe("156.0.8078.80");
  expect(commandLine.arguments).not.toContain("--no-sandbox");
  expect(await page.title()).toBe("browser-security-smoke");
  expect(await page.locator("main").textContent()).toBe("local-only");
});
