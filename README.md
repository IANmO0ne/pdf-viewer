# PDF Viewer for Decky Loader

PDF Viewer is a Decky Loader plugin for reading strategy guides from the Steam Deck Quick Access Menu while a game is running.

Repository: https://github.com/IANmO0ne/pdf-viewer

## V1 Features

- Lists `.pdf`, `.epub`, `.txt`, and `.md` files directly from `/home/deck/Documents/PDF Steamdeck`
- Keeps a legacy fallback for `/home/deck/Documents/PDF Seamdeck` so early test installs do not lose their library after updating
- Uses bounded, non-recursive folder scans so a large or unreadable directory cannot leave the Decky panel stuck on loading forever
- Filters the file list by name or type
- Keeps backend diagnostics available through logs and status calls without cluttering the normal reader UI
- Starts the backend in safe mode with no filesystem or HTTP-server work until the reader needs it
- Opens one PDF page at a time for predictable Steam Deck overlay performance
- Opens EPUB and text files in a lightweight readable text view
- Supports page back/forward, home, zoom in/out up to 800%, panning, bookmarks, and bookmark navigation
- Shows a table of contents for PDFs with document outlines, plus page jump controls for PDFs without outlines
- Adds a native Poppler/MuPDF page-render fallback for PDFs that show square glyph blocks in PDF.js
- Shows clear warnings for password-protected, malformed, or previously failed files
- Reopens the last active file after the Quick Access Menu closes; pressing Home clears that active file
- Includes a clear zoom button step setting so users can choose how much the zoom buttons move at high zoom levels
- Remembers the last page and zoom per PDF
- Stores settings and state in Decky's plugin settings directory
- Logs backend and frontend errors with timestamps through Decky's plugin logger
- Serves PDFs locally from `127.0.0.1` with token-protected URLs and HTTP Range support for PDF.js

## Steam Deck Install For Testing

1. Put your guides in `/home/deck/Documents/PDF Steamdeck`.
   Files must be directly inside this folder for the current build. Subfolder scanning is disabled to keep refreshes quick in Gaming Mode.
   The old test folder `/home/deck/Documents/PDF Seamdeck` is still scanned as a fallback, but new installs should use `PDF Steamdeck`.
2. Build the plugin from this repository:

   ```sh
   corepack prepare pnpm@9.15.9 --activate
   corepack pnpm install
   corepack pnpm run package
   ```

3. Copy `out/decky-pdf-viewer.zip` to your Steam Deck.
4. Enable Decky Loader developer mode and install the zip as a local plugin.
5. Open the Quick Access Menu, choose `PDF Viewer`, refresh the PDF list, and select a guide.

If Decky still shows a `Failed to fetch dynamically imported module` error after installing a new zip, uninstall the old local plugin first or remove stale plugin folders from `/home/deck/homebrew/plugins/`, then reinstall the current zip and reboot Gaming Mode.

If a PDF page opens but text appears as square blocks, open the settings gear while viewing that PDF and turn on `Native page render`. This uses a SteamOS system renderer when available. It is slower than the normal renderer, but it can handle PDFs whose embedded font mappings confuse PDF.js.

The GitHub release flow is the intended publish path once Steam Deck testing confirms the plugin behaves well in Gaming Mode. Upload `out/decky-pdf-viewer.zip` to a release, then download and install that zip on the Deck.

The test zip intentionally omits source maps and extra docs so Decky's local installer has less work to parse in Gaming Mode.

### Direct Copy Notes

For early testing, the release zip is safer than copying raw source because it matches Decky's distribution layout. If direct SSH deployment is added later, it should copy the packaged plugin directory from `out/decky-pdf-viewer/` into `/home/deck/homebrew/plugins/decky-pdf-viewer`.

## Development

```sh
corepack prepare pnpm@9.15.9 --activate
corepack pnpm install
corepack pnpm run check
corepack pnpm run build
python -m pytest
```

If `pytest` is not installed on the development machine, run:

```sh
python -m pip install -r requirements-dev.txt
```

The plugin intentionally ships with single-page PDF rendering. Continuous scroll and search are future features because large strategy guides can be expensive to render inside the Decky side panel.

If Decky cannot load `dist/pdf.worker.min.js` on the Steam Deck, the previous project's blob-worker approach can be added as a fallback. That is intentionally deferred until real Deck testing shows it is needed.

## Logs And State

Decky provides the runtime paths at plugin launch:

- Settings: `DECKY_PLUGIN_SETTINGS_DIR/settings.json`
- Per-PDF state: `DECKY_PLUGIN_SETTINGS_DIR/state.json`
- Logs: `DECKY_PLUGIN_LOG`

For bug reports, include the Decky plugin log and the name of the file that failed.
