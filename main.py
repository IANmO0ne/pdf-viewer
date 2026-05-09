from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
import re
import secrets
import traceback
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse
from xml.etree import ElementTree

import decky


DEFAULT_PDF_FOLDER = os.environ.get(
    "PDF_VIEWER_DEFAULT_FOLDER", "/home/deck/Documents/PDF Seamdeck"
)
SETTINGS_FILE = "settings.json"
STATE_FILE = "state.json"
MIN_ZOOM = 0.5
MAX_ZOOM = 4.0
PDF_ID_RE = re.compile(r"^[a-f0-9]{64}$")
SUPPORTED_EXTENSIONS = {
    ".pdf": "pdf",
    ".epub": "epub",
    ".txt": "text",
    ".md": "text",
}
TEXT_SIZE_LIMIT_BYTES = 2 * 1024 * 1024


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


class Plugin:
    def __init__(self) -> None:
        self.settings_dir = Path(decky.DECKY_PLUGIN_SETTINGS_DIR)
        self.runtime_dir = Path(decky.DECKY_PLUGIN_RUNTIME_DIR)
        self.log_dir = Path(decky.DECKY_PLUGIN_LOG_DIR)
        self.settings_path = self.settings_dir / SETTINGS_FILE
        self.state_path = self.settings_dir / STATE_FILE

        self._settings: dict[str, Any] = default_settings()
        self._state: dict[str, Any] = {}
        self._file_index: dict[str, Path] = {}
        self._server: asyncio.AbstractServer | None = None
        self._server_port = 0
        self._token = secrets.token_urlsafe(32)
        self._lock: asyncio.Lock | None = None

    async def _main(self) -> None:
        self._lock = asyncio.Lock()
        self._ensure_plugin_dirs()
        self._settings = self._read_json(self.settings_path, default_settings())
        self._settings = self._sanitize_settings(self._settings)
        self._state = self._read_json(self.state_path, {})
        self._ensure_pdf_folder()
        await self._start_http_server()
        self._log("info", "PDF Viewer started", {"port": self._server_port})

    async def _unload(self) -> None:
        await self._stop_http_server()
        self._log("info", "PDF Viewer stopped")

    async def _uninstall(self) -> None:
        self._log("info", "PDF Viewer uninstall requested; user PDFs and settings kept")

    async def _migration(self) -> None:
        return None

    async def get_settings(self) -> dict[str, Any]:
        async with self._get_lock():
            self._settings = self._sanitize_settings(
                self._read_json(self.settings_path, self._settings)
            )
            return copy.deepcopy(self._settings)

    async def save_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        async with self._get_lock():
            merged = {**self._settings, **(settings or {})}
            self._settings = self._sanitize_settings(merged)
            self._ensure_pdf_folder()
            self._write_json(self.settings_path, self._settings)
            self._log("info", "Settings saved", {"pdfFolder": self._settings["pdfFolder"]})
            return copy.deepcopy(self._settings)

    async def list_pdfs(self) -> list[dict[str, Any]]:
        async with self._get_lock():
            entries = self._scan_supported_files()
            self._log("debug", "Library folder scanned", {"count": len(entries)})
            return entries

    async def get_pdf_access(self, pdf_id: str) -> dict[str, Any]:
        async with self._get_lock():
            self._validate_pdf_id(pdf_id)
            self._scan_supported_files()
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

    async def get_text_content(self, file_id: str) -> dict[str, Any]:
        async with self._get_lock():
            self._validate_pdf_id(file_id)
            self._scan_supported_files()
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
            self._validate_pdf_id(pdf_id)
            state = self._state_for(pdf_id)
            return copy.deepcopy(state)

    async def save_pdf_position(self, pdf_id: str, page: int, zoom: float) -> dict[str, Any]:
        async with self._get_lock():
            self._validate_pdf_id(pdf_id)
            state = self._state_for(pdf_id)
            state["lastPage"] = max(1, int(page))
            state["zoom"] = self._clamp_zoom(zoom)
            self._write_json(self.state_path, self._state)
            return copy.deepcopy(state)

    async def toggle_bookmark(self, pdf_id: str, page: int) -> dict[str, Any]:
        async with self._get_lock():
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
            self._validate_pdf_id(pdf_id)
            return copy.deepcopy(self._state_for(pdf_id)["bookmarks"])

    async def log_frontend_event(
        self, level: str, message: str, context: dict[str, Any] | None = None
    ) -> bool:
        self._log(level, message, context or {})
        return True

    async def get_log_info(self) -> dict[str, str]:
        return {
            "logFile": getattr(decky, "DECKY_PLUGIN_LOG", ""),
            "logDir": str(self.log_dir),
            "settingsFile": str(self.settings_path),
            "stateFile": str(self.state_path),
        }

    def _get_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

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
        folder = settings.get("pdfFolder")
        if isinstance(folder, str) and folder.strip():
            sanitized["pdfFolder"] = folder.strip()

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

    def _scan_supported_files(self) -> list[dict[str, Any]]:
        folder = Path(self._settings["pdfFolder"]).expanduser().resolve()
        folder.mkdir(parents=True, exist_ok=True)

        entries: list[dict[str, Any]] = []
        index: dict[str, Path] = {}

        try:
            children = list(folder.rglob("*"))
        except Exception as error:
            self._log(
                "error",
                "Unable to scan library folder",
                {"folder": str(folder), "error": str(error)},
            )
            raise

        for child in children:
            try:
                resolved = child.resolve()
                resolved.relative_to(folder)
                kind = self._kind_for_path(resolved)
                if not resolved.is_file() or kind is None:
                    continue

                stat = resolved.stat()
                pdf_id = self._pdf_id(resolved)
                index[pdf_id] = resolved
                relative_path = resolved.relative_to(folder).as_posix()
                entries.append(
                    {
                        "id": pdf_id,
                        "kind": kind,
                        "name": resolved.name,
                        "relativePath": relative_path,
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
        self._file_index = index
        return entries

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
        try:
            root = ElementTree.fromstring(raw)
            chunks = [
                text.strip()
                for text in root.itertext()
                if text and text.strip()
            ]
            return "\n".join(chunks)
        except ElementTree.ParseError:
            decoded = raw.decode("utf-8", errors="replace")
            stripped = re.sub(r"<(script|style).*?</\1>", "", decoded, flags=re.I | re.S)
            stripped = re.sub(r"<[^>]+>", "\n", stripped)
            stripped = re.sub(r"\n{3,}", "\n\n", stripped)
            return stripped.strip()

    def _pdf_id(self, path: Path) -> str:
        normalized_path = str(path.resolve())
        return hashlib.sha256(normalized_path.encode("utf-8")).hexdigest()

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
            if not parsed.path.startswith("/pdf/"):
                await self._send_simple_response(writer, 404, "Not Found", b"Not Found")
                return

            query = parse_qs(parsed.query)
            if query.get("token", [""])[0] != self._token:
                await self._send_simple_response(writer, 403, "Forbidden", b"Forbidden")
                return

            pdf_id = unquote(parsed.path.removeprefix("/pdf/"))
            self._validate_pdf_id(pdf_id)
            self._scan_supported_files()
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
        logger = decky.logger
        log_method = getattr(logger, normalized_level, logger.info)
        log_method(line)
