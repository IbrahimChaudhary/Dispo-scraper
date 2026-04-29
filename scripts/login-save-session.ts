import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { ensureDir, getConfig, log, runId } from "./common.js";

async function firstVisible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    if (await locator.first().isVisible().catch(() => false)) {
      return locator.first();
    }
  }
  return null;
}

async function firstUsableFromSelectors(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const loc = page.locator(selector);
    const count = await loc.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = loc.nth(i);
      const usable = await candidate.evaluate((el) => {
        const node = el as HTMLInputElement;
        const style = window.getComputedStyle(node);
        const visible = !!(node.offsetParent || style.position === "fixed");
        return visible && !node.disabled && !node.readOnly;
      }).catch(() => false);
      if (usable) return candidate;
    }
  }
  return null;
}

async function findByVisiblePlaceholder(page: Page, keyword: "email" | "password"): Promise<Locator | null> {
  const inputs = page.locator("input");
  const count = await inputs.count();
  for (let i = 0; i < count; i += 1) {
    const input = inputs.nth(i);
    const matches = await input.evaluate((el, kw) => {
      const node = el as HTMLInputElement;
      const style = window.getComputedStyle(node);
      const placeholder = (node.placeholder || "").toLowerCase();
      const visible = !!(node.offsetParent || style.position === "fixed");
      return visible && placeholder.includes(String(kw));
    }, keyword).catch(() => false);
    if (matches) return input;
  }
  return null;
}

async function fillFirst(page: Page, locators: Locator[], value: string, label: string): Promise<void> {
  const target = await firstVisible(locators);
  if (!target) {
    throw new Error(`Could not find visible input for ${label}`);
  }
  await target.fill(value);
}

async function clickFirst(page: Page, locators: Locator[], label: string): Promise<void> {
  const target = await firstVisible(locators);
  if (!target) {
    throw new Error(`Could not find visible control for ${label}`);
  }
  await target.click();
}

async function hasEmailInput(page: Page): Promise<boolean> {
  const emailInput = await firstUsableFromSelectors(page, [
    'input[placeholder="Email"]',
    'input[placeholder*="mail" i]',
    'input[type="email"]',
    'input[name*="email" i]',
    'input[type="text"]'
  ]);
  return emailInput !== null;
}

async function setInputValue(input: Locator, value: string): Promise<void> {
  if (await input.isVisible().catch(() => false)) {
    await input.fill(value);
    return;
  }

  await input.evaluate((el, nextValue) => {
    const inputEl = el as HTMLInputElement;
    inputEl.value = String(nextValue);
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function findBestInput(
  page: Page,
  kind: "email" | "password"
): Promise<Locator | null> {
  const selector = kind === "email"
    ? "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='password'])"
    : "input[type='password'], input[name*='pass' i], input[placeholder*='pass' i]";

  const candidates = page.locator(selector);
  const count = await candidates.count();

  for (let i = 0; i < count; i += 1) {
    const input = candidates.nth(i);
    const ok = await input.evaluate((el) => {
      const node = el as HTMLInputElement;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const isVisible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      return isVisible && !node.disabled && !node.readOnly;
    }).catch(() => false);
    if (!ok) continue;

    if (kind === "email") {
      const placeholder = ((await input.getAttribute("placeholder")) ?? "").toLowerCase();
      const name = ((await input.getAttribute("name")) ?? "").toLowerCase();
      const id = ((await input.getAttribute("id")) ?? "").toLowerCase();
      const type = ((await input.getAttribute("type")) ?? "text").toLowerCase();
      if (placeholder.includes("email") || name.includes("email") || id.includes("email") || type === "email") {
        return input;
      }
    } else {
      return input;
    }
  }

  for (let i = 0; i < count; i += 1) {
    const input = candidates.nth(i);
    const ok = await input.evaluate((el) => {
      const node = el as HTMLInputElement;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const isVisible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      return isVisible && !node.disabled && !node.readOnly;
    }).catch(() => false);
    if (ok) return input;
  }

  return null;
}

async function ensureValueTyped(input: Locator, value: string, kind: "email" | "password"): Promise<void> {
  await input.click({ force: true }).catch(() => undefined);
  await input.press("Control+A").catch(() => undefined);
  await input.fill("").catch(() => undefined);
  await input.type(value, { delay: 25 }).catch(() => undefined);
  await setInputValue(input, value);

  if (kind === "email") {
    const check = await input.inputValue().catch(() => "");
    if (!check.includes("@")) {
      throw new Error("Email field did not accept value");
    }
  }
}

async function findFirstVisibleTextLikeInput(page: Page): Promise<Locator | null> {
  const inputs = page.locator("input");
  const count = await inputs.count();

  for (let i = 0; i < count; i += 1) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false))) continue;

    const type = (await input.getAttribute("type"))?.toLowerCase() ?? "text";
    const blocked = ["hidden", "checkbox", "radio", "password", "submit", "button", "file"];
    if (blocked.includes(type)) continue;

    const disabled = await input.isDisabled().catch(() => false);
    if (disabled) continue;

    return input;
  }
  return null;
}

async function findFirstVisiblePasswordInput(page: Page): Promise<Locator | null> {
  const attachedPassword = await firstUsableFromSelectors(page, [
    'input[type="password"]',
    'input[placeholder*="pass" i]',
    '.v-text-field input[type="password"]'
  ]);
  if (attachedPassword) return attachedPassword;

  const passwordByType = page.locator('input[type="password"]');
  const pwdCount = await passwordByType.count();
  for (let i = 0; i < pwdCount; i += 1) {
    const input = passwordByType.nth(i);
    if (await input.isVisible().catch(() => false)) {
      return input;
    }
  }

  const inputs = page.locator("input");
  const count = await inputs.count();
  for (let i = 0; i < count; i += 1) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false))) continue;
    const name = ((await input.getAttribute("name")) ?? "").toLowerCase();
    const id = ((await input.getAttribute("id")) ?? "").toLowerCase();
    const placeholder = ((await input.getAttribute("placeholder")) ?? "").toLowerCase();
    if (name.includes("pass") || id.includes("pass") || placeholder.includes("pass")) {
      return input;
    }
  }
  return null;
}

async function debugInputs(page: Page): Promise<void> {
  const inputs = await page.locator("input").evaluateAll((els) =>
    els.map((el) => {
      const input = el as HTMLInputElement;
      const style = window.getComputedStyle(input);
      return {
        type: input.type,
        name: input.name || "",
        id: input.id || "",
        placeholder: input.placeholder || "",
        visible: !!(input.offsetParent || style.position === "fixed"),
        disabled: input.disabled
      };
    })
  );
  console.log("DEBUG_INPUTS", JSON.stringify(inputs));
}

async function doDirectLogin(page: Page, email: string, password: string): Promise<void> {
  const emailInput = (await firstUsableFromSelectors(page, [
    'input[placeholder="Email"]',
    'input[placeholder="email"]',
    'input[placeholder*="mail"]',
    'input[type="email"]',
    'input[name*="email"]',
    'input[type="text"]'
  ])) ?? (await findByVisiblePlaceholder(page, "email"));
  if (!emailInput) {
    await debugInputs(page);
    throw new Error("Could not find visible input for email");
  }
  await ensureValueTyped(emailInput, email, "email");

  const passwordInput = (await firstUsableFromSelectors(page, [
    'input[placeholder="Password"]',
    'input[placeholder="password"]',
    'input[placeholder*="pass"]',
    'input[type="password"]',
    'input[name*="password"]',
    'input[name*="pass"]'
  ])) ?? (await findByVisiblePlaceholder(page, "password"));
  if (!passwordInput) {
    await debugInputs(page);
    throw new Error("Could not find visible input for password");
  }
  await ensureValueTyped(passwordInput, password, "password");

  await clickFirst(
    page,
    [
      page.getByRole("button", { name: /login|sign in|continue/i }),
      page.locator('button[type="submit"]'),
      page.locator('input[type="submit"]')
    ],
    "submit login"
  );
}

type LoginOutcome = "success" | "validation" | "timeout";

async function waitForLoginOutcome(page: Page, timeoutMs: number): Promise<LoginOutcome> {
  const successPromise = page
    .waitForURL((url) => !/login/i.test(url.toString()), { timeout: timeoutMs })
    .then((): LoginOutcome => "success")
    .catch((): LoginOutcome => "timeout");

  const validationPromise = page
    .getByText(/e-?mail must be valid|invalid|required/i)
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then((): LoginOutcome => "validation")
    .catch((): LoginOutcome => "timeout");

  const timerPromise = new Promise<LoginOutcome>((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs);
  });

  return Promise.race([successPromise, validationPromise, timerPromise]);
}

function isLoginUrl(url: string): boolean {
  return /\/session\/login|\/login/i.test(url);
}

async function doGoogleLogin(context: BrowserContext, page: Page, email: string, password: string): Promise<boolean> {
  const googleButton = await firstVisible([
    page.getByRole("button", { name: /google|continue with google|sign in with google/i }),
    page.getByText(/continue with google|sign in with google/i),
    page.locator('a:has-text("Google"), button:has-text("Google")')
  ]);

  if (!googleButton) {
    return false;
  }

  const popupPromise = context.waitForEvent("page", { timeout: 10_000 }).catch(() => null);
  await googleButton.click();
  const popup = await popupPromise;
  const target = popup ?? page;
  await target.waitForLoadState("domcontentloaded");

  await fillFirst(
    target,
    [
      target.locator('input[type="email"]'),
      target.locator('input[name="identifier"]'),
      target.locator("#identifierId")
    ],
    email,
    "google email"
  );
  await clickFirst(
    target,
    [
      target.getByRole("button", { name: /next/i }),
      target.locator("#identifierNext button"),
      target.locator('button:has-text("Next")')
    ],
    "google email next"
  );

  await fillFirst(
    target,
    [
      target.locator('input[type="password"]'),
      target.locator('input[name="Passwd"]')
    ],
    password,
    "google password"
  );
  await clickFirst(
    target,
    [
      target.getByRole("button", { name: /next|sign in/i }),
      target.locator("#passwordNext button"),
      target.locator('button:has-text("Next")')
    ],
    "google password next"
  );

  return true;
}

async function main(): Promise<void> {
  const id = runId();
  const config = getConfig();
  ensureDir("auth");

  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeoutMs);

  try {
    log(id, "opening login page", { url: config.loginUrl });
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });

    let usedAutomaticFlow = false;
    try {
      await doDirectLogin(page, config.email, config.password);
      usedAutomaticFlow = true;
      log(id, "direct login submit attempted");
    } catch (directError) {
      log(id, "direct login attempt failed", {
        error: directError instanceof Error ? directError.message : String(directError)
      });
    }

    if (!usedAutomaticFlow) {
      const usedGoogle = await doGoogleLogin(context, page, config.email, config.password).catch(() => false);
      usedAutomaticFlow = usedGoogle;
      if (usedGoogle) {
        log(id, "google login flow attempted");
      }
    }

    if (!usedAutomaticFlow) {
      log(id, "no automatic flow matched; waiting for manual login", { timeoutMs: 300_000 });
    }

    let outcome = await waitForLoginOutcome(page, 30_000);
    const stillOnLoginAfterFirstAttempt = isLoginUrl(page.url());
    if (outcome === "validation" && stillOnLoginAfterFirstAttempt) {
      log(id, "login validation appeared on login page; retrying one more direct submit");
      await doDirectLogin(page, config.email, config.password);
      outcome = await waitForLoginOutcome(page, 30_000);
    }

    if (outcome !== "success") {
      log(id, "automatic login not completed; waiting for manual login", { timeoutMs: 300_000, outcome });
      await page.waitForURL((url) => !/login/i.test(url.toString()), { timeout: 300_000 });
    }

    await page.goto(config.buyersUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /export|my exports/i }).first().waitFor({ timeout: config.timeoutMs });

    await context.storageState({ path: config.storageStatePath });
    log(id, "session saved", { storageStatePath: config.storageStatePath });
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
