# Buyers Scraper (8020REI)

Node.js + Playwright scraper for exporting buyers data from the 8020REI buyers page.

## What this does

- Logs in once and stores authenticated browser session state.
- Opens buyers page directly with saved session.
- Triggers `Export list`.
- Falls back to polling `My exports` when export is async.
- Saves downloaded file in `downloads/`.
- Verifies required columns and writes normalized JSON to `output/latest.json`.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Install browser binary:

   ```bash
   npm run doctor
   ```

3. Create `.env` from `.env.example` and fill values:

   ```bash
   cp .env.example .env
   ```

## Run phase-by-phase

### Phase 1: Save login session

```bash
npm run login:save
```

Expected result:
- `auth/storageState.json` is created.
- Script logs `session saved`.

### Phase 2 + 3: Export buyers data

```bash
npm run buyers:export
```

Expected result:
- New file appears in `downloads/`.
- Script logs `buyers export saved`.

### Phase 4: Verify export

```bash
npm run buyers:verify
```

Expected result:
- Row count printed in logs.
- Required columns check passes.
- `output/latest.json` generated.

### Single command run

```bash
npm run buyers:run
```

This runs export + verify in sequence.

## Reliability behavior

- Retries page load, export action, and download save.
- Raises categorized errors:
  - `SESSION_EXPIRED`
  - `EXPORT_BUTTON_MISSING`
  - `DOWNLOAD_TIMEOUT`

## Windows Task Scheduler (daily/weekly)

1. Open **Task Scheduler** -> **Create Basic Task**.
2. Trigger: choose Daily/Weekly.
3. Action: **Start a program**.
4. Program/script: path to `cmd.exe`.
5. Add arguments:

   ```text
   /c cd /d C:\Users\user\Desktop\Web\Dispo-scraper && npm run buyers:run
   ```

6. Finish and run task once manually to validate.

## Security notes

- Never commit `.env`, `auth/storageState.json`, or downloaded buyer files.
- If credentials were shared in plain text, rotate them.
