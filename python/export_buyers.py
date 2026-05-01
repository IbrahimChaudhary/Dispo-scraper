from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urljoin

from playwright.sync_api import Download, Locator, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright

from common import ensure_dir, get_config, log, now_stamp, retry, run_id, sleep_ms


def first_visible(locators: list[Locator]) -> Locator | None:
    for locator in locators:
        try:
            if locator.first.is_visible():
                return locator.first
        except Exception:  # noqa: BLE001
            pass
    return None


def save_download(download: Download, downloads_dir: Path) -> dict[str, str]:
    suggested_filename = download.suggested_filename
    ext = Path(suggested_filename).suffix or ".csv"
    output_name = f"buyers-{now_stamp()}{ext}"
    output_path = downloads_dir / output_name
    download.save_as(str(output_path))
    return {"filePath": str(output_path), "suggestedFilename": suggested_filename}


def assert_session(page: Page) -> None:
    login_input_visible = False
    try:
        login_input_visible = page.locator('input[type="password"], input[type="email"]').first.is_visible()
    except Exception:  # noqa: BLE001
        login_input_visible = False
    current_url = page.url
    if re.search(r"login", current_url, re.I) or login_input_visible:
        raise RuntimeError("Session expired. Run `python python/login_save_session.py` and try again.")


def wait_for_buyers_page_ready(page: Page, timeout_ms: int) -> None:
    page.wait_for_load_state("domcontentloaded")
    page.get_by_role("button", name=re.compile(r"export|my exports", re.I)).first.wait_for(timeout=timeout_ms)


def click_export_list(page: Page) -> None:
    button = first_visible(
        [
            page.locator("button.buyers-export-button"),
            page.locator(".buyers-export-button"),
            page.get_by_role("button", name=re.compile(r"^\s*export list\s*$", re.I)),
            page.locator('button:has-text("Export list")'),
        ]
    )
    if button is None:
        raise RuntimeError("Could not find visible control for export list button")

    state = button.evaluate(
        """(el) => {
            const node = el;
            return {
              disabled: !!node.disabled,
              className: node.className || "",
              text: (node.textContent || "").trim()
            };
        }"""
    )
    if state.get("disabled"):
        raise RuntimeError("Export list button is disabled.")

    button.scroll_into_view_if_needed()
    button.click(force=True)


def click_confirm_if_any(page: Page) -> None:
    dialog_confirm = first_visible(
        [
            page.get_by_role("dialog").get_by_role("button", name=re.compile(r"export|download|confirm", re.I)),
            page.get_by_role("button", name=re.compile(r"export|download|confirm", re.I)),
        ]
    )
    if dialog_confirm is not None:
        try:
            dialog_confirm.click()
        except Exception:  # noqa: BLE001
            pass


def trigger_export_and_maybe_download(page: Page, timeout_ms: int) -> Download | None:
    try:
        with page.expect_download(timeout=8000) as dl_info:
            click_export_list(page)
            click_confirm_if_any(page)
        return dl_info.value
    except PlaywrightTimeoutError:
        return None


def open_my_exports(page: Page, buyers_url: str) -> None:
    target = urljoin(buyers_url.rstrip("/") + "/", "my-exports")
    page.goto(target, wait_until="domcontentloaded")


def exports_row_locator(page: Page) -> Locator:
    return page.locator(
        "table tbody tr, .v-data-table__wrapper tbody tr, .v-data-table tbody tr, .v-data-table__wrapper tr, [role='row']"
    )


def first_data_row(page: Page) -> Locator | None:
    rows = exports_row_locator(page)
    row_count = rows.count()
    if row_count == 0:
        return None

    for idx in range(row_count):
        row = rows.nth(idx)
        cell_count = row.locator("td, [role='cell'], [role='gridcell']").count()
        has_action = row.locator('button:has-text("Download"), button:has-text("View"), #my-exports-download-file').count()
        if cell_count > 0 or has_action > 0:
            return row
    return None


def read_first_export_row(page: Page) -> dict[str, str | bool] | None:
    row = first_data_row(page)
    if row is None:
        return None

    def cell_text(index: int) -> str:
        try:
            return row.locator("td, [role='cell'], [role='gridcell']").nth(index).inner_text().strip()
        except Exception:  # noqa: BLE001
            return ""

    status = cell_text(2)
    requested_by = cell_text(1)
    buyers_exported = cell_text(3)
    has_download_button = (
        row.locator('#my-exports-download-file, button:has-text("Download"), a:has-text("Download")').first.count() > 0
    )
    has_processing_badge = (
        row.locator(
            ':text("Processing"), :text("In progress"), button:has-text("Processing"), button:has-text("In progress")'
        ).first.count()
        > 0
    )
    return {
        "status": status,
        "requestedBy": requested_by,
        "buyersExported": buyers_exported,
        "hasDownloadButton": has_download_button,
        "hasProcessingBadge": has_processing_badge,
    }


def download_latest_triggered_export(page: Page, timeout_ms: int, job_id: str, buyers_url: str) -> Download:
    poll_attempts = 90
    poll_delay_ms = 10000
    observed_in_progress = False

    open_my_exports(page, buyers_url)
    log(job_id, "opened my exports page", {"url": page.url})

    for attempt in range(1, poll_attempts + 1):
        page.reload(wait_until="domcontentloaded")
        try:
            exports_row_locator(page).first.wait_for(timeout=7000)
        except Exception:  # noqa: BLE001
            pass

        row_count = exports_row_locator(page).count()
        snapshot = read_first_export_row(page)
        payload = {"attempt": attempt, "rowCount": row_count}
        if snapshot:
            payload.update(snapshot)
        log(job_id, "my-exports first row", payload)

        if snapshot is None:
            fallback_download = (
                page.locator('#my-exports-download-file, button:has-text("Download"), a:has-text("Download")').first.count()
                > 0
            )
            if fallback_download and attempt >= 3:
                trigger = page.locator(
                    '#my-exports-download-file, button:has-text("Download"), a:has-text("Download")'
                ).first
                with page.expect_download(timeout=timeout_ms) as dl_info:
                    trigger.click(force=True)
                return dl_info.value
            sleep_ms(poll_delay_ms)
            continue

        row = first_data_row(page)
        if row is None:
            sleep_ms(poll_delay_ms)
            continue

        download_trigger = row.locator(
            '#my-exports-download-file, button:has-text("Download"), a:has-text("Download")'
        ).first
        can_download = download_trigger.count() > 0
        still_processing = bool(snapshot.get("hasProcessingBadge")) or bool(
            re.search(r"in\s*progress|processing", str(snapshot.get("status", "")), re.I)
        )
        if still_processing:
            observed_in_progress = True

        if can_download and not still_processing and (observed_in_progress or attempt >= 3):
            with page.expect_download(timeout=timeout_ms) as dl_info:
                download_trigger.click(force=True)
            return dl_info.value

        sleep_ms(poll_delay_ms)

    raise RuntimeError("Export did not become downloadable from My exports within polling window.")


def main() -> None:
    job_id = run_id()
    config = get_config()

    if not config.storage_state_path.exists():
        raise RuntimeError(
            f"Missing session file at {config.storage_state_path}. Run `python python/login_save_session.py` first."
        )

    ensure_dir(config.downloads_dir)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=config.headless)
        context = browser.new_context(storage_state=str(config.storage_state_path), accept_downloads=True)
        page = context.new_page()
        page.set_default_timeout(config.timeout_ms)

        try:
            def load_buyers(_: int) -> None:
                page.goto(config.buyers_url, wait_until="domcontentloaded")
                assert_session(page)
                wait_for_buyers_page_ready(page, config.timeout_ms)

            retry(job_id, "buyers page load", 3, 2000, load_buyers)

            def click_export(_: int) -> Download | None:
                direct = trigger_export_and_maybe_download(page, 12000)
                log(job_id, "export list click completed", {"directDownload": bool(direct)})
                return direct

            maybe_direct = retry(job_id, "export click", 3, 2000, click_export)
            download = maybe_direct or download_latest_triggered_export(page, config.timeout_ms, job_id, config.buyers_url)

            def save(_: int) -> dict[str, str]:
                return save_download(download, config.downloads_dir)

            result = retry(job_id, "download save", 3, 2000, save)
            log(job_id, "buyers export saved", result)
        except Exception as err:  # noqa: BLE001
            message = str(err)
            if "Session expired" in message:
                raise RuntimeError(f"SESSION_EXPIRED: {message}") from err
            if "visible control for export" in message:
                raise RuntimeError(f"EXPORT_BUTTON_MISSING: {message}") from err
            if "download" in message.lower():
                raise RuntimeError(f"DOWNLOAD_TIMEOUT: {message}") from err
            raise
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
