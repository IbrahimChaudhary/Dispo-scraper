# Buyers Scraper (8020REI)

Python + Playwright scraper for exporting buyers data from the 8020REI buyers page.

## What this does

- Logs in once and stores authenticated browser session state.
- Opens buyers page directly with saved session.
- Triggers `Export list`.
- Falls back to polling `My exports` when export is async.
- Saves downloaded file in `downloads/`.
- Verifies required columns and writes normalized JSON to `output/latest.json`.

## Setup

1. Create and activate a virtual environment:

   ```bash
   python -m venv .venv
   .venv\Scripts\activate
   ```

2. Install Python dependencies:

   ```bash
   pip install -r requirements.txt
   ```

3. Install Playwright browser:

   ```bash
   python -m playwright install chromium
   ```

4. Create `.env` from `.env.example` and fill values:

   ```bash
   cp .env.example .env
   ```

## Run phase-by-phase

### Phase 1: Save login session

```bash
python python/login_save_session.py
```

Expected result:
- `auth/storageState.json` is created.
- Script logs `session saved`.

### Phase 2 + 3: Export buyers data

```bash
python python/export_buyers.py
```

Expected result:
- New file appears in `downloads/`.
- Script logs `buyers export saved`.

### Phase 4: Verify export

```bash
python python/verify_export.py
```

Expected result:
- Row count printed in logs.
- Required columns check passes.
- `output/latest.json` generated.

### Single command run

```bash
python python/export_buyers.py && python python/verify_export.py
```

This runs export + verify in sequence.

### Sequential pipeline (automatic chaining)

Runs each step only after the previous one completes:

```bash
python python/run_pipeline.py
```

For repeated runs when session is already saved:

```bash
python python/run_pipeline.py --skip-login
```

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
   /c cd /d C:\Users\user\Desktop\Web\Dispo-scraper && .venv\Scripts\python.exe python\export_buyers.py && .venv\Scripts\python.exe python\verify_export.py
   ```

6. Finish and run task once manually to validate.

## Security notes

- Never commit `.env`, `auth/storageState.json`, or downloaded buyer files.
- If credentials were shared in plain text, rotate them.
