from __future__ import annotations

import argparse
import sys
from typing import Callable

import export_buyers
import login_save_session
import verify_export
from common import log, run_id


def run_step(job_id: str, name: str, fn: Callable[[], None]) -> None:
    log(job_id, f"{name} started")
    fn()
    log(job_id, f"{name} completed")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run buyers scraper pipeline sequentially."
    )
    parser.add_argument(
        "--skip-login",
        action="store_true",
        help="Skip login step and reuse existing auth/storageState.json",
    )
    args = parser.parse_args()

    job_id = run_id()
    log(job_id, "pipeline started", {"skipLogin": args.skip_login})

    try:
        if not args.skip_login:
            run_step(job_id, "login_save_session", login_save_session.main)
        run_step(job_id, "export_buyers", export_buyers.main)
        run_step(job_id, "verify_export", verify_export.main)
        log(job_id, "pipeline completed successfully")
    except Exception as err:  # noqa: BLE001
        log(job_id, "pipeline failed", {"error": str(err)})
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        sys.exit(1)
