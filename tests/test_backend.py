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


def test_diagnostics_count_common_folder_with_files(plugin_module):
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
    assert any(
        Path(candidate["folder"]).name == "PDF Steamdeck" and candidate["supportedCount"] == 1
        for candidate in diagnostics["candidates"]
    )


def test_diagnostics_count_documents_child_folder_with_files(plugin_module):
    module, _logger = plugin_module
    plugin = module.Plugin()

    async def exercise():
        default_folder = Path(module.DEFAULT_PDF_FOLDER)
        arbitrary_folder = default_folder.parent / "Guides I Copied"
        arbitrary_folder.mkdir(parents=True)
        (arbitrary_folder / "walkthrough.txt").write_text("Use the key.", encoding="utf-8")

        await plugin._main()
        diagnostics = await plugin.get_library_diagnostics()
        await plugin._unload()
        return diagnostics

    diagnostics = run(exercise())
    assert any(
        Path(candidate["folder"]).name == "Guides I Copied"
        and candidate["supportedCount"] == 1
        for candidate in diagnostics["candidates"]
    )


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
