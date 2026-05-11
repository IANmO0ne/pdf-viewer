import {
  Button,
  ButtonItem,
  Focusable,
  PanelSection,
  PanelSectionRow,
  SliderField,
  TextField,
  staticClasses
} from "@decky/ui";
import { call, definePlugin, toaster } from "@decky/api";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FaArrowLeft,
  FaArrowRight,
  FaBookmark,
  FaCog,
  FaExclamationTriangle,
  FaFileAlt,
  FaBookOpen,
  FaFilePdf,
  FaFont,
  FaHome,
  FaImage,
  FaListOl,
  FaListUl,
  FaRegBookmark,
  FaSearchMinus,
  FaSearchPlus,
  FaSyncAlt
} from "react-icons/fa";

// "legacy" is PDF.js' browser-compatible build path, not old project code.
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

interface NativeRenderStatus {
  version: string;
  timestamp: string;
  available: boolean;
  renderer: string;
  executable: string;
  message: string;
}

interface NativePageRender {
  version: string;
  timestamp: string;
  id: string;
  url: string;
  renderer: string;
  page: number;
  width: number;
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

interface PluginStatus {
  version: string;
  timestamp: string;
  signature?: string;
}

interface ActiveReaderSession {
  fileId: string;
  page?: number;
  zoom?: number;
  updatedAt: string;
}

interface FailedFileRecord {
  name: string;
  message: string;
  updatedAt: string;
}

type FailedFileMap = Record<string, FailedFileRecord>;

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
    canvas?: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
    annotationMode?: number;
    background?: string;
  }) => PdfRenderTask;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageProxy>;
  getOutline?: () => Promise<PdfOutlineItem[] | null>;
  getDestination?: (id: string) => Promise<unknown[] | null>;
  getPageIndex?: (ref: unknown) => Promise<number>;
  destroy?: () => Promise<void>;
}

interface PdfDocumentLoadingTask {
  promise: Promise<unknown>;
  destroy?: () => Promise<void>;
}

type PdfDestination = string | unknown[] | null | undefined;

interface PdfOutlineItem {
  title?: string;
  dest?: PdfDestination;
  items?: PdfOutlineItem[];
}

interface TocItem {
  id: string;
  title: string;
  page: number | null;
  depth: number;
}

const getPluginStatus = () => call<[], PluginStatus>("get_plugin_status");
const getSettings = () => call<[], Settings>("get_settings");
const saveSettings = (settings: Partial<Settings>) =>
  call<[Partial<Settings>], Settings>("save_settings", settings);
const listPdfs = () => call<[], PdfEntry[]>("list_pdfs");
const getPdfAccess = (pdfId: string) =>
  call<[string], PdfAccess>("get_pdf_access", pdfId);
const getNativeRenderStatus = () =>
  call<[], NativeRenderStatus>("get_native_render_status");
const getNativePageRender = (pdfId: string, page: number, width: number) =>
  call<[string, number, number], NativePageRender>(
    "get_native_page_render",
    pdfId,
    page,
    width
  );
const getTextContent = (fileId: string) =>
  call<[string], TextContent>("get_text_content", fileId);
const getPdfState = (pdfId: string) => call<[string], PdfState>("get_pdf_state", pdfId);
const savePdfPosition = (pdfId: string, page: number, zoom: number) =>
  call<[string, number, number], PdfState>("save_pdf_position", pdfId, page, zoom);
const toggleBookmark = (pdfId: string, page: number) =>
  call<[string, number], BookmarkToggleResult>("toggle_bookmark", pdfId, page);
const logFrontendEvent = (
  level: string,
  message: string,
  context?: Record<string, unknown>
) =>
  call<[string, string, Record<string, unknown> | undefined], boolean>(
    "log_frontend_event",
    level,
    message,
    context
  );

const BACKEND_LOG_COMMAND =
  'journalctl -u plugin_loader.service -n 300 --no-pager | grep -i -E "pdf|decky-pdf|python|traceback|error"';
const ACTIVE_SESSION_STORAGE_KEY = "decky-pdf-viewer.activeReaderSession";
const FAILED_FILES_STORAGE_KEY = "decky-pdf-viewer.failedFiles";
const ZOOM_STEP_STORAGE_KEY = "decky-pdf-viewer.zoomStep";
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const MAX_CANVAS_PIXELS = 9_000_000;
const NATIVE_RENDER_MAX_WIDTH = 3200;
const MAX_TOC_ITEMS = 300;
const MAX_FULL_PDF_FALLBACK_BYTES = 128 * 1024 * 1024;
const MAX_STRUCTURAL_REPAIR_FALLBACK_BYTES = 512 * 1024 * 1024;
const DEFAULT_SETTINGS: Settings = {
  pdfFolder: "/home/deck/Documents/PDF Steamdeck",
  viewMode: "single",
  fitMode: "width",
  zoomStep: 0.25
};

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "./pdf.worker.min.js",
  import.meta.url
).toString();
const PDFJS_CMAP_URL = new URL("./cmaps/", import.meta.url).toString();
const PDFJS_STANDARD_FONT_DATA_URL = new URL(
  "./standard_fonts/",
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
    gridTemplateColumns: "repeat(10, minmax(0, 1fr))",
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
  nativeImage: {
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
  emptyCompact: {
    minHeight: "38px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    color: "rgba(255, 255, 255, 0.72)",
    padding: "6px 8px",
    lineHeight: "18px",
    fontSize: "13px"
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
  tocList: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxHeight: "360px",
    overflowY: "auto",
    paddingRight: "4px"
  },
  jumpGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "6px"
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

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience cache. Backend state remains the source of truth.
  }
}

function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures in the Decky overlay.
  }
}

function sanitizeZoomStep(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0.05, 1) : DEFAULT_SETTINGS.zoomStep;
}

function loadInitialSettings(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    zoomStep: sanitizeZoomStep(readStorage(ZOOM_STEP_STORAGE_KEY))
  };
}

function readActiveReaderSession(): ActiveReaderSession | null {
  const rawValue = readStorage(ACTIVE_SESSION_STORAGE_KEY);
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<ActiveReaderSession>;
    if (!parsed || typeof parsed.fileId !== "string" || parsed.fileId.length === 0) {
      return null;
    }

    return {
      fileId: parsed.fileId,
      page: Number.isFinite(parsed.page)
        ? Math.max(1, Math.trunc(Number(parsed.page)))
        : undefined,
      zoom: Number.isFinite(parsed.zoom)
        ? clamp(Number(parsed.zoom), MIN_ZOOM, MAX_ZOOM)
        : undefined,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
    };
  } catch {
    removeStorage(ACTIVE_SESSION_STORAGE_KEY);
    return null;
  }
}

function writeActiveReaderSession(fileId: string, page?: number, zoom?: number): void {
  const session: ActiveReaderSession = {
    fileId,
    updatedAt: new Date().toISOString()
  };
  if (Number.isFinite(page)) {
    session.page = Math.max(1, Math.trunc(Number(page)));
  }
  if (Number.isFinite(zoom)) {
    session.zoom = clamp(Number(zoom), MIN_ZOOM, MAX_ZOOM);
  }
  writeStorage(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(session));
}

function clearActiveReaderSession(): void {
  removeStorage(ACTIVE_SESSION_STORAGE_KEY);
}

function loadFailedFiles(): FailedFileMap {
  const rawValue = readStorage(FAILED_FILES_STORAGE_KEY);
  if (!rawValue) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue) as FailedFileMap;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, record]) => {
          return (
            record &&
            typeof record.name === "string" &&
            typeof record.message === "string" &&
            typeof record.updatedAt === "string"
          );
        })
        .slice(-100)
    );
  } catch {
    removeStorage(FAILED_FILES_STORAGE_KEY);
    return {};
  }
}

function saveFailedFiles(records: FailedFileMap): void {
  writeStorage(FAILED_FILES_STORAGE_KEY, JSON.stringify(records));
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

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isStructuralPdfError(error: unknown): boolean {
  return isPdfIntegrityMessage(describeError(error));
}

function isPdfIntegrityMessage(message: string): boolean {
  const detail = message.toLowerCase();
  return (
    detail.includes("invalid root reference") ||
    detail.includes("invalid pdf structure") ||
    detail.includes("xref") ||
    detail.includes("trailer") ||
    detail.includes("catalog") ||
    detail.includes("corrupt") ||
    detail.includes("damaged")
  );
}

function isPasswordProtectedPdfMessage(message: string): boolean {
  const detail = message.toLowerCase();
  return (
    detail.includes("password") ||
    detail.includes("encrypted") ||
    detail.includes("needpassword") ||
    detail.includes("incorrect password")
  );
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

async function resolveOutlinePage(
  doc: PdfDocumentProxy,
  destination: PdfDestination
): Promise<number | null> {
  let target: unknown[] | null = null;

  if (typeof destination === "string") {
    target = (await doc.getDestination?.(destination)) || null;
  } else if (Array.isArray(destination)) {
    target = destination;
  }

  if (!target || target.length === 0) {
    return null;
  }

  const pageRef = target[0];
  if (typeof pageRef === "number") {
    return pageRef + 1;
  }

  if (pageRef && typeof pageRef === "object" && doc.getPageIndex) {
    const pageIndex = await doc.getPageIndex(pageRef);
    return pageIndex + 1;
  }

  return null;
}

async function appendOutlineItems(
  doc: PdfDocumentProxy,
  items: PdfOutlineItem[],
  depth: number,
  prefix: string,
  output: TocItem[]
): Promise<void> {
  for (let index = 0; index < items.length && output.length < MAX_TOC_ITEMS; index += 1) {
    const item = items[index];
    const title = String(item.title || "Untitled section").trim() || "Untitled section";
    let page: number | null = null;

    try {
      page = await resolveOutlinePage(doc, item.dest);
    } catch {
      page = null;
    }

    output.push({
      id: `${prefix}-${index}`,
      title,
      page,
      depth
    });

    if (item.items?.length) {
      await appendOutlineItems(
        doc,
        item.items,
        depth + 1,
        `${prefix}-${index}`,
        output
      );
    }
  }
}

async function loadPdfContents(doc: PdfDocumentProxy): Promise<TocItem[]> {
  const outline = await doc.getOutline?.();
  if (!outline?.length) {
    return [];
  }

  const items: TocItem[] = [];
  await appendOutlineItems(doc, outline, 0, "toc", items);
  return items;
}

function createPdfLoadingTask(
  access: PdfAccess,
  useCompatibilityRenderer: boolean,
  data?: Uint8Array
): PdfDocumentLoadingTask {
  const sharedOptions = {
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
    disableFontFace: useCompatibilityRenderer,
    useSystemFonts: !useCompatibilityRenderer,
    fontExtraProperties: true,
    ignoreErrors: true,
    stopAtErrors: false,
    useWorkerFetch: true
  };

  if (data) {
    return pdfjsLib.getDocument({
      ...sharedOptions,
      data,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true
    }) as PdfDocumentLoadingTask;
  }

  return pdfjsLib.getDocument({
    ...sharedOptions,
    url: access.url,
    withCredentials: false,
    rangeChunkSize: 65536,
    disableStream: true,
    disableAutoFetch: true
  }) as PdfDocumentLoadingTask;
}

async function loadPdfDocument(
  access: PdfAccess,
  useCompatibilityRenderer: boolean,
  setRenderMessage: (message: string) => void
): Promise<PdfDocumentProxy> {
  const loadingTask = createPdfLoadingTask(access, useCompatibilityRenderer);
  try {
    return (await withTimeout(
      loadingTask.promise as Promise<PdfDocumentProxy>,
      20_000,
      "PDF loading took longer than 20 seconds"
    )) as PdfDocumentProxy;
  } catch (error) {
    await loadingTask.destroy?.().catch(() => undefined);

    const allowLargeStructuralRetry =
      isStructuralPdfError(error) &&
      access.sizeBytes <= MAX_STRUCTURAL_REPAIR_FALLBACK_BYTES;
    if (access.sizeBytes > MAX_FULL_PDF_FALLBACK_BYTES && !allowLargeStructuralRetry) {
      throw error;
    }

    setRenderMessage(
      allowLargeStructuralRetry
        ? "Repair loading large PDF. This can take a minute..."
        : "Retrying with full-file loading..."
    );
    const response = await withTimeout(
      fetch(access.url, { cache: "no-store", credentials: "omit" }),
      90_000,
      "Full PDF fallback request took longer than 90 seconds"
    );
    if (!response.ok) {
      throw new Error(`Full PDF fallback failed with HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(
      await withTimeout(
        response.arrayBuffer(),
        allowLargeStructuralRetry ? 180_000 : 60_000,
        allowLargeStructuralRetry
          ? "Large PDF repair download took longer than 180 seconds"
          : "Full PDF fallback download took longer than 60 seconds"
      )
    );
    const fullFileTask = createPdfLoadingTask(access, useCompatibilityRenderer, bytes);
    try {
      return (await withTimeout(
        fullFileTask.promise as Promise<PdfDocumentProxy>,
        20_000,
        "Full PDF loading took longer than 20 seconds"
      )) as PdfDocumentProxy;
    } catch (fallbackError) {
      await fullFileTask.destroy?.().catch(() => undefined);
      throw fallbackError;
    }
  }
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
  const [settings, setSettings] = useState<Settings>(loadInitialSettings);
  const [pdfs, setPdfs] = useState<PdfEntry[]>([]);
  const [selectedPdf, setSelectedPdf] = useState<PdfEntry | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfDocumentProxy | null>(null);
  const [textContent, setTextContent] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showContents, setShowContents] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tocItems, setTocItems] = useState<TocItem[]>([]);
  const [tocStatus, setTocStatus] = useState("");
  const [jumpPage, setJumpPage] = useState(1);
  const [fileFilter, setFileFilter] = useState("");
  const [failedFiles, setFailedFiles] = useState<FailedFileMap>(loadFailedFiles);
  const [busyMessage, setBusyMessage] = useState("Loading PDF folder...");
  const [errorMessage, setErrorMessage] = useState("");
  const [renderMessage, setRenderMessage] = useState("");
  const [pluginStatus, setPluginStatus] = useState<PluginStatus | null>(null);
  const [useCompatibilityRenderer, setUseCompatibilityRenderer] = useState(false);
  const [useNativeRenderer, setUseNativeRenderer] = useState(false);
  const [nativeRenderStatus, setNativeRenderStatus] = useState<NativeRenderStatus | null>(
    null
  );
  const [nativePageImage, setNativePageImage] = useState<NativePageRender | null>(null);
  const [nativeImageCssWidth, setNativeImageCssWidth] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const activeRenderRef = useRef<PdfRenderTask | null>(null);
  const reopenPositionRef = useRef<{ page: number; zoom: number } | null>(null);
  const restoredActiveFileRef = useRef(false);
  const zoomStepSaveHandleRef = useRef<number | null>(null);

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
      await withTimeout(
        logFrontendEvent("error", message, { ...context, error: detail }),
        1_000,
        "Frontend error logging timed out"
      ).catch(() => undefined);
    },
    []
  );

  const updateFailedFile = useCallback(
    (file: PdfEntry, message: string) => {
      setFailedFiles((currentRecords) => {
        const nextRecords = {
          ...currentRecords,
          [file.id]: {
            name: file.name,
            message,
            updatedAt: new Date().toISOString()
          }
        };
        saveFailedFiles(nextRecords);
        return nextRecords;
      });
    },
    []
  );

  const clearFailedFile = useCallback((fileId: string) => {
    setFailedFiles((currentRecords) => {
      if (!currentRecords[fileId]) {
        return currentRecords;
      }
      const nextRecords = { ...currentRecords };
      delete nextRecords[fileId];
      saveFailedFiles(nextRecords);
      return nextRecords;
    });
  }, []);

  const loadLibrary = useCallback(async () => {
    setBusyMessage("Connecting to PDF Viewer...");
    setErrorMessage("");

    try {
      const loadedStatus = await withTimeout(
        getPluginStatus(),
        3_000,
        "Python backend did not answer within 3 seconds"
      );
      setPluginStatus(loadedStatus);

      void withTimeout(
        getSettings(),
        2_000,
        "Settings load took longer than 2 seconds"
      )
        .then((loadedSettings) => {
          const zoomStep = sanitizeZoomStep(loadedSettings.zoomStep);
          setSettings({ ...DEFAULT_SETTINGS, ...loadedSettings, zoomStep });
          writeStorage(ZOOM_STEP_STORAGE_KEY, String(zoomStep));
        })
        .catch((error: unknown) => {
          void withTimeout(
            logFrontendEvent("warning", "Unable to load saved settings", {
              error: describeError(error)
            }),
            1_000,
            "Settings load warning logging timed out"
          ).catch(() => undefined);
        });

      void withTimeout(
        getNativeRenderStatus(),
        2_000,
        "Native render status check took longer than 2 seconds"
      )
        .then(setNativeRenderStatus)
        .catch(() => setNativeRenderStatus(null));

      setBusyMessage("Loading PDF folder...");
      const loadedPdfs = await withTimeout(
        listPdfs(),
        8_000,
        "Library scan took longer than 8 seconds"
      );
      setPdfs(loadedPdfs);
      setBusyMessage("");
    } catch (error) {
      setBusyMessage("");
      await reportError("PDF Viewer backend is not responding", error);
    }
  }, [reportError]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (!selectedPdf) {
      setPdfDoc(null);
      setTextContent("");
      setPageCount(0);
      setPageNumber(1);
      setBookmarks([]);
      setTocItems([]);
      setTocStatus("");
      setJumpPage(1);
      setShowContents(false);
      setRenderMessage("");
      setNativePageImage(null);
      return () => undefined;
    }

    let cancelled = false;
    let openedDoc: PdfDocumentProxy | null = null;

    const openSelectedFile = async () => {
      setBusyMessage(`Opening ${selectedPdf.name}...`);
      setErrorMessage("");
      setRenderMessage("");
      setNativePageImage(null);
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
          setTocItems([]);
          setTocStatus("");
          setJumpPage(1);
          clearFailedFile(selectedPdf.id);
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
        const doc = await loadPdfDocument(
          access,
          useCompatibilityRenderer,
          setRenderMessage
        );

        if (cancelled) {
          await doc.destroy?.();
          return;
        }

        openedDoc = doc;
        const reopenPosition = reopenPositionRef.current;
        const activeSession = readActiveReaderSession();
        const sessionPosition =
          activeSession?.fileId === selectedPdf.id ? activeSession : null;
        reopenPositionRef.current = null;
        const safePage = clamp(
          Math.trunc(reopenPosition?.page || sessionPosition?.page || state.lastPage || 1),
          1,
          doc.numPages
        );
        setPdfDoc(doc);
        setPageCount(doc.numPages);
        setPageNumber(safePage);
        setJumpPage(safePage);
        setZoom(
          clamp(reopenPosition?.zoom || sessionPosition?.zoom || state.zoom || 1, MIN_ZOOM, MAX_ZOOM)
        );
        setBookmarks(state.bookmarks || []);
        clearFailedFile(selectedPdf.id);
        setBusyMessage("");
      } catch (error) {
        setBusyMessage("");
        const failureDetail = describeError(error);
        updateFailedFile(selectedPdf, failureDetail);
        const openErrorTitle = isPasswordProtectedPdfMessage(failureDetail)
          ? "Unable to open password-protected PDF"
          : selectedPdf.kind === "pdf"
            ? "Unable to open the PDF"
            : "Unable to open the file";
        await reportError(openErrorTitle, error, {
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
  }, [clearFailedFile, reportError, selectedPdf, updateFailedFile, useCompatibilityRenderer]);

  useEffect(() => {
    if (!selectedPdf || !pdfDoc || selectedPdf.kind !== "pdf") {
      return () => undefined;
    }

    writeActiveReaderSession(selectedPdf.id, pageNumber, zoom);

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
    if (!pdfDoc || !selectedPdf || selectedPdf.kind !== "pdf") {
      setTocItems([]);
      setTocStatus("");
      return () => undefined;
    }

    let cancelled = false;
    setTocStatus("Loading table of contents...");
    setTocItems([]);

    const loadContents = async () => {
      try {
        const items = await withTimeout(
          loadPdfContents(pdfDoc),
          5_000,
          "Table of contents took longer than 5 seconds"
        );
        if (cancelled) {
          return;
        }
        setTocItems(items);
        setTocStatus(
          items.length > 0
            ? `${items.length} table of contents item${items.length === 1 ? "" : "s"}`
            : "No document table of contents found"
        );
      } catch (error) {
        if (cancelled) {
          return;
        }
        setTocItems([]);
        setTocStatus("No document table of contents found");
        await withTimeout(
          logFrontendEvent("warning", "Unable to load PDF table of contents", {
            pdfId: selectedPdf.id,
            error: describeError(error)
          }),
          1_000,
          "Table of contents logging timed out"
        ).catch(() => undefined);
      }
    };

    void loadContents();

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, selectedPdf]);

  useEffect(() => {
    setJumpPage(pageNumber);
  }, [pageNumber, selectedPdf?.id]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const viewer = viewerRef.current;
    if (!canvas || !viewer || !pdfDoc || useNativeRenderer || selectedPdf?.kind !== "pdf") {
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

        const renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          annotationMode: 0,
          background: "#ffffff"
        });
        activeRenderRef.current = renderTask;
        await renderTask.promise;

        if (!cancelled) {
          setRenderMessage("");
        }
      } catch (error) {
        if (cancelled || describeError(error).toLowerCase().includes("cancel")) {
          return;
        }

        if (!useCompatibilityRenderer) {
          setRenderMessage("Retrying with compatibility renderer...");
          reopenPositionRef.current = { page: pageNumber, zoom };
          await withTimeout(
            logFrontendEvent("warning", "Retrying PDF render with compatibility renderer", {
              pdfId: selectedPdf?.id,
              page: pageNumber,
              error: describeError(error)
            }),
            1_000,
            "Frontend render retry logging timed out"
          ).catch(() => undefined);
          setUseCompatibilityRenderer(true);
          return;
        }

        setRenderMessage("");
        if (selectedPdf) {
          updateFailedFile(selectedPdf, describeError(error));
        }
        await reportError("Unable to render this page", error, {
          pdfId: selectedPdf?.id,
          page: pageNumber,
          compatibilityRenderer: useCompatibilityRenderer
        });
      }
    };

    void renderPage();

    return () => {
      cancelled = true;
      activeRenderRef.current?.cancel();
    };
  }, [
    pageNumber,
    pdfDoc,
    reportError,
    selectedPdf,
    updateFailedFile,
    useCompatibilityRenderer,
    useNativeRenderer,
    zoom
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !pdfDoc || !selectedPdf || selectedPdf.kind !== "pdf" || !useNativeRenderer) {
      return () => undefined;
    }

    let cancelled = false;
    const renderNativePage = async () => {
      setNativePageImage(null);
      setRenderMessage("Rendering page with native PDF renderer...");

      const availableWidth = Math.max(240, viewer.clientWidth - 16);
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const cssWidth = Math.max(availableWidth, Math.floor(availableWidth * zoom));
      const renderWidth = Math.floor(
        clamp(cssWidth * outputScale, 240, NATIVE_RENDER_MAX_WIDTH)
      );
      setNativeImageCssWidth(Math.floor(cssWidth));

      try {
        const image = await withTimeout(
          getNativePageRender(selectedPdf.id, pageNumber, renderWidth),
          60_000,
          "Native PDF renderer took longer than 60 seconds"
        );
        if (!cancelled) {
          setNativePageImage(image);
          setRenderMessage("");
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setRenderMessage("");
        updateFailedFile(selectedPdf, describeError(error));
        await reportError("Unable to render this page with the native renderer", error, {
          pdfId: selectedPdf.id,
          page: pageNumber,
          zoom
        });
      }
    };

    void renderNativePage();

    return () => {
      cancelled = true;
    };
  }, [pageNumber, pdfDoc, reportError, selectedPdf, updateFailedFile, useNativeRenderer, zoom]);

  const currentFolder = settings.pdfFolder;
  const isCurrentPageBookmarked = bookmarks.some((bookmark) => bookmark.page === pageNumber);
  const normalizedFileFilter = fileFilter.trim().toLowerCase();
  const filteredFiles = normalizedFileFilter
    ? pdfs.filter((file) => {
        const searchableText = `${file.name} ${file.relativePath} ${fileKindLabel(file.kind)}`;
        return searchableText.toLowerCase().includes(normalizedFileFilter);
      })
    : pdfs;
  const visibleFiles = filteredFiles.slice(0, 150);
  const backendIsConnected = Boolean(pluginStatus);
  const nativeRendererLabel = nativeRenderStatus
    ? nativeRenderStatus.available
      ? `${nativeRenderStatus.renderer} available`
      : "not available"
    : "unknown";
  const showPdfIntegrityHint =
    selectedPdf?.kind === "pdf" && errorMessage && isPdfIntegrityMessage(errorMessage);
  const showPasswordProtectedHint =
    selectedPdf?.kind === "pdf" &&
    errorMessage &&
    isPasswordProtectedPdfMessage(errorMessage);

  const selectPdf = useCallback((pdfId: string) => {
    const pdf = pdfs.find((candidate) => candidate.id === pdfId) ?? null;
    setUseCompatibilityRenderer(false);
    setUseNativeRenderer(false);
    setNativePageImage(null);
    if (pdf) {
      writeActiveReaderSession(pdf.id);
    } else {
      clearActiveReaderSession();
    }
    setSelectedPdf(pdf);
    setShowBookmarks(false);
    setShowContents(false);
    setShowSettings(false);
  }, [pdfs]);

  useEffect(() => {
    if (restoredActiveFileRef.current || selectedPdf || pdfs.length === 0) {
      return;
    }

    const activeSession = readActiveReaderSession();
    if (!activeSession) {
      restoredActiveFileRef.current = true;
      return;
    }

    const activeFile = pdfs.find((candidate) => candidate.id === activeSession.fileId);
    restoredActiveFileRef.current = true;
    if (activeFile) {
      selectPdf(activeFile.id);
    } else {
      clearActiveReaderSession();
    }
  }, [pdfs, selectPdf, selectedPdf]);

  const goHome = () => {
    setUseCompatibilityRenderer(false);
    setUseNativeRenderer(false);
    setNativePageImage(null);
    clearActiveReaderSession();
    setSelectedPdf(null);
    setShowBookmarks(false);
    setShowContents(false);
    setShowSettings(false);
    setErrorMessage("");
  };

  const changePage = (nextPage: number) => {
    const safePage = clamp(Math.trunc(nextPage), 1, Math.max(1, pageCount));
    setPageNumber(safePage);
    setJumpPage(safePage);
    viewerRef.current?.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  };

  const changeZoom = (nextZoom: number) => {
    setZoom(clamp(Number(nextZoom.toFixed(2)), MIN_ZOOM, MAX_ZOOM));
  };

  const saveZoomStep = (value: number) => {
    const nextZoomStep = sanitizeZoomStep(value);
    setSettings((currentSettings) => ({
      ...currentSettings,
      zoomStep: nextZoomStep
    }));
    writeStorage(ZOOM_STEP_STORAGE_KEY, String(nextZoomStep));

    if (zoomStepSaveHandleRef.current !== null) {
      window.clearTimeout(zoomStepSaveHandleRef.current);
    }

    zoomStepSaveHandleRef.current = window.setTimeout(() => {
      zoomStepSaveHandleRef.current = null;
      void withTimeout(
        saveSettings({ zoomStep: nextZoomStep }),
        2_000,
        "Zoom step save took longer than 2 seconds"
      )
        .then((savedSettings) => {
          const savedZoomStep = sanitizeZoomStep(savedSettings.zoomStep);
          setSettings((currentSettings) => ({
            ...currentSettings,
            ...savedSettings,
            zoomStep: savedZoomStep
          }));
          writeStorage(ZOOM_STEP_STORAGE_KEY, String(savedZoomStep));
        })
        .catch((error: unknown) => {
          void withTimeout(
            logFrontendEvent("warning", "Unable to save zoom button step", {
              zoomStep: nextZoomStep,
              error: describeError(error)
            }),
            1_000,
            "Zoom step save warning logging timed out"
          ).catch(() => undefined);
        });
    }, 500);
  };

  useEffect(() => {
    return () => {
      if (zoomStepSaveHandleRef.current !== null) {
        window.clearTimeout(zoomStepSaveHandleRef.current);
      }
    };
  }, []);

  const toggleFontRepair = () => {
    reopenPositionRef.current = { page: pageNumber, zoom };
    setErrorMessage("");
    setNativePageImage(null);
    setRenderMessage(
      useCompatibilityRenderer ? "Reloading normal renderer..." : "Reloading font repair renderer..."
    );
    setUseCompatibilityRenderer((enabled) => !enabled);
  };

  const toggleNativeRenderer = async () => {
    if (!selectedPdf || selectedPdf.kind !== "pdf") {
      return;
    }

    if (useNativeRenderer) {
      setUseNativeRenderer(false);
      setNativePageImage(null);
      setRenderMessage("Reloading normal renderer...");
      return;
    }

    setErrorMessage("");
    setRenderMessage("Checking native PDF renderer...");
    try {
      const status = await withTimeout(
        getNativeRenderStatus(),
        3_000,
        "Native render status check took longer than 3 seconds"
      );
      setNativeRenderStatus(status);
      if (!status.available) {
        throw new Error(status.message || "Native PDF renderer is not available");
      }
      setUseNativeRenderer(true);
      setRenderMessage("Switching to native page renderer...");
    } catch (error) {
      setRenderMessage("");
      await reportError("Native PDF renderer is not available", error, {
        pdfId: selectedPdf.id
      });
    }
  };

  const toggleContents = () => {
    setShowContents((visible) => !visible);
    setShowBookmarks(false);
  };

  const goToPage = (page: number) => {
    changePage(page);
    setShowContents(false);
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

  return (
    <div style={styles.shell}>
      <PanelSection title="PDF Folder">
        <PanelSectionRow>
          <div style={styles.smallText}>{currentFolder}</div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="inline" onClick={() => void loadLibrary()}>
            <FaSyncAlt /> Retry loading files
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      {errorMessage ? (
        <div style={styles.error}>
          <div>{errorMessage}</div>
          {!backendIsConnected ? (
            <>
              <div style={{ marginTop: "6px" }}>
                The frontend is installed, but Decky is not answering Python RPC calls.
                Run this in Desktop Mode Konsole and send the output:
              </div>
              <div style={{ marginTop: "6px", overflowWrap: "anywhere" }}>
                {BACKEND_LOG_COMMAND}
              </div>
            </>
          ) : null}
          {showPdfIntegrityHint ? (
            <div style={{ marginTop: "6px" }}>
              This PDF may be corrupted or malformed. Check it in another PDF reader,
              re-download or re-save it if possible, and report this file with the plugin log
              if it opens elsewhere.
            </div>
          ) : null}
          {showPasswordProtectedHint ? (
            <div style={{ marginTop: "6px" }}>
              This PDF appears to be password-protected or encrypted. Unlock it in another
              PDF reader, export an unprotected copy, then add that copy to the PDF folder.
            </div>
          ) : null}
        </div>
      ) : null}

      {!selectedPdf ? (
        <PanelSection>
          <PanelSectionRow>
            <div style={styles.emptyCompact}>
              {busyMessage ||
                (pdfs.length === 0
                  ? "Add PDF, EPUB, TXT, or MD files to the folder above, then refresh."
                  : "Choose a file below.")}
            </div>
          </PanelSectionRow>
          {pdfs.length > 0 ? (
            <PanelSectionRow>
              <div style={styles.fileList}>
                <TextField
                  label="Search files"
                  value={fileFilter}
                  bShowClearAction
                  onChange={(event) => setFileFilter(event.currentTarget.value)}
                />
                <div style={styles.smallText}>
                  Showing {visibleFiles.length} of {filteredFiles.length} matching files
                  from {pdfs.length} supported files.
                </div>
                {visibleFiles.length === 0 ? (
                  <div style={styles.smallText}>No files match this search.</div>
                ) : null}
                {visibleFiles.map((file) => {
                  const failedFile = failedFiles[file.id];
                  const description = `${fileKindLabel(file.kind)} · ${formatBytes(file.sizeBytes)} · ${file.relativePath}${
                    failedFile ? ` · Warning: last open failed (${failedFile.message})` : ""
                  }`;
                  return (
                    <ButtonItem
                      key={file.id}
                      layout="below"
                      icon={failedFile ? <FaExclamationTriangle /> : fileIcon(file.kind)}
                      description={description}
                      onClick={() => selectPdf(file.id)}
                    >
                      {file.name}
                    </ButtonItem>
                  );
                })}
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
                  label="Table of contents"
                  icon={<FaListOl />}
                  disabled={selectedPdf.kind !== "pdf" || !pdfDoc}
                  onClick={toggleContents}
                />
                <IconButton
                  label="Font repair"
                  icon={<FaFont />}
                  disabled={selectedPdf.kind !== "pdf"}
                  onClick={toggleFontRepair}
                />
                <IconButton
                  label="Native page render"
                  icon={<FaImage />}
                  disabled={selectedPdf.kind !== "pdf" || !pdfDoc}
                  onClick={() => void toggleNativeRenderer()}
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
            {useCompatibilityRenderer ? (
              <PanelSectionRow>
                <div style={styles.smallText}>
                  Font repair renderer active for this PDF. If square blocks remain, the
                  PDF likely needs native page rendering.
                </div>
              </PanelSectionRow>
            ) : null}
            {useNativeRenderer ? (
              <PanelSectionRow>
                <div style={styles.smallText}>
                  Native page renderer active for this PDF. This is slower, but can fix
                  PDFs that show square text blocks in the normal renderer.
                </div>
              </PanelSectionRow>
            ) : null}
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
                  label="Zoom button step"
                  description="Changes how much the + and - zoom buttons move each press. This does not change the current zoom by itself."
                  value={Math.round(settings.zoomStep * 100)}
                  min={5}
                  max={100}
                  step={5}
                  valueSuffix="%"
                  showValue
                  onChange={(value) => saveZoomStep(value / 100)}
                />
              </PanelSectionRow>
              <PanelSectionRow>
                <ButtonItem
                  layout="below"
                  icon={<FaFont />}
                  disabled={selectedPdf.kind !== "pdf"}
                  description="Try this when a PDF page shows square blocks instead of text."
                  onClick={toggleFontRepair}
                >
                  Font repair: {useCompatibilityRenderer ? "On" : "Off"}
                </ButtonItem>
              </PanelSectionRow>
              <PanelSectionRow>
                <ButtonItem
                  layout="below"
                  icon={<FaImage />}
                  disabled={selectedPdf.kind !== "pdf" || !pdfDoc}
                  description={`Uses SteamOS PDF rendering when available. Status: ${nativeRendererLabel}.`}
                  onClick={() => void toggleNativeRenderer()}
                >
                  Native page render: {useNativeRenderer ? "On" : "Off"}
                </ButtonItem>
              </PanelSectionRow>
            </PanelSection>
          ) : null}

          {showContents ? (
            <PanelSection title="Contents">
              <PanelSectionRow>
                <div style={styles.smallText}>{tocStatus || "Loading table of contents..."}</div>
              </PanelSectionRow>
              <PanelSectionRow>
                <SliderField
                  label="Jump page"
                  value={jumpPage}
                  min={1}
                  max={Math.max(1, pageCount)}
                  step={1}
                  showValue
                  onChange={(value) => {
                    setJumpPage(clamp(Math.trunc(value), 1, Math.max(1, pageCount)));
                  }}
                />
              </PanelSectionRow>
              <PanelSectionRow>
                <div style={styles.jumpGrid}>
                  <Button
                    disabled={pageCount <= 1}
                    onClick={() => setJumpPage(1)}
                  >
                    First
                  </Button>
                  <Button
                    disabled={pageCount <= 1}
                    onClick={() =>
                      setJumpPage(clamp(jumpPage - 100, 1, Math.max(1, pageCount)))
                    }
                  >
                    -100
                  </Button>
                  <Button
                    disabled={pageCount <= 1}
                    onClick={() =>
                      setJumpPage(clamp(jumpPage - 10, 1, Math.max(1, pageCount)))
                    }
                  >
                    -10
                  </Button>
                  <Button
                    disabled={pageCount <= 1}
                    onClick={() =>
                      setJumpPage(clamp(jumpPage + 10, 1, Math.max(1, pageCount)))
                    }
                  >
                    +10
                  </Button>
                  <Button
                    disabled={pageCount <= 1}
                    onClick={() =>
                      setJumpPage(clamp(jumpPage + 100, 1, Math.max(1, pageCount)))
                    }
                  >
                    +100
                  </Button>
                  <Button
                    disabled={pageCount <= 1}
                    onClick={() => setJumpPage(Math.max(1, pageCount))}
                  >
                    Last
                  </Button>
                </div>
              </PanelSectionRow>
              <PanelSectionRow>
                <ButtonItem
                  layout="inline"
                  icon={<FaArrowRight />}
                  disabled={!pdfDoc || pageCount <= 0}
                  onClick={() => goToPage(jumpPage)}
                >
                  Go to page {jumpPage}
                </ButtonItem>
              </PanelSectionRow>
              <PanelSectionRow>
                <div style={styles.tocList}>
                  {tocItems.length === 0 ? (
                    <div style={styles.smallText}>
                      This PDF does not expose a table of contents. Use page jump above.
                    </div>
                  ) : (
                    tocItems.map((item) => (
                      <ButtonItem
                        key={item.id}
                        layout="below"
                        disabled={item.page === null}
                        description={item.page ? `Page ${item.page}` : "No page target"}
                        onClick={() => {
                          if (item.page !== null) {
                            goToPage(item.page);
                          }
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            paddingLeft: `${Math.min(item.depth, 5) * 12}px`
                          }}
                        >
                          {item.title}
                        </span>
                      </ButtonItem>
                    ))
                  )}
                </div>
              </PanelSectionRow>
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
                  {useNativeRenderer ? (
                    nativePageImage ? (
                      <img
                        alt={`Page ${nativePageImage.page}`}
                        src={nativePageImage.url}
                        style={{
                          ...styles.nativeImage,
                          width: nativeImageCssWidth
                            ? `${nativeImageCssWidth}px`
                            : `${nativePageImage.width}px`
                        }}
                      />
                    ) : null
                  ) : (
                    <canvas
                      ref={canvasRef}
                      style={{
                        ...styles.canvas,
                        visibility: pdfDoc ? "visible" : "hidden"
                      }}
                    />
                  )}
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
