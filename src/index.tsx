import {
  Button,
  ButtonItem,
  DropdownItem,
  Focusable,
  PanelSection,
  PanelSectionRow,
  SliderField,
  staticClasses
} from "@decky/ui";
import { callable, definePlugin, toaster } from "@decky/api";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FaArrowLeft,
  FaArrowRight,
  FaBookmark,
  FaCog,
  FaFileAlt,
  FaBookOpen,
  FaFilePdf,
  FaHome,
  FaListUl,
  FaRegBookmark,
  FaSearchMinus,
  FaSearchPlus,
  FaSyncAlt
} from "react-icons/fa";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

type ViewMode = "single";
type FitMode = "width";

interface Settings {
  pdfFolder: string;
  viewMode: ViewMode;
  fitMode: FitMode;
  zoomStep: number;
}

type LibraryKind = "pdf" | "epub" | "text";

interface PdfEntry {
  id: string;
  kind: LibraryKind;
  name: string;
  relativePath: string;
  sizeBytes: number;
  modifiedTime: string;
}

interface PdfAccess {
  id: string;
  url: string;
  sizeBytes: number;
}

interface Bookmark {
  page: number;
  createdAt: string;
}

interface PdfState {
  lastPage: number;
  zoom: number;
  bookmarks: Bookmark[];
}

interface BookmarkToggleResult {
  bookmarked: boolean;
  bookmarks: Bookmark[];
}

interface TextContent {
  id: string;
  kind: LibraryKind;
  name: string;
  text: string;
}

interface LibraryCandidate {
  folder: string;
  exists: boolean;
  supportedCount: number;
}

interface LibraryDiagnostics {
  activeFolder: string;
  activeExists: boolean;
  supportedExtensions: string[];
  candidates: LibraryCandidate[];
}

interface DebugEntry {
  name: string;
  isFile?: boolean;
  isDir?: boolean;
  suffix?: string;
  kind?: LibraryKind | null;
  error?: string;
}

interface DebugInfo {
  version: string;
  timestamp: string;
  settingsFolder: string;
  activeFolder: string;
  supportedExtensions: string[];
  lastScan: {
    status: string;
    folder: string;
    count: number;
    elapsedMs: number;
    error: string;
  };
  probe: {
    status: string;
    exists?: boolean;
    isDir?: boolean;
    error?: string;
    entries: DebugEntry[];
  };
}

interface PdfViewport {
  width: number;
  height: number;
}

interface PdfRenderTask {
  promise: Promise<void>;
  cancel: () => void;
}

interface PdfPageProxy {
  getViewport: (options: { scale: number }) => PdfViewport;
  render: (options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
  }) => PdfRenderTask;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageProxy>;
  destroy?: () => Promise<void>;
}

const getSettings = callable<[], Settings>("get_settings");
const saveSettings = callable<[settings: Partial<Settings>], Settings>("save_settings");
const listPdfs = callable<[], PdfEntry[]>("list_pdfs");
const getPdfAccess = callable<[pdfId: string], PdfAccess>("get_pdf_access");
const getTextContent = callable<[fileId: string], TextContent>("get_text_content");
const getPdfState = callable<[pdfId: string], PdfState>("get_pdf_state");
const savePdfPosition = callable<
  [pdfId: string, page: number, zoom: number],
  PdfState
>("save_pdf_position");
const toggleBookmark = callable<
  [pdfId: string, page: number],
  BookmarkToggleResult
>("toggle_bookmark");
const logFrontendEvent = callable<
  [level: string, message: string, context?: Record<string, unknown>],
  boolean
>("log_frontend_event");
const getLogInfo = callable<
  [],
  { logFile: string; logDir: string; settingsFile: string; stateFile: string }
>("get_log_info");
const getLibraryDiagnostics = callable<[], LibraryDiagnostics>(
  "get_library_diagnostics"
);
const getDebugInfo = callable<[], DebugInfo>("get_debug_info");

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const MAX_CANVAS_PIXELS = 4_000_000;
const DEFAULT_SETTINGS: Settings = {
  pdfFolder: "/home/deck/Documents/PDF Seamdeck",
  viewMode: "single",
  fitMode: "width",
  zoomStep: 0.25
};

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "./pdf.worker.min.js",
  import.meta.url
).toString();

const styles = {
  shell: {
    display: "flex",
    flexDirection: "column",
    gap: "8px"
  },
  toolbar: {
    display: "grid",
    gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
    gap: "6px",
    alignItems: "center"
  },
  iconButton: {
    minWidth: 0,
    minHeight: "34px",
    padding: "6px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  },
  pageMeta: {
    color: "rgba(255, 255, 255, 0.78)",
    fontSize: "12px",
    lineHeight: "16px",
    display: "flex",
    justifyContent: "space-between",
    gap: "8px"
  },
  viewerFrame: {
    border: "1px solid rgba(255, 255, 255, 0.12)",
    borderRadius: "6px",
    background: "#1b1d22",
    minHeight: "420px",
    maxHeight: "620px",
    overflow: "auto",
    overscrollBehavior: "contain",
    touchAction: "pan-x pan-y",
    padding: "6px"
  },
  canvas: {
    display: "block",
    margin: "0 auto",
    background: "#f4f1e8",
    boxShadow: "0 2px 10px rgba(0, 0, 0, 0.35)"
  },
  empty: {
    minHeight: "220px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    color: "rgba(255, 255, 255, 0.72)",
    padding: "16px",
    lineHeight: "20px"
  },
  error: {
    border: "1px solid rgba(255, 93, 93, 0.42)",
    color: "#ffd6d6",
    background: "rgba(120, 24, 24, 0.34)",
    borderRadius: "6px",
    padding: "8px",
    fontSize: "12px",
    lineHeight: "16px"
  },
  bookmarkList: {
    display: "flex",
    flexDirection: "column",
    gap: "6px"
  },
  fileList: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxHeight: "420px",
    overflowY: "auto",
    paddingRight: "4px"
  },
  textViewer: {
    border: "1px solid rgba(255, 255, 255, 0.12)",
    borderRadius: "6px",
    background: "#f2efe7",
    color: "#17191d",
    minHeight: "420px",
    maxHeight: "620px",
    overflow: "auto",
    padding: "12px",
    whiteSpace: "pre-wrap",
    fontSize: "14px",
    lineHeight: "20px"
  },
  smallText: {
    color: "rgba(255, 255, 255, 0.68)",
    fontSize: "12px",
    lineHeight: "16px",
    overflowWrap: "anywhere"
  }
} satisfies Record<string, CSSProperties>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString();
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;
  const guardedPromise = promise.finally(() => {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  });

  guardedPromise.catch(() => undefined);

  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([guardedPromise, timeoutPromise]);
}

function fileIcon(kind: LibraryKind) {
  if (kind === "pdf") {
    return <FaFilePdf />;
  }
  if (kind === "epub") {
    return <FaBookOpen />;
  }
  return <FaFileAlt />;
}

function fileKindLabel(kind: LibraryKind): string {
  if (kind === "pdf") {
    return "PDF";
  }
  if (kind === "epub") {
    return "EPUB";
  }
  return "Text";
}

function IconButton(props: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      disabled={props.disabled}
      onClick={() => props.onClick()}
      style={styles.iconButton}
    >
      <span aria-hidden="true">{props.icon}</span>
      <span style={{ display: "none" }}>{props.label}</span>
    </Button>
  );
}

function Content() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [pdfs, setPdfs] = useState<PdfEntry[]>([]);
  const [selectedPdf, setSelectedPdf] = useState<PdfEntry | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfDocumentProxy | null>(null);
  const [textContent, setTextContent] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [busyMessage, setBusyMessage] = useState("Loading PDF folder...");
  const [errorMessage, setErrorMessage] = useState("");
  const [renderMessage, setRenderMessage] = useState("");
  const [logPath, setLogPath] = useState("");
  const [diagnostics, setDiagnostics] = useState<LibraryDiagnostics | null>(null);
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const activeRenderRef = useRef<PdfRenderTask | null>(null);

  const reportError = useCallback(
    async (
      message: string,
      error: unknown,
      context: Record<string, unknown> = {}
    ) => {
      const detail = describeError(error);
      const composed = `${message}: ${detail}`;
      console.error("[PDF Viewer]", composed, context);
      setErrorMessage(composed);
      toaster.toast({ title: "PDF Viewer", body: message });
      await logFrontendEvent("error", message, { ...context, error: detail }).catch(
        () => undefined
      );
    },
    []
  );

  const checkFolder = useCallback(async () => {
    setBusyMessage("Checking PDF folder...");
    setErrorMessage("");

    try {
      const [loadedSettings, loadedLogInfo, loadedDebugInfo] = await Promise.all([
        getSettings(),
        getLogInfo(),
        withTimeout(getDebugInfo(), 3_000, "Debug snapshot took longer than 3 seconds")
      ]);
      setSettings(loadedSettings);
      setLogPath(loadedLogInfo.logFile || loadedLogInfo.logDir);
      setDebugInfo(loadedDebugInfo);
      setBusyMessage("");
    } catch (error) {
      setBusyMessage("");
      await reportError("Unable to check the PDF folder", error);
    }
  }, [reportError]);

  const refreshLibrary = useCallback(async () => {
    setBusyMessage("Loading PDF folder...");
    setErrorMessage("");

    try {
      const loadedPdfs = await withTimeout(
        listPdfs(),
        8_000,
        "Library scan took longer than 8 seconds"
      );
      const [loadedSettings, loadedLogInfo] = await Promise.all([
        getSettings(),
        getLogInfo()
      ]);
      const loadedDiagnostics =
        loadedPdfs.length === 0
          ? await withTimeout(
              getLibraryDiagnostics(),
              3_000,
              "Library diagnostics took longer than 3 seconds"
            ).catch(() => null)
          : null;
      setSettings(loadedSettings);
      setPdfs(loadedPdfs);
      setLogPath(loadedLogInfo.logFile || loadedLogInfo.logDir);
      setDiagnostics(loadedDiagnostics);
      setBusyMessage("");

      if (selectedPdf && !loadedPdfs.some((pdf) => pdf.id === selectedPdf.id)) {
        setSelectedPdf(null);
      }
    } catch (error) {
      setBusyMessage("");
      const info = await withTimeout(
        getDebugInfo(),
        3_000,
        "Debug snapshot took longer than 3 seconds"
      ).catch(() => null);
      setDebugInfo(info);
      await reportError("Unable to load the PDF folder", error);
    }
  }, [reportError, selectedPdf]);

  useEffect(() => {
    void checkFolder();
  }, [checkFolder]);

  useEffect(() => {
    if (!selectedPdf) {
      setPdfDoc(null);
      setTextContent("");
      setPageCount(0);
      setPageNumber(1);
      setBookmarks([]);
      setRenderMessage("");
      return () => undefined;
    }

    let cancelled = false;
    let openedDoc: PdfDocumentProxy | null = null;

    const openSelectedFile = async () => {
      setBusyMessage(`Opening ${selectedPdf.name}...`);
      setErrorMessage("");
      setRenderMessage("");
      setPdfDoc(null);
      setTextContent("");
      setBookmarks([]);

      try {
        if (selectedPdf.kind !== "pdf") {
          const content = await withTimeout(
            getTextContent(selectedPdf.id),
            10_000,
            "Text loading took longer than 10 seconds"
          );
          if (cancelled) {
            return;
          }
          setTextContent(content.text);
          setPageCount(0);
          setPageNumber(1);
          setZoom(1);
          setBookmarks([]);
          setBusyMessage("");
          return;
        }

        const [access, state] = await Promise.all([
          withTimeout(
            getPdfAccess(selectedPdf.id),
            10_000,
            "PDF access request took longer than 10 seconds"
          ),
          getPdfState(selectedPdf.id)
        ]);
        const loadingTask = pdfjsLib.getDocument({
          url: access.url,
          withCredentials: false,
          rangeChunkSize: 65536,
          disableAutoFetch: true,
          disableStream: false
        });
        let doc: PdfDocumentProxy;
        try {
          doc = (await withTimeout(
            loadingTask.promise as Promise<PdfDocumentProxy>,
            20_000,
            "PDF loading took longer than 20 seconds"
          )) as PdfDocumentProxy;
        } catch (error) {
          await loadingTask.destroy?.().catch(() => undefined);
          throw error;
        }

        if (cancelled) {
          await doc.destroy?.();
          return;
        }

        openedDoc = doc;
        const safePage = clamp(Math.trunc(state.lastPage || 1), 1, doc.numPages);
        setPdfDoc(doc);
        setPageCount(doc.numPages);
        setPageNumber(safePage);
        setZoom(clamp(state.zoom || 1, MIN_ZOOM, MAX_ZOOM));
        setBookmarks(state.bookmarks || []);
        setBusyMessage("");
      } catch (error) {
        setBusyMessage("");
        await reportError("Unable to open the PDF", error, {
          pdfId: selectedPdf.id,
          pdfName: selectedPdf.name
        });
      }
    };

    void openSelectedFile();

    return () => {
      cancelled = true;
      activeRenderRef.current?.cancel();
      void openedDoc?.destroy?.();
    };
  }, [reportError, selectedPdf]);

  useEffect(() => {
    if (!selectedPdf || !pdfDoc || selectedPdf.kind !== "pdf") {
      return () => undefined;
    }

    const handle = window.setTimeout(() => {
      void savePdfPosition(selectedPdf.id, pageNumber, zoom).catch((error: unknown) => {
        void reportError("Unable to save reading position", error, {
          pdfId: selectedPdf.id,
          page: pageNumber,
          zoom
        });
      });
    }, 350);

    return () => window.clearTimeout(handle);
  }, [pageNumber, pdfDoc, reportError, selectedPdf, zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const viewer = viewerRef.current;
    if (!canvas || !viewer || !pdfDoc) {
      return () => undefined;
    }

    let cancelled = false;
    activeRenderRef.current?.cancel();

    const renderPage = async () => {
      setRenderMessage("Rendering page...");
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) {
          return;
        }

        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(240, viewer.clientWidth - 16);
        const fitScale = availableWidth / baseViewport.width;
        const viewport = page.getViewport({ scale: fitScale * zoom });
        let outputScale = Math.min(window.devicePixelRatio || 1, 2);
        const requestedPixels = viewport.width * viewport.height * outputScale * outputScale;

        if (requestedPixels > MAX_CANVAS_PIXELS) {
          outputScale = Math.max(
            1,
            Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height))
          );
        }

        const context = canvas.getContext("2d", { alpha: false });
        if (!context) {
          throw new Error("Canvas rendering context is unavailable");
        }

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, viewport.width, viewport.height);

        const renderTask = page.render({ canvasContext: context, viewport });
        activeRenderRef.current = renderTask;
        await renderTask.promise;

        if (!cancelled) {
          setRenderMessage("");
        }
      } catch (error) {
        if (!cancelled && !describeError(error).toLowerCase().includes("cancel")) {
          setRenderMessage("");
          await reportError("Unable to render this page", error, {
            pdfId: selectedPdf?.id,
            page: pageNumber
          });
        }
      }
    };

    void renderPage();

    return () => {
      cancelled = true;
      activeRenderRef.current?.cancel();
    };
  }, [pageNumber, pdfDoc, reportError, selectedPdf?.id, zoom]);

  const pdfOptions = useMemo(
    () =>
      pdfs.slice(0, 50).map((pdf) => ({
        data: pdf.id,
        label: `${fileKindLabel(pdf.kind)} · ${pdf.relativePath || pdf.name} (${formatBytes(pdf.sizeBytes)})`
      })),
    [pdfs]
  );

  const selectedPdfId = selectedPdf?.id ?? "";
  const currentPdfDescription = selectedPdf
    ? `${formatBytes(selectedPdf.sizeBytes)} • modified ${formatDate(selectedPdf.modifiedTime)}`
    : settings.pdfFolder;
  const isCurrentPageBookmarked = bookmarks.some((bookmark) => bookmark.page === pageNumber);
  const visibleFiles = pdfs.slice(0, 150);
  const candidateSummary = diagnostics?.candidates
    .filter((candidate) => candidate.exists)
    .slice(0, 4)
    .map((candidate) => `${candidate.folder} (${candidate.supportedCount})`);
  const debugEntries = debugInfo?.probe.entries.slice(0, 8) ?? [];
  const visibleDebugEntries = debugEntries.slice(0, 4);

  const selectPdf = (pdfId: string) => {
    const pdf = pdfs.find((candidate) => candidate.id === pdfId) ?? null;
    setSelectedPdf(pdf);
    setShowBookmarks(false);
    setShowSettings(false);
  };

  const goHome = () => {
    setSelectedPdf(null);
    setShowBookmarks(false);
    setShowSettings(false);
    setErrorMessage("");
  };

  const changePage = (nextPage: number) => {
    setPageNumber(clamp(Math.trunc(nextPage), 1, Math.max(1, pageCount)));
    viewerRef.current?.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  };

  const changeZoom = (nextZoom: number) => {
    setZoom(clamp(Number(nextZoom.toFixed(2)), MIN_ZOOM, MAX_ZOOM));
  };

  const onToggleBookmark = async () => {
    if (!selectedPdf) {
      return;
    }

    try {
      const result = await toggleBookmark(selectedPdf.id, pageNumber);
      setBookmarks(result.bookmarks);
      toaster.toast({
        title: "PDF Viewer",
        body: result.bookmarked ? `Bookmarked page ${pageNumber}` : `Removed page ${pageNumber}`
      });
    } catch (error) {
      await reportError("Unable to update bookmark", error, {
        pdfId: selectedPdf.id,
        page: pageNumber
      });
    }
  };

  const saveZoomStep = async (value: number) => {
    const nextSettings = await saveSettings({ zoomStep: value });
    setSettings(nextSettings);
  };

  return (
    <div style={styles.shell}>
      <PanelSection title="PDF Folder">
        <PanelSectionRow>
          <DropdownItem
            label="Quick picker"
            description={currentPdfDescription}
            rgOptions={pdfOptions}
            selectedOption={selectedPdfId}
            disabled={pdfOptions.length === 0}
            strDefaultLabel={pdfOptions.length === 0 ? "No supported files found" : "Choose a file"}
            menuLabel="Library"
            onMenuWillOpen={(showMenu) => {
              void refreshLibrary().finally(showMenu);
            }}
            onChange={(option) => {
              selectPdf(String(option.data));
            }}
          />
        </PanelSectionRow>
        {pdfs.length > 50 ? (
          <PanelSectionRow>
            <div style={styles.smallText}>
              The dropdown shows the first 50 files. Use the file list below for the full library.
            </div>
          </PanelSectionRow>
        ) : null}
        <PanelSectionRow>
          <div style={styles.smallText}>{settings.pdfFolder}</div>
        </PanelSectionRow>
        {debugInfo ? (
          <PanelSectionRow>
            <div style={styles.smallText}>
              <div>Build: {debugInfo.version}</div>
              <div>
                Probe: {debugInfo.probe.status}, exists {String(debugInfo.probe.exists)}, dir{" "}
                {String(debugInfo.probe.isDir)}
              </div>
              <div>
                Last scan: {debugInfo.lastScan.status}, {debugInfo.lastScan.elapsedMs}ms,
                {` ${debugInfo.lastScan.count}`} files
              </div>
              {debugInfo.lastScan.error ? <div>{debugInfo.lastScan.error}</div> : null}
              {visibleDebugEntries.length > 0 ? <div>First entries:</div> : null}
              {visibleDebugEntries.map((entry) => (
                <div key={`${entry.name}-${entry.suffix || ""}`}>
                  {entry.name} · {entry.isFile ? "file" : entry.isDir ? "folder" : "other"} ·{" "}
                  {entry.kind || entry.suffix || "unsupported"}
                </div>
              ))}
            </div>
          </PanelSectionRow>
        ) : null}
        {pdfs.length === 0 && diagnostics ? (
          <PanelSectionRow>
            <div style={styles.smallText}>
              <div>Supported: {diagnostics.supportedExtensions.join(", ")}</div>
              {candidateSummary && candidateSummary.length > 0 ? (
                <>
                  <div>Checked folders:</div>
                  {candidateSummary.map((candidate) => (
                    <div key={candidate}>{candidate}</div>
                  ))}
                </>
              ) : null}
            </div>
          </PanelSectionRow>
        ) : null}
        <PanelSectionRow>
          <ButtonItem layout="inline" onClick={() => void refreshLibrary()}>
            <FaSyncAlt /> Refresh library
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="inline" onClick={() => void checkFolder()}>
            <FaSyncAlt /> Check folder only
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      {errorMessage ? <div style={styles.error}>{errorMessage}</div> : null}

      {!selectedPdf ? (
        <PanelSection>
          <PanelSectionRow>
            <div style={styles.empty}>
              {busyMessage ||
                (pdfs.length === 0
                  ? "Add PDF, EPUB, TXT, or MD files to the folder above, then refresh."
                  : "Choose a file below or from the folder dropdown.")}
            </div>
          </PanelSectionRow>
          {pdfs.length > 0 ? (
            <PanelSectionRow>
              <div style={styles.fileList}>
                <div style={styles.smallText}>
                  Showing {visibleFiles.length} of {pdfs.length} supported files.
                </div>
                {visibleFiles.map((file) => (
                  <ButtonItem
                    key={file.id}
                    layout="below"
                    icon={fileIcon(file.kind)}
                    description={`${fileKindLabel(file.kind)} · ${formatBytes(file.sizeBytes)} · ${file.relativePath}`}
                    onClick={() => selectPdf(file.id)}
                  >
                    {file.name}
                  </ButtonItem>
                ))}
              </div>
            </PanelSectionRow>
          ) : null}
        </PanelSection>
      ) : (
        <>
          <PanelSection title={selectedPdf.name}>
            <PanelSectionRow>
              <div style={styles.toolbar}>
                <IconButton
                  label="Home"
                  icon={<FaHome />}
                  onClick={goHome}
                />
                <IconButton
                  label="Previous page"
                  icon={<FaArrowLeft />}
                  disabled={!pdfDoc || selectedPdf.kind !== "pdf" || pageNumber <= 1}
                  onClick={() => changePage(pageNumber - 1)}
                />
                <IconButton
                  label="Next page"
                  icon={<FaArrowRight />}
                  disabled={!pdfDoc || selectedPdf.kind !== "pdf" || pageNumber >= pageCount}
                  onClick={() => changePage(pageNumber + 1)}
                />
                <IconButton
                  label="Zoom out"
                  icon={<FaSearchMinus />}
                  disabled={selectedPdf.kind !== "pdf" || !pdfDoc || zoom <= MIN_ZOOM}
                  onClick={() => changeZoom(zoom - settings.zoomStep)}
                />
                <IconButton
                  label="Zoom in"
                  icon={<FaSearchPlus />}
                  disabled={selectedPdf.kind !== "pdf" || !pdfDoc || zoom >= MAX_ZOOM}
                  onClick={() => changeZoom(zoom + settings.zoomStep)}
                />
                <IconButton
                  label="Bookmark page"
                  icon={isCurrentPageBookmarked ? <FaBookmark /> : <FaRegBookmark />}
                  disabled={selectedPdf.kind !== "pdf" || !pdfDoc}
                  onClick={() => void onToggleBookmark()}
                />
                <IconButton
                  label="Settings"
                  icon={<FaCog />}
                  onClick={() => setShowSettings((visible) => !visible)}
                />
              </div>
            </PanelSectionRow>
            <PanelSectionRow>
              <div style={styles.pageMeta}>
                <span>
                  {selectedPdf.kind === "pdf"
                    ? `Page ${pageCount ? pageNumber : "-"} of ${pageCount || "-"}`
                    : fileKindLabel(selectedPdf.kind)}
                </span>
                <span>{selectedPdf.kind === "pdf" ? `${Math.round(zoom * 100)}%` : ""}</span>
              </div>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem
                layout="inline"
                icon={<FaListUl />}
                disabled={selectedPdf.kind !== "pdf"}
                onClick={() => setShowBookmarks((visible) => !visible)}
              >
                {bookmarks.length === 0
                  ? "No bookmarks"
                  : `${bookmarks.length} bookmark${bookmarks.length === 1 ? "" : "s"}`}
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>

          {showSettings ? (
            <PanelSection title="Settings">
              <PanelSectionRow>
                <SliderField
                  label="Zoom step"
                  value={Math.round(settings.zoomStep * 100)}
                  min={5}
                  max={100}
                  step={5}
                  valueSuffix="%"
                  showValue
                  onChange={(value) => {
                    void saveZoomStep(clamp(value / 100, 0.05, 1));
                  }}
                />
              </PanelSectionRow>
              <PanelSectionRow>
                <div style={styles.smallText}>
                  View mode: single page. Continuous scroll is intentionally disabled in v1
                  to keep large guides responsive in the Decky overlay.
                </div>
              </PanelSectionRow>
              {logPath ? (
                <PanelSectionRow>
                  <div style={styles.smallText}>Log: {logPath}</div>
                </PanelSectionRow>
              ) : null}
            </PanelSection>
          ) : null}

          {showBookmarks ? (
            <PanelSection title="Bookmarks">
              <PanelSectionRow>
                <div style={styles.bookmarkList}>
                  {bookmarks.length === 0 ? (
                    <div style={styles.smallText}>No pages bookmarked for this PDF.</div>
                  ) : (
                    bookmarks.map((bookmark) => (
                      <Button
                        key={`${selectedPdf.id}-${bookmark.page}`}
                        onClick={() => changePage(bookmark.page)}
                      >
                        Page {bookmark.page}
                      </Button>
                    ))
                  )}
                </div>
              </PanelSectionRow>
            </PanelSection>
          ) : null}

          <PanelSection>
            <PanelSectionRow>
              {selectedPdf.kind === "pdf" ? (
                <Focusable style={styles.viewerFrame} ref={viewerRef}>
                  {busyMessage ? <div style={styles.empty}>{busyMessage}</div> : null}
                  {renderMessage && !busyMessage ? (
                    <div style={styles.smallText}>{renderMessage}</div>
                  ) : null}
                  <canvas
                    ref={canvasRef}
                    style={{
                      ...styles.canvas,
                      visibility: pdfDoc ? "visible" : "hidden"
                    }}
                  />
                </Focusable>
              ) : (
                <Focusable style={styles.textViewer}>
                  {busyMessage ? <div>{busyMessage}</div> : textContent}
                </Focusable>
              )}
            </PanelSectionRow>
          </PanelSection>
        </>
      )}
    </div>
  );
}

export default definePlugin(() => {
  return {
    name: "PDF Viewer",
    titleView: <div className={staticClasses.Title}>PDF Viewer</div>,
    content: <Content />,
    icon: <FaFilePdf />
  };
});
