# Migration Notes

This project replaces the earlier `IANmO0ne/pdf-viewer` prototype while keeping the same GitHub repository identity.

## What Changed

- The old prototype loaded entire PDF files as base64 strings through Decky RPC. That path is simple, but it is slow and memory-heavy for large strategy guides.
- The new backend serves approved PDFs over a local `127.0.0.1` HTTP endpoint with token protection and HTTP Range support, so PDF.js can request only the data it needs.
- The old infinite-scroll mode rendered many pages into the Decky side panel at once. V1 now renders one page at a time to keep memory and frame time bounded in Gaming Mode.
- The old `react-pdf` dependency is not used. The new frontend talks to `pdfjs-dist` directly, which avoids the heavier dependency chain and native `canvas` install trouble seen on Windows.
- The default PDF folder is now `/home/deck/Documents/PDF Seamdeck` instead of a plugin runtime directory, making guides easier to manage from Steam Deck Desktop Mode.
- The library scan is now recursive and includes PDF, EPUB, TXT, and Markdown files. EPUB/TXT support uses a lightweight readable text view for v1.

## What Was Preserved

- The plugin remains a Decky Quick Access Menu reader named `PDF Viewer`.
- The useful worker-fallback idea from the prototype is documented as a future fallback if Steam Deck testing shows `dist/pdf.worker.min.mjs` cannot be loaded reliably.
- The resume behavior was expanded from one global last page to per-PDF last page, zoom, and bookmarks.
