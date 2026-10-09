// Minimal retrying assertions for playwright-core locators (the full `expect` ships in @playwright/test,
// which this package does not depend on).
import assert from "node:assert/strict";

async function poll(check, describe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const ok = await check();
      if (ok.pass) return;
      last = ok.actual;
    } catch (error) {
      last = error.message.split("\n")[0];
    }
    if (Date.now() > deadline) assert.fail(`${describe} - last seen: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function expect(locator) {
  return {
    toBeVisible: () => poll(async () => ({ pass: await locator.isVisible(), actual: "not visible" }), "expected visible"),
    toBeHidden: () => poll(async () => ({ pass: !(await locator.isVisible()), actual: "visible" }), "expected hidden"),
    toBeEnabled: () => poll(async () => ({ pass: await locator.isEnabled(), actual: "disabled" }), "expected enabled"),
    toBeChecked: () => poll(async () => ({ pass: await locator.isChecked(), actual: "unchecked" }), "expected checked"),
    toHaveCount: (n) => poll(async () => { const c = await locator.count(); return { pass: c === n, actual: c }; }, `expected count ${n}`),
    toHaveValue: (v) => poll(async () => { const x = await locator.inputValue(); return { pass: x === v, actual: x }; }, `expected value ${JSON.stringify(v)}`),
    toHaveAttribute: (name, v) => poll(async () => { const x = await locator.getAttribute(name); return { pass: x === v, actual: x }; }, `expected ${name}=${v}`),
    toContainText: (text) => poll(async () => { const x = await locator.first().innerText(); return { pass: x.includes(text), actual: x }; }, `expected text to contain ${JSON.stringify(text)}`),
  };
}
