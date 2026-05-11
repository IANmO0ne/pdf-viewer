from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import time
import traceback
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import decky


DEFAULT_PDF_FOLDER = os.environ.get(
    "PDF_VIEWER_DEFAULT_FOLDER", "/home/deck/Documents/PDF Seamdeck"
)
PLUGIN_VERSION = "0.1.25"
SETTINGS_FILE = "settings.json"
STATE_FILE = "state.json"
MIN_ZOOM = 0.5
MAX_ZOOM = 8.0
PDF_ID_RE = re.compile(r"^[a-f0-9]{64}$")
RENDER_ID_RE = re.compile(r"^[a-f0-9]{64}$")
SUPPORTED_EXTENSIONS = {
    ".pdf": "pdf",
    ".epub": "epub",
    ".txt": "text",
    ".md": "text",
}
TEXT_SIZE_LIMIT_BYTES = 2 * 1024 * 1024
MAX_LIBRARY_FILES = 500
MAX_SCAN_SECONDS = 2.0
QUICK_SCAN_FILES = 25
NATIVE_RENDER_MIN_WIDTH = 240
NATIVE_RENDER_MAX_WIDTH = 3200
NATIVE_RENDER_TIMEOUT_SECONDS = 45


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def default_settings() -> dict[str, Any]:
    return {
        "pdfFolder": DEFAULT_PDF_FOLDER,
        "viewMode": "single",
        "fitMode": "width",
        "zoomStep": 0.25,
    }


def default_pdf_state() -> dict[str, Any]:
    return {
        "lastPage": 1,
        "zoom": 1.0,
        "bookmarks": [],
    }


def decky_path(name: str, fallback: str) -> Path:
    value = os.environ.get(name) or getattr(decky, name, "") or fallback
    return Path(value)


class Plugin:
    def __init__(self) -> None:
        home = Path(os.environ.get("HOME", "/home/deck"))
        self.settings_dir = decky_path(
            "DECKY_PLUGIN_SETTINGS_DIR",
            str(home / "homebrew" / "settings" / "decky-pdf-viewer"),
        )
        self.runtime_dir = decky_path(
            "DECKY_PLUGIN_RUNTIME_DIR",
            str(home / "homebrew" / "data" / "decky-pdf-viewer"),
        )
        self.log_dir = decky_path(
            "DECKY_PLUGIN_LOG_DIR",
            str(home / "homebrew" / "logs" / "decky-pdf-viewer"),
        )
        self.settings_path = self.settings_dir / SETTINGS_FILE
        self.state_path = self.settings_dir / STATE_FILE

        self._settings: dict[str, Any] = default_settings()
        self._state: dict[str, Any] = {}
        self._file_index: dict[str, Path] = {}
        self._render_index: dict[str, Path] = {}
        self._last_scan: dict[str, Any] = {
            "status": "not_started",
            "folder": "",
            "count": 0,
            "elapsedMs": 0,
            "error": "",
        }
        self._server: asyncio.AbstractServer | None = None
        self._server_port = 0
        self._token = secrets.token_urlsafe(32)
        self._lock: asyncio.Lock | None = None
        self._storage_loaded = False

    async def _main(self) -> None:
        self._lock = asyncio.Lock()
        self._log(
            "info",
            "PDF Viewer backend started in safe mode",
            {"version": PLUGIN_VERSION, "pdfFolder": self._settings["pdfFolder"]},
        )

    async def _unload(self) -> None:
        await self._stop_http_server()
        self._log("info", "PDF Viewer stopped")

    async def _uninstall(self) -> None:
        self._log("info", "PDF Viewer uninstall requested; user PDFs and settings kept")

    async def _migration(self) -> None:
        return None

    async def get_settings(self) -> dict[str, Any]:
        async with self._get_lock():
            self._ensure_storage_loaded()
            return copy.deepcopy(self._settings)

    async def save_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        async with self._get_lock():
            self._ensure_storage_loaded()
            merged = {**self._settings, **(settings or {})}
            self._settings = self._sanitize_settings(merged)
            self._ensure_pdf_folder()
            self._write_json(self.settings_path, self._settings)
            self._log("info", "Settings saved", {"pdfFolder": self._settings["pdfFolder"]})
            return copy.deepcopy(self._settings)

    async def list_pdfs(self) -> list[dict[str, Any]]:
        async with self._get_lock():
            self._ensure_storage_loaded()
            entries = self._refresh_file_index()
            self._log(
                "debug",
                "Library folder scanned",
                {
                    "folder": self._settings["pdfFolder"],
                    "count": len(entries),
                    "recursive": False,
                },
            )
            return entries

    async def get_pdf_access(self, pdf_id: str) -> dict[str, Any]:
        async with self._get_lock():
            self._ensure_storage_loaded()
            self._validate_pdf_id(pdf_id)
            path = self._file_index.get(pdf_id)
            if path is None:
                self._refresh_file_index()
                path = self._file_index.get(pdf_id)
            if path is None:
                self._log("warning", "File access requested for missing file", {"id": pdf_id})
                raise FileNotFoundError("File is no longer available in the configured folder")
            if path.suffix.lower() != ".pdf":
                raise ValueError("This file is not a PDF")

            await self._start_http_server()
            return {
                "id": pdf_id,
                "url": f"http://127.0.0.1:{self._server_port}/pdf/{pdf_id}?token={self._token}",
                "sizeBytes": path.stat().st_size,
            }

    async def get_native_render_status(self) -> dict[str, Any]:
        renderer = self._select_native_renderer()
        return {
            "version": PLUGIN_VERSION,
            "timestamp": utc_now(),
            "available": renderer is not None,
            "renderer": renderer[0] if renderer else "",
            "executable": renderer[1] if renderer else "",
            "message": (
                f"Native renderer {renderer[0]} is available"
                if renderer
                else "Native PDF renderer was not found on this Steam Deck"
            ),
        }

    async def get_native_page_render(
        self, pdf_id: str, page: int, width: int
    ) -> dict[str, Any]:
        async with self._get_lock():
            self._ensure_storage_loaded()
            self._validate_pdf_id(pdf_id)
            path = self._file_index.get(pdf_id)
            if path is None:
                self._refresh_file_index()
                path = self._file_index.get(pdf_id)
            if path is None:
                raise FileNotFoundError("File is no longer available in the configured folder")
            if path.suffix.lower() != ".pdf":
                raise ValueError("Native rendering only supports PDF files")

            pdf_path = path.resolve()
            await self._start_http_server()

        renderer = self._select_native_renderer()
        if renderer is None:
            raise RuntimeError(
                "Native PDF renderer is not available on this Steam Deck. "
                "Use normal rendering, or install/check Poppler or MuPDF outside the plugin."
            )
        renderer_name, executable = renderer

        page_number = max(1, int(page))
        render_width = max(
            NATIVE_RENDER_MIN_WIDTH,
            min(NATIVE_RENDER_MAX_WIDTH, int(width or NATIVE_RENDER_MIN_WIDTH)),
        )
        pdf_stat = pdf_path.stat()
        render_key = (
            f"{pdf_id}:{page_number}:{render_width}:"
            f"{pdf_stat.st_size}:{int(pdf_stat.st_mtime)}:{renderer_name}"
        )
        render_id = hashlib.sha256(render_key.encode("utf-8")).hexdigest()
        output_dir = self.runtime_dir / "native-render"
        output_path = output_dir / f"{render_id}.png"

        if not output_path.exists():
            output_dir.mkdir(parents=True, exist_ok=True)
            await self._render_pdf_page_native(
                renderer=renderer_name,
                executable=executable,
                pdf_path=pdf_path,
                output_path=output_path,
                page=page_number,
                width=render_width,
            )

        self._render_index[render_id] = output_path
        return {
            "version": PLUGIN_VERSION,
            "timestamp": utc_now(),
            "id": render_id,
            "url": (
                f"http://127.0.0.1:{self._server_port}/render/{render_id}"
                f"?token={self._token}"
            ),
            "renderer": renderer_name,
            "page": page_number,
            "width": render_width,
            "sizeBytes": output_path.stat().st_size,
        }

    async def get_text_content(self, file_id: str) -> dict[str, Any]:
        async with self._get_lock():
            self._ensure_storage_loaded()
            self._validate_pdf_id(file_id)
            path = self._file_index.get(file_id)
            if path is None:
                self._refresh_file_index()
                path = self._file_index.get(file_id)
            if path is None:
                raise FileNotFoundError("File is no longer available in the configured folder")

            kind = self._kind_for_path(path)
            if kind == "pdf":
                raise ValueError("PDF files must be opened through the PDF renderer")
            if kind == "epub":
                text = self._extract_epub_text(path)
            else:
                text = self._read_plain_text(path)

            return {
                "id": file_id,
                "kind": kind,
                "name": path.name,
                "text": text,
            }

    async def get_pdf_state(self, pdf_id: str) -> dict[str, Any]:
        async with self._get_lock():
            self._ensure_storage_loaded()
            self._validate_pdf_id(pdf_id)
            state = self._state_for(pdf_id)
            return copy.deepcopy(state)

    async def save_pdf_position(self, pdf_id: str, page: int, zoom: float) -> dict[str, Any]:
        async with self._get_lock():
            self._ensure_storage_loaded()
            self._validate_pdf_id(pdf_id)
            state = self._state_for(pdf_id)
            state["lastPage"] = max(1, int(page))
            state["zoom"] = self._clamp_zoom(zoom)
            self._write_json(self.state_path, self._state)
            return copy.deepcopy(state)

    async def toggle_bookmark(self, pdf_id: str, page: int) -> dict[str, Any]:
        async with self._get_lock():
            self._ensure_storage_loaded()
            self._validate_pdf_id(pdf_id)
            page_number = max(1, int(page))
            state = self._state_for(pdf_id)
            bookmarks = state["bookmarks"]
            existing = next(
                (bookmark for bookmark in bookmarks if bookmark.get("page") == page_number),
                None,
            )

            if existing:
                bookmarks.remove(existing)
                bookmarked = False
            else:
                bookmarks.append({"page": page_number, "createdAt": utc_now()})
                bookmarked = True

            bookmarks.sort(key=lambda bookmark: int(bookmark.get("page", 0)))
            self._write_json(self.state_path, self._state)
            return {
                "bookmarked": bookmarked,
                "bookmarks": copy.deepcopy(bookmarks),
            }

    async def list_bookmarks(self, pdf_id: str) -> list[dict[str, Any]]:
        async with self._get_lock():
            self._ensure_storage_loaded()
            self._validate_pdf_id(pdf_id)
            return copy.deepcopy(self._state_for(pdf_id)["bookmarks"])

    async def log_frontend_event(
        self, level: str, message: str, context: dict[str, Any] | None = None
    ) -> bool:
        self._log(level, message, context or {})
        return True

    async def get_log_info(self) -> dict[str, str]:
        return {
            "logFile": os.environ.get("DECKY_PLUGIN_LOG")
            or getattr(decky, "DECKY_PLUGIN_LOG", ""),
            "logDir": str(self.log_dir),
            "settingsFile": str(self.settings_path),
            "stateFile": str(self.state_path),
        }

    async def get_plugin_status(self) -> dict[str, Any]:
        return {
            "version": PLUGIN_VERSION,
            "timestamp": utc_now(),
        }

    async def get_settings_status(self) -> dict[str, Any]:
        async with self._get_lock():
            try:
                self._ensure_plugin_dirs()
                settings_existed = self.settings_path.exists()
                loaded_settings = self._sanitize_settings(
                    self._read_json(self.settings_path, self._settings)
                )
                if not settings_existed:
                    self._write_json(self.settings_path, loaded_settings)

                self._settings = loaded_settings
                return {
                    "version": PLUGIN_VERSION,
                    "timestamp": utc_now(),
                    "ok": True,
                    "settingsFile": str(self.settings_path),
                    "settingsExists": self.settings_path.exists(),
                    "stateFile": str(self.state_path),
                    "logDir": str(self.log_dir),
                    "pdfFolder": loaded_settings["pdfFolder"],
                    "error": "",
                }
            except Exception as error:
                self._log(
                    "error",
                    "Settings status check failed",
                    {"error": str(error), "traceback": traceback.format_exc(limit=5)},
                )
                return {
                    "version": PLUGIN_VERSION,
                    "timestamp": utc_now(),
                    "ok": False,
                    "settingsFile": str(self.settings_path),
                    "settingsExists": False,
                    "stateFile": str(self.state_path),
                    "logDir": str(self.log_dir),
                    "pdfFolder": self._settings.get("pdfFolder", DEFAULT_PDF_FOLDER),
                    "error": str(error),
                }

    async def get_folder_probe(self) -> dict[str, Any]:
        folder = Path(DEFAULT_PDF_FOLDER).expanduser().absolute()
        try:
            probe = self._probe_folder(folder)
            return {
                "version": PLUGIN_VERSION,
                "timestamp": utc_now(),
                "folder": str(folder),
                "supportedExtensions": sorted(SUPPORTED_EXTENSIONS.keys()),
                "probe": probe,
            }
        except Exception as error:
            self._log(
                "error",
                "Folder probe failed",
                {
                    "folder": str(folder),
                    "error": str(error),
                    "traceback": traceback.format_exc(limit=5),
                },
            )
            return {
                "version": PLUGIN_VERSION,
                "timestamp": utc_now(),
                "folder": str(folder),
                "supportedExtensions": sorted(SUPPORTED_EXTENSIONS.keys()),
                "probe": {
                    "status": "error",
                    "exists": False,
                    "isDir": False,
                    "error": str(error),
                    "entries": [],
                },
            }

    async def get_library_diagnostics(self) -> dict[str, Any]:
        self._ensure_storage_loaded()
        return self._get_library_diagnostics_sync()

    def _get_library_diagnostics_sync(self) -> dict[str, Any]:
        active_folder = Path(self._settings["pdfFolder"]).expanduser()
        return {
            "activeFolder": str(active_folder),
            "activeExists": active_folder.exists(),
            "supportedExtensions": sorted(SUPPORTED_EXTENSIONS.keys()),
            "candidates": [
                {
                    "folder": str(active_folder),
                    "exists": active_folder.exists(),
                    "supportedCount": self._count_supported_files(
                        active_folder,
                        file_limit=QUICK_SCAN_FILES,
                        seconds=1.0,
                    ),
                }
            ],
        }

    async def get_debug_info(self) -> dict[str, Any]:
        self._ensure_storage_loaded()
        folder = Path(self._settings["pdfFolder"]).expanduser().absolute()
        try:
            probe = self._probe_folder(folder)
        except Exception as error:
            probe = {
                "status": "error",
                "error": str(error),
                "entries": [],
            }

        return {
            "version": PLUGIN_VERSION,
            "timestamp": utc_now(),
            "settingsFolder": str(self.settings_dir),
            "activeFolder": str(folder),
            "lastScan": copy.deepcopy(self._last_scan),
            "probe": probe,
            "supportedExtensions": sorted(SUPPORTED_EXTENSIONS.keys()),
        }

    def _get_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def _ensure_storage_loaded(self) -> None:
        if self._storage_loaded:
            return

        self._ensure_plugin_dirs()
        self._settings = self._sanitize_settings(
            self._read_json(self.settings_path, self._settings)
        )
        self._state = self._read_json(self.state_path, {})
        self._ensure_pdf_folder()
        self._storage_loaded = True
        self._log(
            "info",
            "PDF Viewer storage loaded",
            {"pdfFolder": self._settings["pdfFolder"]},
        )

    def _ensure_plugin_dirs(self) -> None:
        self.settings_dir.mkdir(parents=True, exist_ok=True)
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)

    def _ensure_pdf_folder(self) -> None:
        folder = self._settings.get("pdfFolder") or DEFAULT_PDF_FOLDER
        path = Path(folder).expanduser()
        path.mkdir(parents=True, exist_ok=True)

    def _read_json(self, path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
        if not path.exists():
            return copy.deepcopy(fallback)

        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception as error:
            self._log(
                "warning",
                "JSON file could not be read; using fallback",
                {"path": str(path), "error": str(error)},
            )

        return copy.deepcopy(fallback)

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_suffix(path.suffix + ".tmp")
        temp_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temp_path.replace(path)

    def _sanitize_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        sanitized = default_settings()

        sanitized["viewMode"] = "single"
        sanitized["fitMode"] = "width"

        zoom_step = settings.get("zoomStep", sanitized["zoomStep"])
        try:
            sanitized["zoomStep"] = min(1.0, max(0.05, float(zoom_step)))
        except (TypeError, ValueError):
            sanitized["zoomStep"] = 0.25

        return sanitized

    def _state_for(self, pdf_id: str) -> dict[str, Any]:
        raw_state = self._state.get(pdf_id)
        if not isinstance(raw_state, dict):
            self._state[pdf_id] = default_pdf_state()
            return self._state[pdf_id]

        normalized = default_pdf_state()
        try:
            normalized["lastPage"] = max(1, int(raw_state.get("lastPage", 1)))
        except (TypeError, ValueError):
            normalized["lastPage"] = 1
        normalized["zoom"] = self._clamp_zoom(raw_state.get("zoom", 1.0))
        normalized["bookmarks"] = self._sanitize_bookmarks(raw_state.get("bookmarks", []))
        self._state[pdf_id] = normalized
        return normalized

    def _sanitize_bookmarks(self, bookmarks: Any) -> list[dict[str, Any]]:
        if not isinstance(bookmarks, list):
            return []

        clean: list[dict[str, Any]] = []
        seen_pages: set[int] = set()
        for bookmark in bookmarks:
            if not isinstance(bookmark, dict):
                continue
            try:
                page = max(1, int(bookmark.get("page", 1)))
            except (TypeError, ValueError):
                continue
            if page in seen_pages:
                continue
            created_at = bookmark.get("createdAt")
            if not isinstance(created_at, str) or not created_at:
                created_at = utc_now()
            clean.append({"page": page, "createdAt": created_at})
            seen_pages.add(page)

        clean.sort(key=lambda bookmark: int(bookmark["page"]))
        return clean

    def _clamp_zoom(self, zoom: Any) -> float:
        try:
            value = float(zoom)
        except (TypeError, ValueError):
            value = 1.0
        return round(min(MAX_ZOOM, max(MIN_ZOOM, value)), 2)

    def _count_supported_files(
        self,
        folder: Path,
        file_limit: int = QUICK_SCAN_FILES,
        seconds: float = 1.0,
    ) -> int:
        try:
            if not folder.exists() or not folder.is_dir():
                return 0
        except OSError:
            return 0

        count = 0
        for _path, _kind in self._iter_supported_files(
            folder,
            file_limit=file_limit,
            seconds=seconds,
        ):
            count += 1
        return count

    def _iter_supported_files(
        self,
        folder: Path,
        file_limit: int = MAX_LIBRARY_FILES,
        seconds: float = MAX_SCAN_SECONDS,
    ):
        yielded_files = 0
        deadline = time.monotonic() + seconds

        try:
            with os.scandir(folder) as iterator:
                for entry in iterator:
                    if time.monotonic() >= deadline:
                        self._log(
                            "warning",
                            "Library scan stopped after time limit",
                            {"folder": str(folder), "seconds": seconds},
                        )
                        return

                    try:
                        if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                            continue

                        entry_path = Path(entry.path)
                        kind = self._kind_for_path(entry_path)
                        if kind is None:
                            continue

                        yielded_files += 1
                        if yielded_files > file_limit:
                            self._log(
                                "warning",
                                "Library scan stopped after file limit",
                                {"folder": str(folder), "fileLimit": file_limit},
                            )
                            return
                        yield entry_path, kind
                    except OSError as error:
                        self._log(
                            "warning",
                            "Skipping unreadable library entry",
                            {"entry": entry.path, "error": str(error)},
                        )
        except OSError as error:
            self._log(
                "warning",
                "Unable to scan library directory",
                {"folder": str(folder), "error": str(error)},
            )
            return

    def _refresh_file_index(self) -> list[dict[str, Any]]:
        folder = Path(self._settings["pdfFolder"]).expanduser().absolute()
        self._last_scan = {
            "status": "running",
            "folder": str(folder),
            "count": 0,
            "elapsedMs": 0,
            "error": "",
        }

        started = time.monotonic()
        try:
            entries, index = self._scan_supported_files_for_folder(folder)
        except Exception as error:
            elapsed_ms = round((time.monotonic() - started) * 1000)
            self._last_scan = {
                "status": "error",
                "folder": str(folder),
                "count": 0,
                "elapsedMs": elapsed_ms,
                "error": str(error),
            }
            self._file_index = {}
            self._log("error", "Library scan failed", self._last_scan)
            raise

        elapsed_ms = round((time.monotonic() - started) * 1000)
        self._file_index = index
        self._last_scan = {
            "status": "ok",
            "folder": str(folder),
            "count": len(entries),
            "elapsedMs": elapsed_ms,
            "error": "",
        }
        return entries

    def _scan_supported_files(self) -> list[dict[str, Any]]:
        folder = Path(self._settings["pdfFolder"]).expanduser().absolute()
        entries, index = self._scan_supported_files_for_folder(folder)
        self._file_index = index
        self._last_scan = {
            "status": "ok",
            "folder": str(folder),
            "count": len(entries),
            "elapsedMs": 0,
            "error": "",
        }
        return entries

    def _scan_supported_files_for_folder(
        self,
        folder: Path,
    ) -> tuple[list[dict[str, Any]], dict[str, Path]]:
        folder.mkdir(parents=True, exist_ok=True)

        entries: list[dict[str, Any]] = []
        index: dict[str, Path] = {}

        for child, kind in self._iter_supported_files(folder):
            try:
                if not child.is_file():
                    continue

                stat = child.stat()
                pdf_id = self._pdf_id(child)
                index[pdf_id] = child
                entries.append(
                    {
                        "id": pdf_id,
                        "kind": kind,
                        "name": child.name,
                        "relativePath": child.name,
                        "sizeBytes": stat.st_size,
                        "modifiedTime": datetime.fromtimestamp(
                            stat.st_mtime, tz=timezone.utc
                        ).isoformat(timespec="seconds"),
                    }
                )
            except Exception as error:
                self._log(
                    "warning",
                    "Skipping unreadable library entry",
                    {"entry": str(child), "error": str(error)},
                )

        entries.sort(key=lambda entry: entry["relativePath"].casefold())
        return entries, index

    def _probe_folder(self, folder: Path) -> dict[str, Any]:
        try:
            exists = folder.exists()
            is_dir = folder.is_dir()
        except OSError as error:
            return {
                "status": "error",
                "exists": False,
                "isDir": False,
                "error": str(error),
                "entries": [],
            }

        result: dict[str, Any] = {
            "status": "ok",
            "exists": exists,
            "isDir": is_dir,
            "error": "",
            "entries": [],
        }
        if not exists or not is_dir:
            return result

        entries: list[dict[str, Any]] = []
        deadline = time.monotonic() + 1.5
        try:
            with os.scandir(folder) as iterator:
                for entry in iterator:
                    if time.monotonic() >= deadline or len(entries) >= 25:
                        break
                    try:
                        path = Path(entry.path)
                        entries.append(
                            {
                                "name": entry.name,
                                "isFile": entry.is_file(follow_symlinks=False),
                                "isDir": entry.is_dir(follow_symlinks=False),
                                "suffix": path.suffix.lower(),
                                "kind": self._kind_for_path(path),
                            }
                        )
                    except OSError as error:
                        entries.append(
                            {
                                "name": entry.name,
                                "error": str(error),
                            }
                        )
        except OSError as error:
            result["status"] = "error"
            result["error"] = str(error)

        result["entries"] = entries
        return result

    def _kind_for_path(self, path: Path) -> str | None:
        return SUPPORTED_EXTENSIONS.get(path.suffix.lower())

    def _read_plain_text(self, path: Path) -> str:
        size = path.stat().st_size
        if size > TEXT_SIZE_LIMIT_BYTES:
            raise ValueError("Text file is too large to preview in the Decky overlay")

        data = path.read_bytes()
        for encoding in ("utf-8", "utf-16", "latin-1"):
            try:
                return data.decode(encoding)
            except UnicodeDecodeError:
                continue
        return data.decode("utf-8", errors="replace")

    def _extract_epub_text(self, path: Path) -> str:
        parts: list[str] = []
        with zipfile.ZipFile(path) as archive:
            names = [
                name
                for name in archive.namelist()
                if name.lower().endswith((".xhtml", ".html", ".htm"))
                and not name.lower().startswith("meta-inf/")
            ]
            names.sort()
            total_chars = 0
            for name in names[:80]:
                raw = archive.read(name)
                if len(raw) > TEXT_SIZE_LIMIT_BYTES:
                    continue
                text = self._html_to_text(raw)
                if not text:
                    continue
                parts.append(text)
                total_chars += len(text)
                if total_chars >= 250_000:
                    parts.append("\n[Preview stopped here to keep the Decky overlay responsive.]")
                    break

        if not parts:
            raise ValueError("No readable text content was found in this EPUB")
        return "\n\n".join(parts)

    def _html_to_text(self, raw: bytes) -> str:
        decoded = raw.decode("utf-8", errors="replace")
        stripped = re.sub(r"<(script|style).*?</\1>", "", decoded, flags=re.I | re.S)
        stripped = re.sub(r"<[^>]+>", "\n", stripped)
        stripped = stripped.replace("&nbsp;", " ")
        stripped = stripped.replace("&amp;", "&")
        stripped = stripped.replace("&lt;", "<")
        stripped = stripped.replace("&gt;", ">")
        stripped = stripped.replace("&quot;", '"')
        stripped = stripped.replace("&#39;", "'")
        stripped = re.sub(r"[ \t\r\f\v]+", " ", stripped)
        stripped = re.sub(r"\n\s+", "\n", stripped)
        stripped = re.sub(r"\n{3,}", "\n\n", stripped)
        return stripped.strip()

    def _pdf_id(self, path: Path) -> str:
        normalized_path = str(path.resolve())
        return hashlib.sha256(normalized_path.encode("utf-8")).hexdigest()

    def _find_executable(self, name: str) -> str | None:
        found = shutil.which(name)
        if found:
            return found

        for candidate in (
            Path("/usr/bin") / name,
            Path("/bin") / name,
            Path("/usr/local/bin") / name,
        ):
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)

        return None

    def _select_native_renderer(self) -> tuple[str, str] | None:
        for renderer in ("pdftoppm", "pdftocairo", "mutool"):
            executable = self._find_executable(renderer)
            if executable:
                return renderer, executable
        return None

    async def _render_pdf_page_native(
        self,
        renderer: str,
        executable: str,
        pdf_path: Path,
        output_path: Path,
        page: int,
        width: int,
    ) -> None:
        if output_path.exists():
            output_path.unlink()

        output_prefix = output_path.with_suffix("")
        if renderer in {"pdftoppm", "pdftocairo"}:
            command = [
                executable,
                "-f",
                str(page),
                "-l",
                str(page),
                "-scale-to-x",
                str(width),
                "-scale-to-y",
                "-1",
                "-png",
                "-singlefile",
                str(pdf_path),
                str(output_prefix),
            ]
        elif renderer == "mutool":
            command = [
                executable,
                "draw",
                "-F",
                "png",
                "-o",
                str(output_path),
                "-w",
                str(width),
                str(pdf_path),
                str(page),
            ]
        else:
            raise RuntimeError(f"Unsupported native PDF renderer: {renderer}")
        started = time.monotonic()
        loop = asyncio.get_running_loop()

        def run_command() -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=NATIVE_RENDER_TIMEOUT_SECONDS,
            )

        try:
            result = await loop.run_in_executor(None, run_command)
        except subprocess.TimeoutExpired as error:
            self._log(
                "error",
                "Native PDF render timed out",
                {
                    "pdf": pdf_path.name,
                    "page": page,
                    "width": width,
                    "renderer": renderer,
                    "error": str(error),
                },
            )
            raise RuntimeError(
                "Native PDF renderer took too long. This PDF may be very large or damaged."
            ) from error

        elapsed_ms = int((time.monotonic() - started) * 1000)
        if result.returncode != 0 or not output_path.exists():
            self._log(
                "error",
                "Native PDF render failed",
                {
                    "pdf": pdf_path.name,
                    "page": page,
                    "width": width,
                    "renderer": renderer,
                    "returnCode": result.returncode,
                    "stdout": result.stdout[-1000:],
                    "stderr": result.stderr[-1000:],
                    "elapsedMs": elapsed_ms,
                },
            )
            raise RuntimeError(
                "Native PDF renderer could not render this page. "
                "The PDF may be corrupted or use a structure this renderer cannot read."
            )

        self._log(
            "debug",
            "Native PDF page rendered",
            {
                "pdf": pdf_path.name,
                "page": page,
                "width": width,
                "renderer": renderer,
                "sizeBytes": output_path.stat().st_size,
                "elapsedMs": elapsed_ms,
            },
        )

    def _validate_pdf_id(self, pdf_id: str) -> None:
        if not isinstance(pdf_id, str) or PDF_ID_RE.fullmatch(pdf_id) is None:
            self._log("warning", "Invalid PDF id rejected", {"id": str(pdf_id)})
            raise ValueError("Invalid PDF id")

    async def _start_http_server(self) -> None:
        if self._server is not None:
            return

        self._server = await asyncio.start_server(
            self._handle_http_client,
            host="127.0.0.1",
            port=0,
        )
        sockets = self._server.sockets or []
        if not sockets:
            raise RuntimeError("PDF HTTP server did not bind to a port")
        self._server_port = int(sockets[0].getsockname()[1])

    async def _stop_http_server(self) -> None:
        if self._server is None:
            return

        self._server.close()
        await self._server.wait_closed()
        self._server = None
        self._server_port = 0

    async def _handle_http_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5)
            if not request_line:
                return

            try:
                method, target, _version = request_line.decode("iso-8859-1").strip().split(
                    " ", 2
                )
            except ValueError:
                await self._send_simple_response(writer, 400, "Bad Request", b"Bad Request")
                return

            headers = await self._read_headers(reader)
            method = method.upper()

            if method == "OPTIONS":
                await self._send_simple_response(writer, 204, "No Content", b"")
                return

            if method not in {"GET", "HEAD"}:
                await self._send_simple_response(
                    writer, 405, "Method Not Allowed", b"Method Not Allowed"
                )
                return

            parsed = urlparse(target)
            if not (
                parsed.path.startswith("/pdf/") or parsed.path.startswith("/render/")
            ):
                await self._send_simple_response(writer, 404, "Not Found", b"Not Found")
                return

            query = parse_qs(parsed.query)
            if query.get("token", [""])[0] != self._token:
                await self._send_simple_response(writer, 403, "Forbidden", b"Forbidden")
                return

            if parsed.path.startswith("/render/"):
                render_id = unquote(parsed.path.removeprefix("/render/"))
                if RENDER_ID_RE.fullmatch(render_id) is None:
                    await self._send_simple_response(writer, 400, "Bad Request", b"Bad Request")
                    return

                render_path = self._render_index.get(render_id)
                if render_path is None or not render_path.exists():
                    await self._send_simple_response(writer, 404, "Not Found", b"Not Found")
                    return

                await self._send_static_file_response(
                    writer,
                    method=method,
                    path=render_path,
                    content_type="image/png",
                )
                return

            if not parsed.path.startswith("/pdf/"):
                await self._send_simple_response(writer, 404, "Not Found", b"Not Found")
                return

            pdf_id = unquote(parsed.path.removeprefix("/pdf/"))
            self._validate_pdf_id(pdf_id)
            path = self._file_index.get(pdf_id)
            if path is None:
                await self._send_simple_response(writer, 404, "Not Found", b"Not Found")
                return
            if path.suffix.lower() != ".pdf":
                await self._send_simple_response(writer, 400, "Bad Request", b"Bad Request")
                return

            await self._send_file_response(
                writer,
                method=method,
                path=path,
                range_header=headers.get("range"),
            )
        except Exception as error:
            self._log(
                "error",
                "HTTP request failed",
                {"error": str(error), "traceback": traceback.format_exc(limit=5)},
            )
            if not writer.is_closing():
                await self._send_simple_response(
                    writer, 500, "Internal Server Error", b"Internal Server Error"
                )
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _read_headers(self, reader: asyncio.StreamReader) -> dict[str, str]:
        headers: dict[str, str] = {}
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=5)
            if line in {b"\r\n", b"\n", b""}:
                break
            decoded = line.decode("iso-8859-1")
            if ":" not in decoded:
                continue
            key, value = decoded.split(":", 1)
            headers[key.strip().lower()] = value.strip()
        return headers

    async def _send_file_response(
        self,
        writer: asyncio.StreamWriter,
        method: str,
        path: Path,
        range_header: str | None,
    ) -> None:
        size = path.stat().st_size
        start = 0
        end = max(0, size - 1)
        status = 200
        reason = "OK"
        content_range = ""

        if range_header:
            parsed_range = self._parse_range(range_header, size)
            if parsed_range is None:
                await self._send_headers(
                    writer,
                    416,
                    "Range Not Satisfiable",
                    {
                        "Content-Length": "0",
                        "Content-Range": f"bytes */{size}",
                    },
                )
                return

            start, end = parsed_range
            status = 206
            reason = "Partial Content"
            content_range = f"bytes {start}-{end}/{size}"

        content_length = 0 if size == 0 else end - start + 1
        headers = {
            "Content-Type": "application/pdf",
            "Content-Length": str(content_length),
            "Accept-Ranges": "bytes",
        }
        if content_range:
            headers["Content-Range"] = content_range

        await self._send_headers(writer, status, reason, headers)
        if method == "HEAD" or content_length == 0:
            return

        with path.open("rb") as file_handle:
            file_handle.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk = file_handle.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                writer.write(chunk)
                remaining -= len(chunk)
                await writer.drain()

    async def _send_static_file_response(
        self,
        writer: asyncio.StreamWriter,
        method: str,
        path: Path,
        content_type: str,
    ) -> None:
        size = path.stat().st_size
        await self._send_headers(
            writer,
            200,
            "OK",
            {
                "Content-Type": content_type,
                "Content-Length": str(size),
                "Cache-Control": "no-store",
            },
        )
        if method == "HEAD" or size == 0:
            return

        with path.open("rb") as file_handle:
            while True:
                chunk = file_handle.read(64 * 1024)
                if not chunk:
                    break
                writer.write(chunk)
                await writer.drain()

    def _parse_range(self, range_header: str, size: int) -> tuple[int, int] | None:
        if size <= 0 or not range_header.startswith("bytes="):
            return None

        first_range = range_header[6:].split(",", 1)[0].strip()
        if "-" not in first_range:
            return None

        start_text, end_text = first_range.split("-", 1)
        try:
            if start_text == "":
                suffix_length = int(end_text)
                if suffix_length <= 0:
                    return None
                start = max(0, size - suffix_length)
                end = size - 1
            else:
                start = int(start_text)
                end = int(end_text) if end_text else size - 1
        except ValueError:
            return None

        if start < 0 or end < start or start >= size:
            return None
        return start, min(end, size - 1)

    async def _send_simple_response(
        self,
        writer: asyncio.StreamWriter,
        status: int,
        reason: str,
        body: bytes,
    ) -> None:
        await self._send_headers(
            writer,
            status,
            reason,
            {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Length": str(len(body)),
            },
        )
        if body:
            writer.write(body)
            await writer.drain()

    async def _send_headers(
        self,
        writer: asyncio.StreamWriter,
        status: int,
        reason: str,
        headers: dict[str, str],
    ) -> None:
        default_headers = {
            "Connection": "close",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
            "Access-Control-Allow-Headers": "Range,Content-Type",
            "Access-Control-Expose-Headers": "Accept-Ranges,Content-Range,Content-Length",
        }
        merged = {**default_headers, **headers}

        writer.write(f"HTTP/1.1 {status} {reason}\r\n".encode("ascii"))
        for key, value in merged.items():
            writer.write(f"{key}: {value}\r\n".encode("ascii"))
        writer.write(b"\r\n")
        await writer.drain()

    def _log(self, level: str, message: str, context: dict[str, Any] | None = None) -> None:
        normalized_level = str(level or "info").lower()
        payload = {
            "timestamp": utc_now(),
            "message": message,
            "context": context or {},
        }
        line = json.dumps(payload, sort_keys=True)
        logger = getattr(decky, "logger", None)
        if logger is not None:
            log_method = getattr(logger, normalized_level, getattr(logger, "info", None))
            if log_method is not None:
                log_method(line)
                return

        try:
            self.log_dir.mkdir(parents=True, exist_ok=True)
            with (self.log_dir / "plugin.log").open("a", encoding="utf-8") as file_handle:
                file_handle.write(line + "\n")
        except Exception:
            pass
