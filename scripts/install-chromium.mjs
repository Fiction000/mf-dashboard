import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHROME_FOR_TESTING_CACHE, CHROME_FOR_TESTING_VERSION } from "./chromium-runtime.cjs";

const crawlerRequire = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/crawler/package.json"),
);
const { Browser, install } = crawlerRequire("@puppeteer/browsers");

const installed = await install({
  browser: Browser.CHROME,
  buildId: CHROME_FOR_TESTING_VERSION,
  cacheDir: CHROME_FOR_TESTING_CACHE,
});
console.log(`Installed Chrome for Testing ${installed.buildId} at ${installed.executablePath}`);
