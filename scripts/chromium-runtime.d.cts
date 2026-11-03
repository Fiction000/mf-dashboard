import type { LaunchOptions } from "playwright";

export const CHROME_FOR_TESTING_CACHE: string;
export const CHROME_FOR_TESTING_VERSION: string;
export function getPatchedChromiumLaunchOptions(): Pick<
  LaunchOptions,
  "chromiumSandbox" | "executablePath"
>;
