"""Local credentials; neither routes nor workflows expose the API key."""
import json
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent


@dataclass(frozen=True)
class Config:
    base_url: str = "https://bbh-ai-server.benbh.cn"
    api_key: str = ""
    # Internal timing defaults; not read from config.json or environment variables.
    request_timeout_seconds: float = 30
    poll_interval_seconds: float = 5


def load_config():
    path = ROOT / "config.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
    except (ValueError, OSError) as exc:
        raise ValueError("Benbh Bridge：config.json 无法读取，请检查 JSON 格式。") from exc
    if not isinstance(data, dict):
        raise ValueError("Benbh Bridge：config.json 必须是对象。")
    base = str(os.getenv("BENBH_BASE_URL") or data.get("base_url") or Config.base_url).rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Benbh Bridge：平台地址必须是 HTTP(S) 地址，不能包含用户名或密码。")
    # Ignore legacy timing fields, including task_timeout_seconds.
    return Config(base_url=base, api_key=str(os.getenv("BENBH_API_KEY") or data.get("api_key") or "").strip())
