from __future__ import annotations

import asyncio
import importlib
import sys
import types
from pathlib import Path
from urllib.parse import urlparse

import pytest


class FakeLogger:
    def __init__(self) -> None:
        self.records: list[tuple[str, str]] = []

    def debug(self, message: str) -> None:
        self.records.append(("debug", message))

    def info(self, message: str) -> None:
        self.records.append(("info", message))

    def warning(self, message: str) -> None:
        self.records.append(("warning", message))

    def error(self, message: str) -> None:
        self.records.append(("error", message))


@pytest.fixture()
def plugin_module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    logger = FakeLogger()
    fake_decky = types.SimpleNamespace(
        DECKY_PLUGIN_SETTINGS_DIR=str(tmp_path / "settings"),
        DECKY_PLUGIN_RUNTIME_DIR=str(tmp_path / "runtime"),
        DECKY_PLUGIN_LOG_DIR=str(tmp_path / "logs"),
        DECKY_PLUGIN_LOG=str(tmp_path / "logs" / "plugin.log"),
        logger=logger,
    )

    monkeypatch.setitem(sys.modules, "decky", fake_decky)
    monkeypatch.setenv("PDF_VIEWER_DEFAULT_FOLDER", str(tmp_path / "PDF Seamdeck"))
    sys.modules.pop("main", None)

    root = Path(__file__).resolve().parents[1]
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    module = importlib.import_module("main")
    return module, logger


def run(coro):
    return asyncio.run(coro)


def test_default_folder_is_created_and_supported_listing_is_fast_non_recursive(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        settings = await plugin.get_settings()
        pdf_folder = Path(settings["pdfFolder"])
        assert pdf_folder.exists()

        (pdf_folder / "guide.PDF").write_bytes(b"%PDF-1.7\n")
        (pdf_folder / "notes.txt").write_text("ignore me", encoding="utf-8")
        (pdf_folder / "nested").mkdir()
        (pdf_folder / "nested" / "nested.pdf").write_bytes(b"%PDF-1.7\n")
        (pdf_folder / "nested" / "book.epub").write_bytes(
            b"PK\x05\x06" + (b"\x00" * 18)
        )
        (pdf_folder / "image.png").write_bytes(b"not supported")

        entries = await plugin.list_pdfs()
        await plugin._unload()
        return entries

    entries = run(exercise())
    assert [entry["relativePath"] for entry in entries] == [
        "guide.PDF",
        "notes.txt",
    ]
    assert [entry["kind"] for entry in entries] == ["pdf", "text"]
    assert entries[0]["id"]
    assert entries[0]["sizeBytes"] > 0


def test_diagnostics_only_reports_default_folder(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()

    async def exercise():
        default_folder = Path(module.DEFAULT_PDF_FOLDER)
        alternate_folder = default_folder.parent / "PDF Steamdeck"
        alternate_folder.mkdir(parents=True)
        (alternate_folder / "guide.pdf").write_bytes(b"%PDF-1.7\n")

        await plugin._main()
        settings = await plugin.get_settings()
        diagnostics = await plugin.get_library_diagnostics()
        await plugin._unload()
        return settings, diagnostics

    settings, diagnostics = run(exercise())
    assert Path(settings["pdfFolder"]).name == "PDF Seamdeck"
    assert diagnostics["activeFolder"] == settings["pdfFolder"]
    assert [Path(candidate["folder"]).name for candidate in diagnostics["candidates"]] == [
        "PDF Seamdeck"
    ]


def test_settings_always_use_default_pdf_folder(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        settings = await plugin.save_settings({"pdfFolder": "/tmp/other-folder"})
        await plugin._unload()
        return settings

    settings = run(exercise())
    assert settings["pdfFolder"] == module.DEFAULT_PDF_FOLDER


def test_debug_info_reports_last_scan_and_folder_probe(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        pdf_folder = Path((await plugin.get_settings())["pdfFolder"])
        (pdf_folder / "walkthrough.txt").write_text("Use the key.", encoding="utf-8")
        entries = await plugin.list_pdfs()
        debug_info = await plugin.get_debug_info()
        await plugin._unload()
        return entries, debug_info

    entries, debug_info = run(exercise())
    assert [entry["name"] for entry in entries] == ["walkthrough.txt"]
    assert debug_info["version"] == module.PLUGIN_VERSION
    assert debug_info["lastScan"]["status"] == "ok"
    assert debug_info["lastScan"]["count"] == 1
    assert debug_info["probe"]["exists"] is True
    assert any(entry["name"] == "walkthrough.txt" for entry in debug_info["probe"]["entries"])


def test_plugin_status_has_version_without_filesystem_probe(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        status = await plugin.get_plugin_status()
        default_folder_exists = Path(module.DEFAULT_PDF_FOLDER).exists()
        await plugin._unload()
        return status, default_folder_exists

    status, default_folder_exists = run(exercise())
    assert status["version"] == module.PLUGIN_VERSION
    assert "lastScan" not in status
    assert default_folder_exists is False


def test_backend_initializes_from_environment_when_decky_constants_are_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    logger = FakeLogger()
    fake_decky = types.SimpleNamespace(logger=logger)

    monkeypatch.setitem(sys.modules, "decky", fake_decky)
    monkeypatch.setenv("DECKY_PLUGIN_SETTINGS_DIR", str(tmp_path / "settings-from-env"))
    monkeypatch.setenv("DECKY_PLUGIN_RUNTIME_DIR", str(tmp_path / "runtime-from-env"))
    monkeypatch.setenv("DECKY_PLUGIN_LOG_DIR", str(tmp_path / "logs-from-env"))
    monkeypatch.setenv("PDF_VIEWER_DEFAULT_FOLDER", str(tmp_path / "PDF Seamdeck"))
    sys.modules.pop("main", None)

    root = Path(__file__).resolve().parents[1]
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    module = importlib.import_module("main")
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        status = await plugin.get_plugin_status()
        await plugin._unload()
        return status

    status = run(exercise())
    assert status["version"] == module.PLUGIN_VERSION
    assert plugin.settings_dir == tmp_path / "settings-from-env"


def test_settings_status_loads_settings_without_creating_pdf_folder(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        status = await plugin.get_settings_status()
        default_folder_exists = Path(module.DEFAULT_PDF_FOLDER).exists()
        await plugin._unload()
        return status, default_folder_exists

    status, default_folder_exists = run(exercise())
    assert status["ok"] is True
    assert status["version"] == module.PLUGIN_VERSION
    assert status["settingsExists"] is True
    assert Path(status["settingsFile"]).exists()
    assert default_folder_exists is False


def test_folder_probe_reads_default_folder_without_settings_load(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()
    folder = Path(module.DEFAULT_PDF_FOLDER)
    folder.mkdir(parents=True)
    (folder / "guide.pdf").write_bytes(b"%PDF-1.7\n")
    (folder / "cover.png").write_bytes(b"not supported")

    async def exercise():
        await plugin._main()
        probe = await plugin.get_folder_probe()
        await plugin._unload()
        return probe

    probe = run(exercise())
    assert probe["version"] == module.PLUGIN_VERSION
    assert probe["folder"] == str(folder.absolute())
    assert probe["probe"]["exists"] is True
    assert probe["probe"]["isDir"] is True
    assert any(entry["name"] == "guide.pdf" for entry in probe["probe"]["entries"])


def test_text_content_loads_for_text_files(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        pdf_folder = Path((await plugin.get_settings())["pdfFolder"])
        (pdf_folder / "walkthrough.txt").write_text("Chapter 1\nGo north.", encoding="utf-8")
        entry = (await plugin.list_pdfs())[0]
        content = await plugin.get_text_content(entry["id"])
        await plugin._unload()
        return content

    content = run(exercise())
    assert content["kind"] == "text"
    assert "Go north" in content["text"]


def test_epub_content_extracts_readable_text(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        pdf_folder = Path((await plugin.get_settings())["pdfFolder"])
        epub_path = pdf_folder / "guide.epub"
        with __import__("zipfile").ZipFile(epub_path, "w") as archive:
            archive.writestr(
                "OPS/chapter1.xhtml",
                "<html><body><h1>Start</h1><p>Open the chest.</p></body></html>",
            )
        entry = (await plugin.list_pdfs())[0]
        content = await plugin.get_text_content(entry["id"])
        await plugin._unload()
        return content

    content = run(exercise())
    assert content["kind"] == "epub"
    assert "Open the chest" in content["text"]


def test_bookmarks_and_positions_are_isolated_by_pdf(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        pdf_folder = Path((await plugin.get_settings())["pdfFolder"])
        (pdf_folder / "one.pdf").write_bytes(b"%PDF one\n")
        (pdf_folder / "three.pdf").write_bytes(b"%PDF three\n")

        entries = await plugin.list_pdfs()
        one = next(entry for entry in entries if entry["name"] == "one.pdf")
        three = next(entry for entry in entries if entry["name"] == "three.pdf")

        await plugin.save_pdf_position(one["id"], 42, 1.5)
        await plugin.toggle_bookmark(one["id"], 42)
        await plugin.save_pdf_position(three["id"], 52, 2.0)
        await plugin.toggle_bookmark(three["id"], 52)

        one_state = await plugin.get_pdf_state(one["id"])
        three_state = await plugin.get_pdf_state(three["id"])
        await plugin._unload()
        return one_state, three_state

    one_state, three_state = run(exercise())
    assert one_state["lastPage"] == 42
    assert one_state["zoom"] == 1.5
    assert [bookmark["page"] for bookmark in one_state["bookmarks"]] == [42]
    assert three_state["lastPage"] == 52
    assert three_state["zoom"] == 2.0
    assert [bookmark["page"] for bookmark in three_state["bookmarks"]] == [52]


def test_corrupt_state_json_recovers_with_timestamped_log(plugin_module):
    module, logger = plugin_module
    settings_dir = Path(module.decky.DECKY_PLUGIN_SETTINGS_DIR)
    settings_dir.mkdir(parents=True)
    (settings_dir / module.STATE_FILE).write_text("{not json", encoding="utf-8")
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        pdf_folder = Path((await plugin.get_settings())["pdfFolder"])
        (pdf_folder / "guide.pdf").write_bytes(b"%PDF\n")
        entry = (await plugin.list_pdfs())[0]
        state = await plugin.get_pdf_state(entry["id"])
        await plugin._unload()
        return state

    state = run(exercise())
    assert state["lastPage"] == 1
    assert state["bookmarks"] == []
    assert any("timestamp" in record for _level, record in logger.records)
    assert any("JSON file could not be read" in record for _level, record in logger.records)


def test_invalid_pdf_id_is_rejected(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        with pytest.raises(ValueError):
            await plugin.get_pdf_access("../secret")
        await plugin._unload()

    run(exercise())


def test_http_range_response_serves_partial_pdf(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()
    pdf_bytes = b"%PDF-1.7\n0123456789abcdef\n%%EOF"

    async def exercise():
        await plugin._main()
        pdf_folder = Path((await plugin.get_settings())["pdfFolder"])
        (pdf_folder / "range.pdf").write_bytes(pdf_bytes)
        entry = (await plugin.list_pdfs())[0]
        access = await plugin.get_pdf_access(entry["id"])
        parsed = urlparse(access["url"])

        reader, writer = await asyncio.open_connection(parsed.hostname, parsed.port)
        request = (
            f"GET {parsed.path}?{parsed.query} HTTP/1.1\r\n"
            f"Host: {parsed.hostname}\r\n"
            "Range: bytes=0-7\r\n"
            "Connection: close\r\n"
            "\r\n"
        )
        writer.write(request.encode("ascii"))
        await writer.drain()
        response = await reader.read()
        writer.close()
        await writer.wait_closed()
        await plugin._unload()
        return response

    response = run(exercise())
    header, body = response.split(b"\r\n\r\n", 1)
    assert b"206 Partial Content" in header
    assert b"Content-Range: bytes 0-7/" in header
    assert body == pdf_bytes[:8]


def test_native_renderer_status_reports_unavailable(plugin_module, monkeypatch):
    module, _logger = plugin_module
    monkeypatch.setattr(module.shutil, "which", lambda _name: None)
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        status = await plugin.get_native_render_status()
        await plugin._unload()
        return status

    status = run(exercise())
    assert status["available"] is False
    assert status["renderer"] == ""
    assert "not found" in status["message"].lower()


def test_native_page_render_requires_renderer(plugin_module, monkeypatch):
    module, _logger = plugin_module
    monkeypatch.setattr(module.shutil, "which", lambda _name: None)
    plugin = module.Plugin()

    async def exercise():
        await plugin._main()
        pdf_folder = Path((await plugin.get_settings())["pdfFolder"])
        (pdf_folder / "native.pdf").write_bytes(b"%PDF-1.7\n")
        entry = (await plugin.list_pdfs())[0]
        with pytest.raises(RuntimeError):
            await plugin.get_native_page_render(entry["id"], 1, 400)
        await plugin._unload()

    run(exercise())


def test_http_render_response_serves_native_png(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()
    render_id = "a" * 64
    png_bytes = b"\x89PNG\r\n\x1a\nfake"

    async def exercise():
        await plugin._main()
        await plugin._start_http_server()
        render_path = plugin.runtime_dir / "native-render" / f"{render_id}.png"
        render_path.parent.mkdir(parents=True)
        render_path.write_bytes(png_bytes)
        plugin._render_index[render_id] = render_path

        reader, writer = await asyncio.open_connection("127.0.0.1", plugin._server_port)
        request = (
            f"GET /render/{render_id}?token={plugin._token} HTTP/1.1\r\n"
            "Host: 127.0.0.1\r\n"
            "Connection: close\r\n"
            "\r\n"
        )
        writer.write(request.encode("ascii"))
        await writer.drain()
        response = await reader.read()
        writer.close()
        await writer.wait_closed()
        await plugin._unload()
        return response

    response = run(exercise())
    header, body = response.split(b"\r\n\r\n", 1)
    assert b"200 OK" in header
    assert b"Content-Type: image/png" in header
    assert body == png_bytes
