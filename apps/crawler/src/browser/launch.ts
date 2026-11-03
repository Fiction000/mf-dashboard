import { chromium, type Browser, type LaunchOptions } from "playwright";
import { getPatchedChromiumLaunchOptions } from "../../../../scripts/chromium-runtime.cjs";

type SafeLaunchOptions = Omit<LaunchOptions, "chromiumSandbox" | "executablePath">;

const SANDBOX_DISABLING_FLAG = /^--(no-sandbox|disable-[a-z-]*sandbox)(=|$)/;

export function launchCrawlerChromium(options: SafeLaunchOptions = {}): Promise<Browser> {
  const rejected = options.args?.find((arg) => SANDBOX_DISABLING_FLAG.test(arg));
  if (rejected) {
    return Promise.reject(
      new Error(`Refusing to launch Chromium with sandbox-disabling flag ${rejected}`),
    );
  }
  return chromium.launch({
    ...options,
    ...getPatchedChromiumLaunchOptions(),
  });
}
