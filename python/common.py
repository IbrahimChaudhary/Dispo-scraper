from __future__ import annotations

import json
import os
import random
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, TypeVar

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

T = TypeVar("T")


@dataclass
class ScraperConfig:
    email: str
    password: str
    login_url: str
    buyers_url: str
    headless: bool
    timeout_ms: int
    downloads_dir: Path
    output_dir: Path
    storage_state_path: Path
    required_columns: list[str]


def ensure_dir(dir_path: Path | str) -> None:
    Path(dir_path).mkdir(parents=True, exist_ok=True)


def now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def run_id() -> str:
    return f"{int(time.time() * 1000):x}-{random.randint(0, 0xFFFFFF):06x}"


def log(job_id: str, message: str, meta: dict[str, Any] | None = None) -> None:
    payload = f" {json.dumps(meta)}" if meta else ""
    print(f"[{datetime.utcnow().isoformat()}Z] [{job_id}] {message}{payload}")


def sleep_ms(ms: int) -> None:
    time.sleep(ms / 1000)


def retry(job_id: str, label: str, attempts: int, delay_ms: int, fn: Callable[[int], T]) -> T:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            if attempt > 1:
                log(job_id, f"{label} retry", {"attempt": attempt, "attempts": attempts})
            return fn(attempt)
        except Exception as err:  # noqa: BLE001
            last_error = err
            if attempt < attempts:
                sleep_ms(delay_ms)
    if last_error is None:
        raise RuntimeError(f"Retry failed for {label}")
    raise last_error


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"Missing required env var: {name}")
    return value


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "y"}


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def get_config() -> ScraperConfig:
    required_columns = [
        part.strip()
        for part in os.getenv(
            "REQUIRED_COLUMNS",
            "Name,Mailing address,Mailing city,Zip Code,State",
        ).split(",")
        if part.strip()
    ]
    return ScraperConfig(
        email=_required_env("BUYERS_EMAIL"),
        password=_required_env("BUYERS_PASSWORD"),
        login_url=os.getenv("BUYERS_LOGIN_URL", "https://skinnovationsllc.8020rei.com/session/login").strip(),
        buyers_url=os.getenv("BUYERS_URL", "https://skinnovationsllc.8020rei.com/buyers").strip(),
        headless=_bool_env("HEADLESS", False),
        timeout_ms=_int_env("ACTION_TIMEOUT_MS", 60000),
        downloads_dir=ROOT_DIR / "downloads",
        output_dir=ROOT_DIR / "output",
        storage_state_path=ROOT_DIR / "auth" / "storageState.json",
        required_columns=required_columns,
    )
