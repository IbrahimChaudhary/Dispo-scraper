import fs from "node:fs";
import path from "node:path";
import { chromium, type Download, type Locator, type Page } from "playwright";
import {
  ensureDir,
  getConfig,
  log,
  nowStamp,
  retry,
  runId,
  sleep
} from "./common.js";

type DownloadResult = {
  filePath: string;
  suggestedFilename: string;
};

async function firstVisible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    if (await locator.first().isVisible().catch(() => false)) {
      return locator.first();
    }
  }
  return null;
}

async function clickFirst(locators: Locator[], label: string): Promise<void> {
  const target = await firstVisible(locators);
  if (!target) {
    throw new Error(`Could not find visible control for ${label}`);
  }
  await target.click();
}

async function saveDownload(download: Download, downloadsDir: string): Promise<DownloadResult> {
  const suggestedFilename = download.suggestedFilename();
  const ext = path.extname(suggestedFilename) || ".csv";
  const outFileName = `buyers-${nowStamp()}${ext}`;
  const filePath = path.join(downloadsDir, outFileName);
  await download.saveAs(filePath);
  return { filePath, suggestedFilename };
}

async function assertSession(page: Page): Promise<void> {
  const loginInputVisible = await page.locator('input[type="password"], input[type="email"]').first().isVisible().catch(() => false);
  const currentUrl = page.url();
  if (/login/i.test(currentUrl) || loginInputVisible) {
    throw new Error("Session expired. Run `npm run login:save` and try again.");
  }
}

async function waitForBuyersPageReady(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: /export|my exports/i }).first().waitFor({ timeout: timeoutMs });
}

async function triggerExportAndMaybeDownload(page: Page, timeoutMs: number): Promise<Download | null> {
  const directDownload = page.waitForEvent("download", { timeout: 8_000 }).catch(() => null);

  const exportListButton = await firstVisible([
    page.locator("button.buyers-export-button"),
    page.locator(".buyers-export-button"),
    page.getByRole("button", { name: /^\s*export list\s*$/i }),
    page.locator('button:has-text("Export list")')
  ]);
  if (!exportListButton) {
    throw new Error("Could not find visible control for export list button");
  }
  const buttonState = await exportListButton.evaluate((el) => {
    const node = el as HTMLButtonElement;
    return {
      disabled: node.disabled,
      className: node.className,
      text: (node.textContent ?? "").trim()
    };
  }).catch(() => ({ disabled: false, className: "", text: "" }));
  if (buttonState.disabled) {
    throw new Error("Export list button is disabled.");
  }

  await exportListButton.scrollIntoViewIfNeeded().catch(() => undefined);
  await exportListButton.click({ force: true });

  const dialogConfirm = await firstVisible([
    page.getByRole("dialog").getByRole("button", { name: /export|download|confirm/i }),
    page.getByRole("button", { name: /export|download|confirm/i })
  ]);
  if (dialogConfirm) {
    await dialogConfirm.click().catch(() => undefined);
  }

  const result = await Promise.race([
    directDownload,
    sleep(timeoutMs).then(() => null)
  ]);

  return result;
}

async function openMyExports(page: Page): Promise<void> {
  const target = new URL("/buyers/my-exports", page.url()).toString();
  await page.goto(target, { waitUntil: "domcontentloaded" });
}

type FirstRowSnapshot = {
  status: string;
  requestedBy: string;
  buyersExported: string;
  hasDownloadButton: boolean;
  hasProcessingBadge: boolean;
};

function exportsRowLocator(page: Page): Locator {
  return page.locator(
    "table tbody tr, .v-data-table__wrapper tbody tr, .v-data-table tbody tr, .v-data-table__wrapper tr, [role='row']"
  );
}

async function firstDataRow(page: Page): Promise<Locator | null> {
  const rows = exportsRowLocator(page);
  const rowCount = await rows.count();
  if (!rowCount) return null;

  for (let i = 0; i < rowCount; i += 1) {
    const row = rows.nth(i);
    const cellCount = await row.locator("td, [role='cell'], [role='gridcell']").count().catch(() => 0);
    const hasAction = await row
      .locator('button:has-text("Download"), button:has-text("View"), #my-exports-download-file')
      .count()
      .catch(() => 0);
    if (cellCount > 0 || hasAction > 0) {
      return row;
    }
  }

  return null;
}

async function readFirstExportRow(page: Page): Promise<FirstRowSnapshot | null> {
  const row = await firstDataRow(page);
  if (!row) return null;

  const cell = (index: number) => row.locator("td, [role='cell'], [role='gridcell']").nth(index);
  const status = (await cell(2).innerText().catch(() => "")).trim();
  const requestedBy = (await cell(1).innerText().catch(() => "")).trim();
  const buyersExported = (await cell(3).innerText().catch(() => "")).trim();
  const hasDownloadButton = await row
    .locator('#my-exports-download-file, button:has-text("Download"), a:has-text("Download")')
    .first()
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  const hasProcessingBadge = await row
    .locator(':text("Processing"), :text("In progress"), button:has-text("Processing"), button:has-text("In progress")')
    .first()
    .count()
    .then((n) => n > 0)
    .catch(() => false);

  return {
    status,
    requestedBy,
    buyersExported,
    hasDownloadButton,
    hasProcessingBadge
  };
}

async function downloadLatestTriggeredExport(page: Page, timeoutMs: number, id: string): Promise<Download> {
  const pollAttempts = 90;
  const pollDelayMs = 10_000;
  let observedInProgress = false;

  await openMyExports(page);
  log(id, "opened my exports page", { url: page.url() });

  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await exportsRowLocator(page).first().waitFor({ timeout: 7_000 }).catch(() => undefined);
    const rowCount = await exportsRowLocator(page).count().catch(() => 0);
    const snapshot = await readFirstExportRow(page);
    log(id, "my-exports first row", { attempt, rowCount, ...snapshot });

    if (!snapshot) {
      const fallbackDownload = await page
        .locator('#my-exports-download-file, button:has-text("Download"), a:has-text("Download")')
        .first()
        .count()
        .then((n) => n > 0)
        .catch(() => false);
      if (fallbackDownload && attempt >= 3) {
        const trigger = page
          .locator('#my-exports-download-file, button:has-text("Download"), a:has-text("Download")')
          .first();
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: timeoutMs }),
          trigger.click({ force: true })
        ]);
        return download;
      }
      await sleep(pollDelayMs);
      continue;
    }

    const firstRow = await firstDataRow(page);
    if (!firstRow) {
      await sleep(pollDelayMs);
      continue;
    }
    const downloadTrigger = firstRow
      .locator('#my-exports-download-file, button:has-text("Download"), a:has-text("Download")')
      .first();
    const canDownload = (await downloadTrigger.count().catch(() => 0)) > 0;
    const stillProcessing = snapshot?.hasProcessingBadge || /in\s*progress|processing/i.test(snapshot?.status ?? "");
    if (stillProcessing) {
      observedInProgress = true;
    }

    // Some exports complete too quickly and never surface a visible processing state.
    if (canDownload && !stillProcessing && (observedInProgress || attempt >= 3)) {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: timeoutMs }),
        downloadTrigger.click()
      ]);
      return download;
    }

    await sleep(pollDelayMs);
  }

  throw new Error("Export did not become downloadable from My exports within polling window.");
}

async function main(): Promise<void> {
  const id = runId();
  const config = getConfig();

  if (!fs.existsSync(config.storageStatePath)) {
    throw new Error(`Missing session file at ${config.storageStatePath}. Run \`npm run login:save\` first.`);
  }

  ensureDir(config.downloadsDir);
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({
    storageState: config.storageStatePath,
    acceptDownloads: true
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeoutMs);

  try {
    await retry(id, "buyers page load", 3, 2_000, async () => {
      await page.goto(config.buyersUrl, { waitUntil: "domcontentloaded" });
      await assertSession(page);
      await waitForBuyersPageReady(page, config.timeoutMs);
    });

    const maybeDirect = await retry(id, "export click", 3, 2_000, async () => {
      const direct = await triggerExportAndMaybeDownload(page, 12_000);
      log(id, "export list click completed", { directDownload: Boolean(direct) });
      return direct;
    });

    const download = maybeDirect ?? (await downloadLatestTriggeredExport(page, config.timeoutMs, id));

    const result = await retry(id, "download save", 3, 2_000, async () => {
      return saveDownload(download, config.downloadsDir);
    });

    log(id, "buyers export saved", result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Session expired/i.test(message)) {
      throw new Error(`SESSION_EXPIRED: ${message}`);
    }
    if (/visible control for export/i.test(message)) {
      throw new Error(`EXPORT_BUTTON_MISSING: ${message}`);
    }
    if (/download/i.test(message)) {
      throw new Error(`DOWNLOAD_TIMEOUT: ${message}`);
    }
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
