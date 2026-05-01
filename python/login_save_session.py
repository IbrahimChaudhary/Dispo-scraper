from __future__ import annotations

import re
import time
from typing import Any

from playwright.sync_api import BrowserContext, Locator, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright

from common import ensure_dir, get_config, log, run_id


def first_visible(locators: list[Locator]) -> Locator | None:
    for locator in locators:
        try:
            if locator.first.is_visible():
                return locator.first
        except Exception:  # noqa: BLE001
            pass
    return None


def first_usable_from_selectors(page: Page, selectors: list[str]) -> Locator | None:
    for selector in selectors:
        loc = page.locator(selector)
        for i in range(loc.count()):
            candidate = loc.nth(i)
            try:
                usable = candidate.evaluate(
                    """(el) => {
                        const node = el;
                        const style = window.getComputedStyle(node);
                        const visible = !!(node.offsetParent || style.position === "fixed");
                        return visible && !node.disabled && !node.readOnly;
                    }"""
                )
            except Exception:  # noqa: BLE001
                usable = False
            if usable:
                return candidate
    return None


def find_by_visible_placeholder(page: Page, keyword: str) -> Locator | None:
    inputs = page.locator("input")
    for i in range(inputs.count()):
        input_box = inputs.nth(i)
        try:
            matches = input_box.evaluate(
                """(el, kw) => {
                    const node = el;
                    const style = window.getComputedStyle(node);
                    const placeholder = (node.placeholder || "").toLowerCase();
                    const visible = !!(node.offsetParent || style.position === "fixed");
                    return visible && placeholder.includes(String(kw));
                }""",
                keyword,
            )
        except Exception:  # noqa: BLE001
            matches = False
        if matches:
            return input_box
    return None


def click_first(page: Page, locators: list[Locator], label: str) -> None:
    target = first_visible(locators)
    if target is None:
        raise RuntimeError(f"Could not find visible control for {label}")
    target.click()


def fill_first(page: Page, locators: list[Locator], value: str, label: str) -> None:
    target = first_visible(locators)
    if target is None:
        raise RuntimeError(f"Could not find visible input for {label}")
    target.fill(value)


def set_input_value(input_box: Locator, value: str) -> None:
    if input_box.is_visible():
        input_box.fill(value)
        return
    input_box.evaluate(
        """(el, nextValue) => {
            const inputEl = el;
            inputEl.value = String(nextValue);
            inputEl.dispatchEvent(new Event("input", { bubbles: true }));
            inputEl.dispatchEvent(new Event("change", { bubbles: true }));
        }""",
        value,
    )


def ensure_value_typed(input_box: Locator, value: str, kind: str) -> None:
    input_box.click(force=True)
    input_box.press("Control+A")
    input_box.fill("")
    input_box.type(value, delay=25)
    set_input_value(input_box, value)
    if kind == "email":
        current = input_box.input_value()
        if "@" not in current:
            raise RuntimeError("Email field did not accept value")


def debug_inputs(page: Page) -> None:
    inputs = page.locator("input").evaluate_all(
        """(els) =>
            els.map((el) => {
                const input = el;
                const style = window.getComputedStyle(input);
                return {
                    type: input.type,
                    name: input.name || "",
                    id: input.id || "",
                    placeholder: input.placeholder || "",
                    visible: !!(input.offsetParent || style.position === "fixed"),
                    disabled: input.disabled
                };
            })"""
    )
    print("DEBUG_INPUTS", inputs)


def do_direct_login(page: Page, email: str, password: str) -> None:
    email_input = first_usable_from_selectors(
        page,
        [
            'input[placeholder="Email"]',
            'input[placeholder="email"]',
            'input[placeholder*="mail"]',
            'input[type="email"]',
            'input[name*="email"]',
            'input[type="text"]',
        ],
    ) or find_by_visible_placeholder(page, "email")
    if email_input is None:
        debug_inputs(page)
        raise RuntimeError("Could not find visible input for email")
    ensure_value_typed(email_input, email, "email")

    password_input = first_usable_from_selectors(
        page,
        [
            'input[placeholder="Password"]',
            'input[placeholder="password"]',
            'input[placeholder*="pass"]',
            'input[type="password"]',
            'input[name*="password"]',
            'input[name*="pass"]',
        ],
    ) or find_by_visible_placeholder(page, "password")
    if password_input is None:
        debug_inputs(page)
        raise RuntimeError("Could not find visible input for password")
    ensure_value_typed(password_input, password, "password")

    click_first(
        page,
        [
            page.get_by_role("button", name=re.compile(r"login|sign in|continue", re.I)),
            page.locator('button[type="submit"]'),
            page.locator('input[type="submit"]'),
        ],
        "submit login",
    )


def do_google_login(context: BrowserContext, page: Page, email: str, password: str) -> bool:
    google_button = first_visible(
        [
            page.get_by_role("button", name=re.compile(r"google|continue with google|sign in with google", re.I)),
            page.get_by_text(re.compile(r"continue with google|sign in with google", re.I)),
            page.locator('a:has-text("Google"), button:has-text("Google")'),
        ]
    )
    if google_button is None:
        return False

    popup = None
    try:
        with context.expect_page(timeout=10000) as page_info:
            google_button.click()
        popup = page_info.value
    except PlaywrightTimeoutError:
        popup = None

    target = popup or page
    target.wait_for_load_state("domcontentloaded")

    fill_first(
        target,
        [
            target.locator('input[type="email"]'),
            target.locator('input[name="identifier"]'),
            target.locator("#identifierId"),
        ],
        email,
        "google email",
    )
    click_first(
        target,
        [
            target.get_by_role("button", name=re.compile(r"next", re.I)),
            target.locator("#identifierNext button"),
            target.locator('button:has-text("Next")'),
        ],
        "google email next",
    )

    fill_first(
        target,
        [
            target.locator('input[type="password"]'),
            target.locator('input[name="Passwd"]'),
        ],
        password,
        "google password",
    )
    click_first(
        target,
        [
            target.get_by_role("button", name=re.compile(r"next|sign in", re.I)),
            target.locator("#passwordNext button"),
            target.locator('button:has-text("Next")'),
        ],
        "google password next",
    )
    return True


def is_login_url(url: str) -> bool:
    return bool(re.search(r"/session/login|/login", url, re.I))


def wait_for_login_outcome(page: Page, timeout_ms: int) -> str:
    deadline = time.time() + (timeout_ms / 1000)
    while time.time() < deadline:
        url = page.url.lower()
        if "login" not in url:
            return "success"
        if page.get_by_text(re.compile(r"e-?mail must be valid|invalid|required", re.I)).first.is_visible():
            return "validation"
        time.sleep(0.5)
    return "timeout"


def wait_until_not_login(page: Page, timeout_ms: int) -> None:
    deadline = time.time() + (timeout_ms / 1000)
    while time.time() < deadline:
        if "login" not in page.url.lower():
            return
        time.sleep(1)
    raise RuntimeError("Timed out waiting for login to complete.")


def main() -> None:
    job_id = run_id()
    config = get_config()
    ensure_dir(config.storage_state_path.parent)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=config.headless)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()
        page.set_default_timeout(config.timeout_ms)

        try:
            log(job_id, "opening login page", {"url": config.login_url})
            page.goto(config.login_url, wait_until="domcontentloaded")

            used_automatic_flow = False
            try:
                do_direct_login(page, config.email, config.password)
                used_automatic_flow = True
                log(job_id, "direct login submit attempted")
            except Exception as direct_error:  # noqa: BLE001
                log(job_id, "direct login attempt failed", {"error": str(direct_error)})

            if not used_automatic_flow:
                used_google = False
                try:
                    used_google = do_google_login(context, page, config.email, config.password)
                except Exception:  # noqa: BLE001
                    used_google = False
                used_automatic_flow = used_google
                if used_google:
                    log(job_id, "google login flow attempted")

            if not used_automatic_flow:
                log(job_id, "no automatic flow matched; waiting for manual login", {"timeoutMs": 300000})

            outcome = wait_for_login_outcome(page, 30000)
            if outcome == "validation" and is_login_url(page.url):
                log(job_id, "login validation appeared on login page; retrying one more direct submit")
                do_direct_login(page, config.email, config.password)
                outcome = wait_for_login_outcome(page, 30000)

            if outcome != "success":
                log(job_id, "automatic login not completed; waiting for manual login", {"timeoutMs": 300000, "outcome": outcome})
                wait_until_not_login(page, 300000)

            page.goto(config.buyers_url, wait_until="domcontentloaded")
            page.get_by_role("button", name=re.compile(r"export|my exports", re.I)).first.wait_for(timeout=config.timeout_ms)
            context.storage_state(path=str(config.storage_state_path))
            log(job_id, "session saved", {"storageStatePath": str(config.storage_state_path)})
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
