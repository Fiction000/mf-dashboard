const { existsSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const crawlerRequire = createRequire(path.resolve(__dirname, "../apps/crawler/package.json"));
const { Browser, computeExecutablePath } = crawlerRequire("@puppeteer/browsers");

const CHROME_FOR_TESTING_VERSION = "156.0.8078.80";
const CHROME_FOR_TESTING_CACHE = path.resolve(__dirname, "../.cache/mf-dashboard-chromium");

function getPatchedChromiumExecutablePath() {
  const executablePath = computeExecutablePath({
    browser: Browser.CHROME,
    buildId: CHROME_FOR_TESTING_VERSION,
    cacheDir: CHROME_FOR_TESTING_CACHE,
  });
  if (!existsSync(executablePath)) {
    throw new Error(
      `Chrome for Testing ${CHROME_FOR_TESTING_VERSION} is missing. Run pnpm install to provision it.`,
    );
  }
  return executablePath;
}

function getPatchedChromiumLaunchOptions() {
  return {
    chromiumSandbox: true,
    executablePath: getPatchedChromiumExecutablePath(),
  };
}

module.exports = {
  CHROME_FOR_TESTING_CACHE,
  CHROME_FOR_TESTING_VERSION,
  getPatchedChromiumLaunchOptions,
};
