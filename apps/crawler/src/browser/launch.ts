import { chromium, type Browser, type LaunchOptions } from "playwright";
import { getPatchedChromiumLaunchOptions } from "../../../../scripts/chromium-runtime.cjs";

type SafeLaunchOptions = Omit<LaunchOptions, "chromiumSandbox" | "executablePath">;

export function launchCrawlerChromium(options: SafeLaunchOptions = {}): Promise<Browser> {
  return chromium.launch({
    ...options,
    ...getPatchedChromiumLaunchOptions(),
  });
}
