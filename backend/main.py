import json
import os
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any

import Millennium  # type: ignore

BACKEND_DIR = os.path.abspath(os.path.dirname(__file__))
# When packaged, __file__ can be `.../backend/main.py/__init__.py`, which would
# make dirname end with ".py". Normalize to the real backend folder.
if BACKEND_DIR.endswith(".py"):
    BACKEND_DIR = os.path.dirname(BACKEND_DIR)

DATA_FILE = os.path.join(BACKEND_DIR, "sfs-data.json")
STEAM_PROFILE_XML_URL = "https://steamcommunity.com/profiles/{steam_id}/?xml=1"
OWNER_NAME_CACHE_KEY = "sfs.ownerNames.v1"


def _ensure_dir() -> None:
    dir_path = BACKEND_DIR
    if os.path.isfile(dir_path):
        dir_path = os.path.dirname(dir_path)
    os.makedirs(dir_path, exist_ok=True)


def _load_all() -> dict:
    try:
        if not os.path.exists(DATA_FILE):
            return {}
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _write_all(data: dict) -> bool:
    try:
        _ensure_dir()
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"[steam-family-share-source] write failed: {e}")
        return False


def storage_get(payload: Any = None, key: str | None = None, **kwargs) -> Any:
    if isinstance(payload, dict):
        key = payload.get("key", key)
    if key is None:
        return None
    return _load_all().get(key)


def storage_set(payload: Any = None, key: str | None = None, value: Any = None, **kwargs) -> bool:
    if isinstance(payload, dict):
        key = payload.get("key", key)
        value = payload.get("value", value)
    if key is None:
        print("[steam-family-share-source] storage_set missing key")
        return False
    if value is None:
        print(f"[steam-family-share-source] storage_set received None for key={key}, skipping write")
        return False
    if not isinstance(value, str):
        try:
            value = json.dumps(value, ensure_ascii=False)
        except Exception:
            print(f"[steam-family-share-source] storage_set received non-serializable value for key={key}")
            return False
    data = _load_all()
    data[key] = value
    return _write_all(data)


def _normalize_owner_name_cache(raw: Any) -> dict[str, str]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = {}
    if not isinstance(raw, dict):
        return {}
    normalized: dict[str, str] = {}
    for steam_id, owner_name in raw.items():
        if not isinstance(steam_id, str) or not isinstance(owner_name, str):
            continue
        sid = steam_id.strip()
        name = owner_name.strip()
        if not sid or not name:
            continue
        normalized[sid] = name
    return normalized


def _parse_steam_ids(steam_ids: Any, steam_ids_csv: Any) -> list[str]:
    parsed: list[str] = []
    if isinstance(steam_ids, list):
        parsed.extend([x for x in steam_ids if isinstance(x, str)])
    elif isinstance(steam_ids_csv, str):
        parsed.extend(steam_ids_csv.split(","))
    unique: list[str] = []
    seen: set[str] = set()
    for steam_id in parsed:
        sid = steam_id.strip()
        if not sid or sid in seen:
            continue
        seen.add(sid)
        unique.append(sid)
    return unique


def _fetch_owner_name_from_profile_xml(steam_id: str) -> str | None:
    try:
        url = STEAM_PROFILE_XML_URL.format(steam_id=steam_id)
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "steam-family-share-source/1.0"},
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            body = resp.read()
        root = ET.fromstring(body)
        # steamID can be wrapped in CDATA; ElementTree exposes it as text.
        name = (root.findtext("steamID") or "").strip()
        if not name:
            return None
        return name
    except Exception:
        return None


def resolve_owner_names(
    payload: Any = None,
    steam_ids: list[str] | None = None,
    steam_ids_csv: str | None = None,
    force_refresh: bool = False,
    **kwargs,
) -> str:
    if isinstance(payload, dict):
        steam_ids = payload.get("steam_ids", steam_ids)
        steam_ids_csv = payload.get("steam_ids_csv", steam_ids_csv)
        force_refresh = bool(payload.get("force_refresh", force_refresh))
    normalized_ids = _parse_steam_ids(steam_ids, steam_ids_csv)
    if len(normalized_ids) == 0:
        return "{}"

    data = _load_all()
    owner_name_cache = _normalize_owner_name_cache(data.get(OWNER_NAME_CACHE_KEY))
    result: dict[str, str] = {}
    cache_updated = False
    for steam_id in normalized_ids:
        cached = None if force_refresh else owner_name_cache.get(steam_id)
        if cached:
            result[steam_id] = cached
            continue

        name = _fetch_owner_name_from_profile_xml(steam_id)
        if name:
            owner_name_cache[steam_id] = name
            result[steam_id] = name
            cache_updated = True

    if cache_updated:
        data[OWNER_NAME_CACHE_KEY] = json.dumps(owner_name_cache, ensure_ascii=False)
        _write_all(data)

    return json.dumps(result, ensure_ascii=False)


# Optional shim used by some templates
def Backend_receive_frontend_message(*args, **kwargs):
    print("[steam-family-share-source] Backend.receive_frontend_message stub")
    return None


class Backend:
    @staticmethod
    def receive_frontend_message(*args, **kwargs):
        return Backend_receive_frontend_message(*args, **kwargs)


class Plugin:
    def _load(self):
        _ensure_dir()
        if not os.path.exists(DATA_FILE):
            _write_all({})
        Millennium.ready()

    def _unload(self):
        pass

    def _front_end_loaded(self):
        pass

    def storage_get(self, key: str) -> Any:
        return storage_get(key=key)

    def storage_set(self, key: str, value: Any) -> bool:
        return storage_set(key=key, value=value)

    def resolve_owner_names(self, steam_ids_csv: str, force_refresh: bool = False) -> str:
        return resolve_owner_names(steam_ids_csv=steam_ids_csv, force_refresh=force_refresh)
