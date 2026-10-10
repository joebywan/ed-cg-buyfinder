import test from "node:test";
import assert from "node:assert/strict";
import { browserName, folderTooltip } from "../src/browser.js";

const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

test("browsers are named from the user agent, Brave by its own API", () => {
  assert.equal(browserName({ userAgent: FIREFOX }), "Firefox");
  assert.equal(browserName({ userAgent: SAFARI }), "Safari");
  // Brave sends Chrome's user agent word for word; only navigator.brave tells them apart
  assert.equal(browserName({ userAgent: CHROME, brave: {} }), "Brave");
  assert.equal(browserName({ userAgent: CHROME }), null);
  assert.equal(browserName({}), null);
});

test("the folder tooltip names the browser that restricts it", () => {
  assert.equal(folderTooltip({ userAgent: FIREFOX }),
    "Firefox restricts monitoring folders, you need to do this every time you want to load the logs. Chrome/Edge you don't need to.");
  assert.match(folderTooltip({ userAgent: CHROME, brave: {} }), /^Brave restricts monitoring folders/);
  assert.match(folderTooltip({ userAgent: CHROME }), /^This browser restricts monitoring folders/);
});
