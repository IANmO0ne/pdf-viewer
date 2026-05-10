# PDF Viewer for Decky Loader

PDF Viewer is a Decky Loader plugin for reading strategy guides from the Steam Deck Quick Access Menu while a game is running.

Repository: https://github.com/IANmO0ne/pdf-viewer

## V1 Features

- Lists `.pdf`, `.epub`, `.txt`, and `.md` files directly from `/home/deck/Documents/PDF Seamdeck`
- Shows quick diagnostics for common alternate folder names and guide folders under `/home/deck/Documents` when the configured folder is empty
- Uses bounded, non-recursive folder scans so a large or unreadable directory cannot leave the Decky panel stuck on loading forever
- Shows a Debug panel after scan failures with the active folder, last backend scan status, and a quick folder probe
- Shows the installed build version and a folder probe before any library scan starts, which helps confirm whether Decky installed the newest zip
- Provides separate backend-only, folder-only, and library-refresh checks to isolate Decky RPC problems from filesystem problems
- Starts the backend in safe mode with no filesystem or HTTP-server work until a specific button needs it
- Opens one PDF page at a time for predictable Steam Deck overlay performance
- Opens EPUB and text files in a lightweight readable text view
- Supports page back/forward, home, zoom in/out, panning, bookmarks, and bookmark navigation
- Remembers the last page and zoom per PDF
- Stores settings and state in Decky's plugin settings directory
- Logs backend and frontend errors with timestamps through Decky's plugin logger
- Serves PDFs locally from `127.0.0.1` with token-protected URLs and HTTP Range support for PDF.js

## Steam Deck Install For Testing

1. Put your guides in `/home/deck/Documents/PDF Seamdeck`.
   Files must be directly inside this folder for the current troubleshooting build. Subfolder scanning is temporarily disabled until the Steam Deck scan timeout is resolved.
   If you already made a similar folder such as `/home/deck/Documents/PDF Steamdeck`, the empty-library screen shows which folders were checked and how many supported files were found.
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

The settings view inside the plugin shows the active log path so test failures can be copied back into an issue.
