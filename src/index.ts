import "@logseq/libs";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
// LogseqDB Task statuses
type TaskStatus =
  | "Backlog"
  | "Todo"
  | "Doing"
  | "In Review"
  | "Done"
  | "Canceled"
  | "No Status";

interface TaskChildBlock {
  uuid: string;
  content: string;
  html: string;
  status: TaskStatus;
  isTask: boolean;
  children: TaskChildBlock[];
}

interface TaskState {
  uuid: string;
  content: string; // block title text
  pageName: string;
  previousSeconds: number; // accumulated seconds while in Doing
  parentUuid: string | null;
  parentContent: string | null;
  status: TaskStatus;
  doingStartedAt: number | null; // timestamp when task most recently entered Doing; null otherwise
  childBlocks: TaskChildBlock[];
  hasChildBlocks: boolean;
  childrenExpanded: boolean;
}

interface GlobalSessionState {
  startedAt: number | null; // timestamp when ≥1 task entered Doing; null when no Doing tasks
  previousSeconds: number; // accumulated when paused
}

interface PomodoroState {
  phase: "idle" | "focus" | "break" | "paused";
  endTime: number | null; // Timestamp when current phase ends
  pausedRemaining: number; // Seconds remaining when paused
  completedCount: number;
  todayDate: string; // YYYY-MM-DD for daily reset
  pausedPhase: "focus" | "break" | null;
}

type VisibilityMode = "force-show" | "force-hide";

interface UIState {
  visibilityMode: VisibilityMode;
  panelExpanded: boolean;
  posX: number;
  posY: number;
  taskChildrenAreaHeights: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────
// Constants & State
// ─────────────────────────────────────────────────────────────
const LOG_PREFIX = "[pomodoro]";
const DEFAULT_TICK_SECONDS = 5;
const STORAGE_KEY = "logseq-pomodoro-state";
type SoundType =
  | "beep"
  | "ding"
  | "pop"
  | "tap"
  | "pulse"
  | "double"
  | "chime"
  | "bell";
type StatusPickerTarget = "task" | "child";
const SOUND_TYPES: SoundType[] = [
  "beep",
  "ding",
  "pop",
  "tap",
  "pulse",
  "double",
  "chime",
  "bell",
];
const APPEARANCE_SETTING_KEYS = [
  "panelBackgroundColor",
  "darkPanelBackgroundColor",
  "taskFontSize",
  "taskTextColor",
  "darkTaskTextColor",
  "parentFontSize",
  "parentTextColor",
  "timerFontSize",
  "timerTextColor",
  "darkTimerTextColor",
  "taskChildBlockFontSize",
  "showTaskParent",
  "caretPosition",
  "panelScale",
] as const;
const PLUGIN_STATUS_WRITE_IGNORE_MS = 5000;

let trackedTasks: TaskState[] = [];
let trackedTaskByUuid = new Map<string, TaskState>();
let trackedChildBlockByUuid = new Map<string, TaskChildBlock>();
let globalSession: GlobalSessionState = { startedAt: null, previousSeconds: 0 };
let pausedDoingUuids: string[] = [];
let pomodoro: PomodoroState = {
  phase: "idle",
  endTime: null,
  pausedRemaining: 0,
  completedCount: 0,
  todayDate: getTodayDate(),
  pausedPhase: null,
};
let uiState: UIState = {
  visibilityMode: "force-show",
  panelExpanded: false,
  posX: 2,
  posY: 5,
  taskChildrenAreaHeights: {},
};
let taskTimeCache: Record<string, number> = {}; // uuid -> seconds
let tickInterval: ReturnType<typeof setInterval> | null = null;
let activeTickMs: number = DEFAULT_TICK_SECONDS * 1000;
let statusPickerOpenForUuid: string | null = null;
let statusPickerTarget: StatusPickerTarget | null = null;
let statusPickerOpenUpward: boolean = false;
let statusPickerAlignRight: boolean = false;
let statusPickerTop = 0;
let statusPickerLeft = 0;
let statusPickerMaxHeight = 0;
let imagePreviewState: { src: string; title: string } | null = null;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartPosX = 0;
let dragStartPosY = 0;
let taskDragSourceUuid: string | null = null;
let lastRenderTime = 0;
const RENDER_THROTTLE_MS = 50;

let taskTrackingUnsubscribe: (() => void) | null = null;
let currentGraphPathCache: string | null | undefined;

// Per-task suppression prevents plugin-originated DB echoes from hiding real external changes.
const pluginStatusWrites: Record<
  string,
  { status: TaskStatus; expiresAt: number }
> = {};

// ─────────────────────────────────────────────────────────────
// LocalStorage persistence
// ─────────────────────────────────────────────────────────────
function saveStateToStorage() {
  try {
    const tasksToSave = trackedTasks.map((t) => ({
      ...t,
      doingStartedAt: null,
    }));
    const state = {
      trackedTasks: tasksToSave,
      globalSession: {
        previousSeconds: getGlobalSessionSeconds(),
      },
      pomodoro,
      taskTimeCache,
      pausedDoingUuids,
      uiState: {
        posX: uiState.posX,
        posY: uiState.posY,
        visibilityMode: uiState.visibilityMode,
        taskChildrenAreaHeights: uiState.taskChildrenAreaHeights,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {}
}

function loadStateFromStorage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;

    const state = JSON.parse(saved);

    if (state.taskTimeCache) {
      taskTimeCache = state.taskTimeCache;
    }

    // Merge legacy reviewTasks into trackedTasks for migration
    const legacyReview: TaskState[] = Array.isArray(state.reviewTasks)
      ? state.reviewTasks.map((task: any) => {
          const childBlocks = normalizeTaskChildBlocks(task.childBlocks);
          return {
            uuid: task.uuid,
            content: task.content,
            pageName: task.pageName,
            parentUuid: task.parentUuid ?? null,
            parentContent: task.parentContent ?? null,
            status: "In Review" as TaskStatus,
            previousSeconds:
              taskTimeCache[task.uuid] || task.previousSeconds || 0,
            doingStartedAt: null,
            childBlocks,
            hasChildBlocks: taskHasChildBlocks(task, childBlocks),
            childrenExpanded: task.childrenExpanded === true,
          };
        })
      : [];

    if (Array.isArray(state.trackedTasks)) {
      trackedTasks = state.trackedTasks.map((task: any) => {
        const childBlocks = normalizeTaskChildBlocks(task.childBlocks);
        return {
          uuid: task.uuid,
          content: task.content,
          pageName: task.pageName,
          parentUuid: task.parentUuid ?? null,
          parentContent: task.parentContent ?? null,
          status: normalizeTaskStatus(task.status),
          previousSeconds:
            taskTimeCache[task.uuid] || task.previousSeconds || 0,
          doingStartedAt: null,
          childBlocks,
          hasChildBlocks: taskHasChildBlocks(task, childBlocks),
          childrenExpanded: task.childrenExpanded === true,
        };
      });
    }

    // Add legacy review tasks that aren't already in trackedTasks
    for (const reviewTask of legacyReview) {
      if (!trackedTasks.some((t) => t.uuid === reviewTask.uuid)) {
        trackedTasks.push(reviewTask);
      }
    }

    if (state.globalSession) {
      globalSession = {
        startedAt: null,
        previousSeconds: Number(state.globalSession.previousSeconds) || 0,
      };
    } else if (state.taskSession) {
      // Legacy migration
      globalSession = {
        startedAt: null,
        previousSeconds: Number(state.taskSession.previousSeconds) || 0,
      };
    }

    if (Array.isArray(state.pausedDoingUuids)) {
      pausedDoingUuids = state.pausedDoingUuids.filter(
        (u: any) => typeof u === "string",
      );
    }

    if (state.pomodoro) {
      pomodoro = {
        ...state.pomodoro,
        phase:
          state.pomodoro.phase === "focus" || state.pomodoro.phase === "break"
            ? "paused"
            : state.pomodoro.phase,
        pausedPhase:
          state.pomodoro.phase === "focus" || state.pomodoro.phase === "break"
            ? state.pomodoro.phase
            : state.pomodoro.pausedPhase,
        pausedRemaining: state.pomodoro.pausedRemaining || 0,
        endTime: null,
      };
      checkDailyReset();
    }

    if (state.uiState) {
      uiState.posX = state.uiState.posX || 2;
      uiState.posY = state.uiState.posY || 5;
      uiState.visibilityMode = normalizeVisibilityMode(
        state.uiState.visibilityMode,
      );
      uiState.taskChildrenAreaHeights = normalizeTaskChildrenAreaHeights(
        state.uiState.taskChildrenAreaHeights,
      );
    }
    rebuildTrackedTaskIndexes();
  } catch (e) {}
}

function normalizeTaskChildrenAreaHeights(raw: any): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const heights: Record<string, number> = {};
  for (const [uuid, value] of Object.entries(raw)) {
    const height = Number(value);
    if (UUID_RE.test(uuid) && Number.isFinite(height) && height > 0) {
      heights[uuid] = Math.round(height);
    }
  }
  return heights;
}

function normalizeVisibilityMode(raw: any): VisibilityMode {
  return raw === "force-hide" ? "force-hide" : "force-show";
}

function updateTaskTimeCache(uuid: string, seconds: number) {
  taskTimeCache[uuid] = seconds;
  saveStateToStorage();
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function log(...args: unknown[]) {
  console.info(LOG_PREFIX, ...args);
}

function normalizeTaskChildBlocks(raw: any): TaskChildBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((child: any) => {
      const uuid = typeof child?.uuid === "string" ? child.uuid : "";
      const content = typeof child?.content === "string" ? child.content : "";
      const html =
        typeof child?.html === "string"
          ? child.html
          : renderBlockContentHtml(content, uuid);
      const status = normalizeTaskStatus(child?.status);
      if (!uuid && !content && !html) return null;
      return {
        uuid,
        content,
        html,
        status,
        isTask: child?.isTask === true || status !== "No Status",
        children: normalizeTaskChildBlocks(child?.children),
      };
    })
    .filter((child): child is TaskChildBlock => child !== null);
}

function taskHasChildBlocks(
  rawTask: any,
  childBlocks: TaskChildBlock[],
): boolean {
  return rawTask?.hasChildBlocks === true || childBlocks.length > 0;
}

function normalizeTaskStatus(raw: any): TaskStatus {
  const value =
    typeof raw === "string"
      ? raw
      : typeof raw?.name === "string"
        ? raw.name
        : typeof raw?.title === "string"
          ? raw.title
          : typeof raw?.value === "string"
            ? raw.value
            : "";
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, " ");

  switch (normalized) {
    case "backlog":
      return "Backlog";
    case "todo":
    case "to do":
      return "Todo";
    case "doing":
    case "in progress":
    case "active":
      return "Doing";
    case "in review":
    case "review":
      return "In Review";
    case "done":
      return "Done";
    case "canceled":
    case "cancelled":
    case "cancel":
      return "Canceled";
    case "no status":
    case "none":
    case "":
      return "No Status";
    default:
      return "No Status";
  }
}

function rememberPluginStatusWrite(uuid: string, status: TaskStatus) {
  pluginStatusWrites[uuid] = {
    status,
    expiresAt: Date.now() + PLUGIN_STATUS_WRITE_IGNORE_MS,
  };
}

function isRecentPluginStatusWrite(uuid: string, status: TaskStatus): boolean {
  const write = pluginStatusWrites[uuid];
  if (!write) return false;
  if (Date.now() > write.expiresAt) {
    delete pluginStatusWrites[uuid];
    return false;
  }
  return write.status === status;
}

function clearPausedDoingUuid(uuid: string) {
  pausedDoingUuids = pausedDoingUuids.filter((u) => u !== uuid);
}

function markPausedDoingUuid(uuid: string) {
  if (!pausedDoingUuids.includes(uuid)) {
    pausedDoingUuids.push(uuid);
  }
}

function getTodayDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function checkDailyReset() {
  const today = getTodayDate();
  if (pomodoro.todayDate !== today) {
    pomodoro.completedCount = 0;
    pomodoro.todayDate = today;
    saveStateToStorage();
  }
}

function resetTodayPomodoros() {
  pomodoro.completedCount = 0;
  pomodoro.todayDate = getTodayDate();
  saveStateToStorage();
  renderUI(true);
}

function getSettings() {
  const s = (logseq.settings || {}) as Record<string, any>;
  const soundType = (
    SOUND_TYPES.includes(s.soundType) ? s.soundType : "beep"
  ) as SoundType;
  const tickSecondsRaw = Number(s.tickIntervalSeconds);
  const tickIntervalSeconds =
    Number.isFinite(tickSecondsRaw) && tickSecondsRaw >= 1
      ? Math.min(60, Math.floor(tickSecondsRaw))
      : DEFAULT_TICK_SECONDS;
  const soundVolumeRaw = Number(s.soundVolume);
  const soundVolume = Number.isFinite(soundVolumeRaw)
    ? Math.max(0, Math.min(1, soundVolumeRaw))
    : 0.5;
  const panelScaleRaw = Number(s.panelScale);
  const panelScale = Number.isFinite(panelScaleRaw)
    ? Math.max(0.5, Math.min(1, panelScaleRaw))
    : 1;
  return {
    focusMinutes: Number(s.focusMinutes) || 45,
    breakMinutes: Number(s.breakMinutes) || 5,
    soundEnabled: s.soundEnabled !== false,
    soundVolume,
    soundType,
    showCurrentTime: s.showCurrentTime !== false,
    showTaskTime: s.showTaskTime !== false,
    disablePomodoro: s.disablePomodoro === true,
    tickIntervalSeconds,
    alwaysShowPage: s.alwaysShowPage === true,
    showTaskParent: s.showTaskParent === true,
    caretPosition: (s.caretPosition === "start" ? "start" : "end") as
      | "start"
      | "end",
    panelBackgroundColor: normalizeColorSetting(s.panelBackgroundColor),
    darkPanelBackgroundColor: normalizeColorSetting(s.darkPanelBackgroundColor),
    taskFontSize: normalizeFontSizeSetting(s.taskFontSize),
    taskTextColor: normalizeColorSetting(s.taskTextColor),
    darkTaskTextColor: normalizeColorSetting(s.darkTaskTextColor),
    parentFontSize: normalizeFontSizeSetting(s.parentFontSize),
    parentTextColor: normalizeColorSetting(s.parentTextColor),
    timerFontSize: normalizeFontSizeSetting(s.timerFontSize),
    timerTextColor: normalizeColorSetting(s.timerTextColor),
    darkTimerTextColor: normalizeColorSetting(s.darkTimerTextColor),
    taskChildBlockFontSize: normalizeFontSizeSetting(s.taskChildBlockFontSize),
    panelScale,
  };
}

function normalizeColorSetting(value: any): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "unset") return null;
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed) || /^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function normalizeFontSizeSetting(value: any): string | null {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 96
  ) {
    return `${value}px`;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "unset") return null;
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(px|rem|em|%)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 160) return null;
  return `${match[1]}${match[2] || "px"}`;
}

function formatTimeDisplay(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds)
    ? Math.max(0, Math.floor(totalSeconds))
    : 0;
  const h = Math.floor(safeSeconds / 3600);
  const m = Math.floor((safeSeconds % 3600) / 60);
  const s = safeSeconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ─────────────────────────────────────────────────────────────
// Status Icons (matched to Logseq DB native icons)
// ─────────────────────────────────────────────────────────────
const STATUS_PICKER_ORDER: TaskStatus[] = [
  "Backlog",
  "Todo",
  "Doing",
  "In Review",
  "Done",
  "Canceled",
];

const STATUS_COLORS: Record<TaskStatus, string> = {
  Backlog: "#9ca3af",
  Todo: "#6b7280",
  Doing: "#f59e0b",
  "In Review": "#3b82f6",
  Done: "#22c55e",
  Canceled: "#ef4444",
  "No Status": "#6b7280",
};

function getStatusIconSVG(status: TaskStatus): string {
  switch (status) {
    case "Backlog":
      return `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke-width="0" stroke="currentColor"><circle cx="10" cy="10" r="8" stroke-width="2" stroke-dasharray="4 4"></circle></svg>`;
    case "Todo":
      return `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke-width="0" stroke="currentColor"><circle cx="10" cy="10" r="8" stroke-width="2"></circle></svg>`;
    case "Doing":
      return `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke-width="0" stroke="currentColor"><circle cx="10" cy="10" r="8" stroke-width="2"></circle><path d="M10 15C11.3261 15 12.5979 14.4732 13.5355 13.5355C14.4732 12.5979 15 11.3261 15 10C15 8.67392 14.4732 7.40215 13.5355 6.46447C12.5979 5.52678 11.3261 5 10 5L10 10V15Z" fill="currentColor"></path></svg>`;
    case "In Review":
      return `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke-width="0" stroke="currentColor"><circle cx="10" cy="10" r="9" fill="currentColor"></circle><path d="M14 9.5V11C14 11.3978 13.842 11.7794 13.5607 12.0607C13.2794 12.342 12.8978 12.5 12.5 12.5H8L6 14.5V8C6 7.60218 6.15804 7.22064 6.43934 6.93934C6.72064 6.65804 7.10218 6.5 7.5 6.5H11M12.5 6H14.5M14.5 6V8M14.5 6L12 8.5" stroke="white" stroke-width="1.333" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
    case "Done":
      return `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke-width="0" stroke="currentColor"><circle cx="10" cy="10" r="9" fill="currentColor"></circle><path d="M6.5 10L9 12.5L14 7.5" stroke="white" stroke-width="1.333" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
    case "Canceled":
      return `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke-width="0" stroke="currentColor"><circle cx="10" cy="10" r="8" stroke-width="2"></circle><path d="M13 7L7 13M7 7L13 13" stroke="currentColor" stroke-width="1.333" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
    case "No Status":
    default:
      return `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke-width="0" stroke="currentColor"><circle cx="10" cy="10" r="8" stroke-width="2" stroke-dasharray="2 2" opacity="0.5"></circle></svg>`;
  }
}

function formatCurrentTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function getTaskTitle(content: string): string {
  const firstLine = content.split("\n")[0];
  return firstLine
    .replace(/\s*⏱[^\s]*/g, "")
    .replace(/\s*time::[^\s]*/g, "")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hasBlockChildren(block: any): boolean {
  return Array.isArray(block?.children) && block.children.length > 0;
}

function getChildBlockUuid(child: any): string | null {
  if (typeof child?.uuid === "string") return child.uuid;
  if (
    Array.isArray(child) &&
    child[0] === "uuid" &&
    typeof child[1] === "string"
  ) {
    return child[1];
  }
  return null;
}

async function resolveBlockChildEntities(block: any): Promise<any[]> {
  if (!Array.isArray(block?.children)) return [];
  const children: any[] = [];
  for (const child of block.children) {
    if (!child) continue;
    if (!Array.isArray(child)) {
      children.push(child);
      continue;
    }
    const childUuid = getChildBlockUuid(child);
    if (!childUuid) continue;
    const fullChild = await logseq.Editor.getBlock(childUuid, {
      includeChildren: true,
    });
    if (fullChild) children.push(fullChild);
  }
  return children;
}

function findRenderedBlockElement(uuid: string): HTMLElement | null {
  const topDoc = top?.document;
  if (!topDoc) return null;
  const byId = topDoc.getElementById(`ls-block-${uuid}`) as HTMLElement | null;
  if (byId) return byId;
  const byAttr = topDoc.querySelector(
    `.ls-block[blockid="${CSS.escape(uuid)}"]`,
  ) as HTMLElement | null;
  if (byAttr) return byAttr;
  return topDoc
    .querySelector(`[blockid="${CSS.escape(uuid)}"]`)
    ?.closest(".ls-block") as HTMLElement | null;
}

function renderChildImageHtml(
  src: string,
  alt: string,
  title = "",
  sizeAttrs = "",
  blockUuid = "",
): string {
  const blockAttr = blockUuid
    ? ` data-block-uuid="${escapeHtml(blockUuid)}"`
    : "";
  return `<img class="pomodoro-child-image" data-action="openChildImage" data-image-src="${escapeHtml(src)}" data-image-title="${escapeHtml(title || alt || "image")}"${blockAttr} src="${escapeHtml(src)}" alt="${escapeHtml(alt || "image")}" title="${escapeHtml(title || "")}" loading="lazy" ${sizeAttrs} />`;
}

function getRenderedBlockImageHtml(uuid: string): string {
  const blockEl = findRenderedBlockElement(uuid);
  if (!blockEl) return "";
  const ownContent = blockEl.querySelector(
    ":scope > .block-main-container",
  ) as HTMLElement | null;
  const img = (ownContent || blockEl).querySelector(
    ".asset-container img, .asset-block-wrap img, img",
  ) as HTMLImageElement | null;
  if (!img?.src) return "";
  const width = img.getAttribute("width");
  const height = img.getAttribute("height");
  const sizeAttrs = [
    width ? `width="${escapeHtml(width)}"` : "",
    height ? `height="${escapeHtml(height)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return renderChildImageHtml(
    img.src,
    img.alt || img.title || "image",
    img.title || "",
    sizeAttrs,
    uuid,
  );
}

async function getCurrentGraphPath(): Promise<string | null> {
  if (currentGraphPathCache !== undefined) return currentGraphPathCache;
  try {
    const graph = await logseq.App.getCurrentGraph();
    currentGraphPathCache =
      typeof graph?.path === "string" && graph.path ? graph.path : null;
  } catch {
    currentGraphPathCache = null;
  }
  return currentGraphPathCache;
}

function looksLikeAssetTitle(content: string): boolean {
  return /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(content.trim());
}

async function getGraphAssetImageHtml(
  uuid: string,
  content: string,
): Promise<string> {
  if (!uuid || !looksLikeAssetTitle(content)) return "";
  const graphPath = await getCurrentGraphPath();
  if (!graphPath) return "";
  const src = `file://${encodeURI(`${graphPath}/assets/${uuid}.png`)}`;
  return renderChildImageHtml(src, content || "image", content || "", "", uuid);
}

function resolveImageSrc(src: string): string {
  const trimmed = src.trim();
  if (!trimmed) return "";
  if (/^(https?:|file:|data:image\/|blob:|lsp:\/\/)/i.test(trimmed)) {
    return trimmed;
  }
  try {
    const resolver = (logseq as any).resolveResourceFullUrl;
    if (typeof resolver === "function") {
      return resolver.call(logseq, trimmed);
    }
  } catch {
    // Fall back to the original source.
  }
  return trimmed;
}

function renderBlockContentHtml(content: string, blockUuid = ""): string {
  const normalized = content.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";

  const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let html = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = imagePattern.exec(normalized))) {
    const [raw, alt, rawSrc] = match;
    html += escapeHtml(normalized.slice(lastIndex, match.index));
    const src = rawSrc.replace(/\s+"[^"]*"$/, "");
    const resolvedSrc = resolveImageSrc(src);
    if (resolvedSrc) {
      html += renderChildImageHtml(
        resolvedSrc,
        alt || "image",
        alt || "",
        "",
        blockUuid,
      );
    } else {
      html += escapeHtml(raw);
    }
    lastIndex = match.index + raw.length;
  }

  html += escapeHtml(normalized.slice(lastIndex));
  return html.replace(/\n/g, "<br>");
}

async function buildTaskChildBlock(block: any): Promise<TaskChildBlock | null> {
  const content = getBlockTitle(block).trim();
  if (!content || content.startsWith("🍅")) return null;
  const uuid = typeof block?.uuid === "string" ? block.uuid : "";
  const contentHtml = renderBlockContentHtml(content, uuid);
  const imageHtml =
    (uuid ? getRenderedBlockImageHtml(uuid) : "") ||
    (await getGraphAssetImageHtml(uuid, content));
  const childBlocks = await Promise.all(
    (await resolveBlockChildEntities(block)).map(buildTaskChildBlock),
  );
  const children = childBlocks.filter(
    (child): child is TaskChildBlock => child !== null,
  );
  const status = uuid
    ? await resolveBlockStatus(uuid, block as any)
    : "No Status";

  return {
    uuid,
    content,
    html: imageHtml
      ? `${imageHtml}${contentHtml ? `<div class="pomodoro-child-caption">${contentHtml}</div>` : ""}`
      : contentHtml,
    status,
    isTask: status !== "No Status",
    children,
  };
}

async function loadTaskChildBlocks(uuid: string): Promise<TaskChildBlock[]> {
  try {
    const blockWithChildren =
      (await logseq.Editor.getBlock(uuid, { includeChildren: true })) ??
      (await logseq.Editor.getBlockTreeByBlockUuid(uuid));
    const childBlocks = await Promise.all(
      (await resolveBlockChildEntities(blockWithChildren)).map(
        buildTaskChildBlock,
      ),
    );
    return childBlocks.filter(
      (child): child is TaskChildBlock => child !== null,
    );
  } catch (e) {
    log("Failed to load child blocks for", uuid, e);
  }
  return [];
}

function shouldShowPanel(): boolean {
  if (uiState.visibilityMode === "force-hide") return false;
  return true;
}

function getBlockStatus(block: Record<string, any>): TaskStatus {
  // LogseqDB stores properties as namespaced keys on the block object
  const status =
    block[":logseq.property/status"] ??
    block.properties?.[":logseq.property/status"] ??
    block.properties?.status ??
    block.properties?.Status;
  return normalizeTaskStatus(status);
}

async function resolveBlockStatus(
  uuid: string,
  block?: Record<string, any>,
): Promise<TaskStatus> {
  // getBlock returns :logseq.property/status as a ref {id: N}, not the string value.
  // getBlockProperties resolves refs to actual strings.
  const props = await logseq.Editor.getBlockProperties(uuid);
  const status =
    (props as any)?.[":logseq.property/status"] ??
    (props as any)?.status ??
    (props as any)?.Status;
  const normalized = normalizeTaskStatus(status);
  if (normalized !== "No Status") return normalized;
  // Fallback to block object
  if (block) return getBlockStatus(block);
  return "No Status";
}

function getBlockTitle(block: { title?: string; content?: string }): string {
  return block.title || block.content || "";
}

function indexChildBlocks(blocks: TaskChildBlock[]) {
  for (const block of blocks) {
    if (block.uuid) {
      trackedChildBlockByUuid.set(block.uuid, block);
    }
    indexChildBlocks(block.children);
  }
}

function rebuildTrackedTaskIndexes() {
  trackedTaskByUuid = new Map<string, TaskState>();
  trackedChildBlockByUuid = new Map<string, TaskChildBlock>();
  for (const task of trackedTasks) {
    trackedTaskByUuid.set(task.uuid, task);
    indexChildBlocks(task.childBlocks);
  }
}

function findTrackedTask(uuid: string): TaskState | undefined {
  return trackedTaskByUuid.get(uuid);
}

function findKnownTask(uuid: string): TaskState | undefined {
  return findTrackedTask(uuid);
}

function getPrimaryTask(): TaskState | null {
  return trackedTasks.length > 0 ? trackedTasks[0] : null;
}

function findChildBlock(uuid: string): TaskChildBlock | undefined {
  return trackedChildBlockByUuid.get(uuid);
}

type StatusSection =
  | "active"
  | "todo"
  | "review"
  | "backlog"
  | "done"
  | "canceled";

function isPausedActiveTask(task: TaskState): boolean {
  return task.status === "Todo" && pausedDoingUuids.includes(task.uuid);
}

function getStatusSection(task: TaskState): StatusSection {
  if (task.status === "Doing" || isPausedActiveTask(task)) return "active";
  if (task.status === "Todo") return "todo";
  if (task.status === "In Review") return "review";
  if (task.status === "Done") return "done";
  if (task.status === "Canceled") return "canceled";
  return "backlog";
}

function hasAnyDoingTask(): boolean {
  return trackedTasks.some((t) => t.status === "Doing");
}

function hasActivePomodoroTimer(): boolean {
  return (
    !getSettings().disablePomodoro &&
    (pomodoro.phase === "focus" || pomodoro.phase === "break")
  );
}

function shouldRunMainTick(): boolean {
  return hasActivePomodoroTimer() || hasAnyDoingTask();
}

function syncMainTicking() {
  if (shouldRunMainTick()) {
    startTicking();
  } else {
    stopTicking();
  }
}

function resumeDoingTimersFromState() {
  let hasDoing = false;
  for (const task of trackedTasks) {
    if (task.status !== "Doing") continue;
    hasDoing = true;
    if (!task.doingStartedAt) {
      task.doingStartedAt = Date.now();
    }
  }
  if (hasDoing) {
    startGlobalSessionIfNeeded();
  }
}

function getGlobalSessionSeconds(): number {
  const live = globalSession.startedAt
    ? Math.floor((Date.now() - globalSession.startedAt) / 1000)
    : 0;
  return globalSession.previousSeconds + live;
}

function startGlobalSessionIfNeeded() {
  if (!globalSession.startedAt && hasAnyDoingTask()) {
    globalSession.startedAt = Date.now();
  }
}

function pauseGlobalSessionIfNoDoing() {
  if (globalSession.startedAt && !hasAnyDoingTask()) {
    globalSession.previousSeconds = getGlobalSessionSeconds();
    globalSession.startedAt = null;
  }
}

function getTaskElapsedSeconds(task: TaskState): number {
  const live = task.doingStartedAt
    ? Math.floor((Date.now() - task.doingStartedAt) / 1000)
    : 0;
  return task.previousSeconds + live;
}

function flushTaskTimeForTaskLeavingDoing(task: TaskState) {
  if (!task.doingStartedAt) return;
  const elapsed = Math.floor((Date.now() - task.doingStartedAt) / 1000);
  task.previousSeconds += elapsed;
  task.doingStartedAt = null;
  updateTaskTimeCache(task.uuid, task.previousSeconds);
}

function applyStatusTransition(task: TaskState, newStatus: TaskStatus) {
  newStatus = normalizeTaskStatus(newStatus);
  const oldStatus = task.status;
  if (oldStatus === newStatus) return;
  if (oldStatus === "Doing" && newStatus !== "Doing") {
    flushTaskTimeForTaskLeavingDoing(task);
  }
  task.status = newStatus;
  if (newStatus === "Doing" && !task.doingStartedAt) {
    clearPausedDoingUuid(task.uuid);
    task.doingStartedAt = Date.now();
    startGlobalSessionIfNeeded();
  } else if (newStatus !== "Todo") {
    clearPausedDoingUuid(task.uuid);
  }
  if (oldStatus === "Doing" && newStatus !== "Doing") {
    pauseGlobalSessionIfNoDoing();
  }
}

// ─────────────────────────────────────────────────────────────
// WebAudio Beep
// ─────────────────────────────────────────────────────────────
let audioCtx: AudioContext | null = null;

interface ToneSpec {
  freq: number;
  durationMs: number;
  type?: OscillatorType;
  decay?: boolean;
  gapMs?: number;
}

function playToneSequence(
  tones: ToneSpec[],
  options: { ignoreEnabled?: boolean } = {},
) {
  const { soundEnabled, soundVolume } = getSettings();
  if ((!soundEnabled && !options.ignoreEnabled) || tones.length === 0) return;
  if (soundVolume <= 0) return;

  if (!audioCtx) {
    audioCtx = new (
      window.AudioContext || (window as any).webkitAudioContext
    )();
  }
  const ctx = audioCtx;
  if (ctx.state === "suspended") {
    void ctx.resume();
  }

  let delay = 0;
  for (const tone of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tone.type || "triangle";
    osc.frequency.value = tone.freq;
    const start = ctx.currentTime + delay / 1000;
    if (tone.decay) {
      gain.gain.setValueAtTime(soundVolume, start);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        start + tone.durationMs / 1000,
      );
    } else {
      gain.gain.value = soundVolume;
    }
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + tone.durationMs / 1000);
    delay += tone.durationMs + (tone.gapMs ?? 100);
  }
}

function getFocusEndTones(soundType: SoundType): ToneSpec[] {
  switch (soundType) {
    case "ding":
      return [{ freq: 1320, durationMs: 280, type: "sine", decay: true }];
    case "pop":
      return [{ freq: 620, durationMs: 90, type: "square", decay: true }];
    case "tap":
      return [{ freq: 980, durationMs: 70, type: "triangle", decay: true }];
    case "pulse":
      return [
        { freq: 660, durationMs: 90, type: "sine", gapMs: 45 },
        { freq: 880, durationMs: 120, type: "sine", decay: true },
      ];
    case "double":
      return [
        { freq: 880, durationMs: 110, gapMs: 55 },
        { freq: 1175, durationMs: 140, type: "sine", decay: true },
      ];
    case "chime":
      return [
        { freq: 523, durationMs: 130, type: "sine", gapMs: 25 },
        { freq: 659, durationMs: 130, type: "sine", gapMs: 25 },
        { freq: 784, durationMs: 220, type: "sine", decay: true },
      ];
    case "bell":
      return [{ freq: 1200, durationMs: 420, type: "sine", decay: true }];
    case "beep":
    default:
      return [
        { freq: 880, durationMs: 130 },
        { freq: 880, durationMs: 130 },
      ];
  }
}

function getBreakEndTones(soundType: SoundType): ToneSpec[] {
  switch (soundType) {
    case "ding":
      return [{ freq: 880, durationMs: 260, type: "sine", decay: true }];
    case "pop":
      return [{ freq: 420, durationMs: 90, type: "square", decay: true }];
    case "tap":
      return [{ freq: 740, durationMs: 70, type: "triangle", decay: true }];
    case "pulse":
      return [
        { freq: 520, durationMs: 90, type: "sine", gapMs: 45 },
        { freq: 660, durationMs: 120, type: "sine", decay: true },
      ];
    case "double":
      return [
        { freq: 660, durationMs: 110, gapMs: 55 },
        { freq: 880, durationMs: 140, type: "sine", decay: true },
      ];
    case "chime":
      return [
        { freq: 784, durationMs: 130, type: "sine", gapMs: 25 },
        { freq: 659, durationMs: 130, type: "sine", gapMs: 25 },
        { freq: 523, durationMs: 220, type: "sine", decay: true },
      ];
    case "bell":
      return [{ freq: 600, durationMs: 420, type: "sine", decay: true }];
    case "beep":
    default:
      return [
        { freq: 440, durationMs: 150 },
        { freq: 440, durationMs: 150 },
      ];
  }
}

function playFocusEndSound(options: { ignoreEnabled?: boolean } = {}) {
  playToneSequence(getFocusEndTones(getSettings().soundType), options);
}

function playBreakEndSound(options: { ignoreEnabled?: boolean } = {}) {
  playToneSequence(getBreakEndTones(getSettings().soundType), options);
}

// ─────────────────────────────────────────────────────────────
// Pomodoro Icons
// ─────────────────────────────────────────────────────────────
async function addPomodoroIcon() {
  const newCount = pomodoro.completedCount;
  const icons = "🍅".repeat(newCount);
  if (trackedTasks.length === 0) return;

  for (const task of trackedTasks) {
    const block = await logseq.Editor.getBlock(task.uuid);
    if (!block) continue;

    const children = await logseq.Editor.getBlockTreeByBlockUuid(task.uuid);
    const childBlocks = children?.children || [];

    let pomodoroBlock = childBlocks.find(
      (c: any) => typeof c.content === "string" && c.content.startsWith("🍅"),
    );

    if (pomodoroBlock) {
      await logseq.Editor.updateBlock(pomodoroBlock.uuid, icons);
    } else {
      await logseq.Editor.insertBlock(task.uuid, icons, { sibling: false });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Timer Logic
// ─────────────────────────────────────────────────────────────
function roundTo5(seconds: number): number {
  return Math.round(seconds / 5) * 5;
}

function getPomodoroRemaining(): number {
  if (!pomodoro.endTime) return 0;
  if (pomodoro.phase === "paused") return roundTo5(pomodoro.pausedRemaining);
  return roundTo5(
    Math.max(0, Math.ceil((pomodoro.endTime - Date.now()) / 1000)),
  );
}

function startTicking() {
  const desiredMs = getSettings().tickIntervalSeconds * 1000;
  if (tickInterval && activeTickMs === desiredMs) return;
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  activeTickMs = desiredMs;
  tickInterval = setInterval(() => {
    void tick();
  }, desiredMs);
}

function stopTicking() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

function restartTickingIfRunning() {
  if (!tickInterval) return;
  const desiredMs = getSettings().tickIntervalSeconds * 1000;
  if (desiredMs === activeTickMs) return;
  clearInterval(tickInterval);
  activeTickMs = desiredMs;
  tickInterval = setInterval(() => {
    void tick();
  }, desiredMs);
}

let currentTimeInterval: ReturnType<typeof setInterval> | null = null;
let activeCurrentTimeMs = DEFAULT_TICK_SECONDS * 1000;

function manageCurrentTimeInterval() {
  const { showCurrentTime, tickIntervalSeconds } = getSettings();
  const desiredMs = tickIntervalSeconds * 1000;

  if (!showCurrentTime) {
    if (currentTimeInterval) {
      clearInterval(currentTimeInterval);
      currentTimeInterval = null;
    }
    return;
  }

  if (currentTimeInterval && desiredMs === activeCurrentTimeMs) return;
  if (currentTimeInterval) clearInterval(currentTimeInterval);
  activeCurrentTimeMs = desiredMs;
  currentTimeInterval = setInterval(() => {
    const topDoc = top?.document;
    if (!topDoc) return;
    const el = topDoc.getElementById("pomo-current-time");
    if (el) el.textContent = formatCurrentTime();
  }, desiredMs);
}

async function pauseDoingTasksForPomodoro() {
  const doingTasks = trackedTasks.filter((task) => task.status === "Doing");
  pausedDoingUuids = doingTasks.map((task) => task.uuid);
  for (const task of doingTasks) {
    await updateTaskStatusForTask(task, "Todo", { keepPausedActive: true });
  }
}

async function restorePausedDoingTasks() {
  const toResume = pausedDoingUuids.slice();
  pausedDoingUuids = [];
  for (const uuid of toResume) {
    const task = findTrackedTask(uuid);
    if (task) await updateTaskStatusForTask(task, "Doing");
  }
}

async function tick() {
  checkDailyReset();
  if (
    !getSettings().disablePomodoro &&
    (pomodoro.phase === "focus" || pomodoro.phase === "break") &&
    pomodoro.endTime
  ) {
    const remaining = Math.ceil((pomodoro.endTime - Date.now()) / 1000);
    if (remaining <= 0) {
      if (pomodoro.phase === "focus") {
        playFocusEndSound();
        pomodoro.completedCount++;
        void addPomodoroIcon();
        logseq.UI.showMsg(
          `🍅 Focus session complete! Take a ${getSettings().breakMinutes}m break.`,
          "success",
          { timeout: 10000 },
        );
        pomodoro.phase = "break";
        pomodoro.endTime = Date.now() + getSettings().breakMinutes * 60 * 1000;
        await pauseDoingTasksForPomodoro();
        saveStateToStorage();
      } else {
        playBreakEndSound();
        logseq.UI.showMsg("Break over! Ready for next focus session.", "info", {
          timeout: 10000,
        });
        startFreshFocusPhase();
        await restorePausedDoingTasks();
        saveStateToStorage();
      }
    }
  }
  renderUI();
}

// ─────────────────────────────────────────────────────────────
// Task Tracking
// ─────────────────────────────────────────────────────────────
function resetGlobalSession() {
  globalSession.startedAt = hasAnyDoingTask() ? Date.now() : null;
  globalSession.previousSeconds = 0;
}

function pauseGlobalSession() {
  if (globalSession.startedAt) {
    globalSession.previousSeconds = getGlobalSessionSeconds();
    globalSession.startedAt = null;
  }
}

function startGlobalSession() {
  if (!globalSession.startedAt) {
    globalSession.startedAt = Date.now();
  }
}

async function buildTaskState(uuid: string): Promise<TaskState | null> {
  const block = await logseq.Editor.getBlock(uuid, { includeChildren: true });
  if (!block) return null;
  const childBlocks = await loadTaskChildBlocks(uuid);

  const page = await logseq.Editor.getPage(block.page.id);
  const pageName = page?.name || page?.originalName || "Unknown";

  // Get parent block if exists
  let parentUuid: string | null = null;
  let parentContent: string | null = null;
  if (block.parent && block.parent.id !== block.page.id) {
    const parentBlock = await logseq.Editor.getBlock(block.parent.id);
    if (parentBlock) {
      parentUuid = parentBlock.uuid;
      parentContent = getBlockTitle(parentBlock);
    }
  }

  return {
    uuid,
    content: getBlockTitle(block),
    pageName,
    previousSeconds: taskTimeCache[uuid] || 0,
    parentUuid,
    parentContent,
    status: await resolveBlockStatus(uuid, block as any),
    doingStartedAt: null,
    childBlocks,
    hasChildBlocks: hasBlockChildren(block) || childBlocks.length > 0,
    childrenExpanded: false,
  };
}

async function updateTaskStatusForTask(
  task: TaskState,
  status: TaskStatus,
  options: { keepPausedActive?: boolean } = {},
): Promise<void> {
  status = normalizeTaskStatus(status);
  if (status === "Todo" && options.keepPausedActive) {
    markPausedDoingUuid(task.uuid);
  } else {
    clearPausedDoingUuid(task.uuid);
  }
  rememberPluginStatusWrite(task.uuid, status);
  try {
    await logseq.Editor.upsertBlockProperty(
      task.uuid,
      ":logseq.property/status",
      status,
    );
    log(
      "upsertBlockProperty with ident key succeeded for",
      task.uuid,
      "->",
      status,
    );
  } catch (e) {
    log("upsertBlockProperty with ident key failed:", e);
  }
  applyStatusTransition(task, status);
}

function getPhaseDurationSeconds(
  phase: "focus" | "break",
  settings = getSettings(),
): number {
  return (
    (phase === "break" ? settings.breakMinutes : settings.focusMinutes) * 60
  );
}

function startFreshFocusPhase() {
  const settings = getSettings();
  checkDailyReset();
  pomodoro.phase = "focus";
  pomodoro.endTime = settings.disablePomodoro
    ? null
    : Date.now() + getPhaseDurationSeconds("focus", settings) * 1000;
  pomodoro.pausedRemaining = 0;
  pomodoro.pausedPhase = null;
}

function startPomodoro() {
  if (getSettings().disablePomodoro) return;
  if (pomodoro.phase !== "idle") return;
  pausedDoingUuids = [];
  startFreshFocusPhase();
  startTicking();
  saveStateToStorage();
  renderUI(true);
}

function updatePomodoroTimerForVisibility() {
  const settings = getSettings();
  if (settings.disablePomodoro) {
    if (pomodoro.phase === "focus" || pomodoro.phase === "break") {
      pomodoro.endTime = null;
    }
    return;
  }

  if (
    (pomodoro.phase === "focus" || pomodoro.phase === "break") &&
    !pomodoro.endTime
  ) {
    pomodoro.endTime =
      Date.now() + getPhaseDurationSeconds(pomodoro.phase, settings) * 1000;
  }
}

async function startTracking(
  uuid: string,
  options: { setStatus?: TaskStatus } = {},
) {
  const existing = findTrackedTask(uuid);
  if (existing) {
    if (existing.childBlocks.length === 0) {
      await refreshTaskChildren(existing);
    }
    if (options.setStatus) {
      await updateTaskStatusForTask(existing, options.setStatus);
    }
    syncMainTicking();
    saveStateToStorage();
    renderUI(true);
    return;
  }

  const task = await buildTaskState(uuid);
  if (!task) return;

  task.previousSeconds = taskTimeCache[uuid] || task.previousSeconds || 0;
  task.doingStartedAt = null;
  trackedTasks.push(task);
  uiState.panelExpanded = true;
  rebuildTrackedTaskIndexes();

  if (options.setStatus) {
    await updateTaskStatusForTask(task, options.setStatus);
  } else if (task.status === "Doing" && !task.doingStartedAt) {
    task.doingStartedAt = Date.now();
    startGlobalSessionIfNeeded();
  }

  syncMainTicking();
  saveStateToStorage();
  renderUI(true);
}

async function stopTracking(uuid?: string) {
  const targetUuids = uuid ? [uuid] : trackedTasks.map((task) => task.uuid);

  for (const u of targetUuids) {
    const task = findTrackedTask(u);
    if (!task) continue;
    if (task.status === "Doing") {
      flushTaskTimeForTaskLeavingDoing(task);
    }
  }

  const removeSet = new Set(targetUuids);
  trackedTasks = trackedTasks.filter((task) => !removeSet.has(task.uuid));
  rebuildTrackedTaskIndexes();
  pausedDoingUuids = pausedDoingUuids.filter((uuid) => !removeSet.has(uuid));

  pauseGlobalSessionIfNoDoing();

  syncMainTicking();
  saveStateToStorage();
  renderUI(true);
}

function removeTrackedOrReviewTask(uuid: string) {
  if (findTrackedTask(uuid)) {
    void stopTracking(uuid);
  }
}

async function finishTask() {
  if (trackedTasks.length === 0) return;
  await setTaskStatus("Done");
  pomodoro = {
    phase: "idle",
    endTime: null,
    pausedRemaining: 0,
    completedCount: pomodoro.completedCount,
    todayDate: pomodoro.todayDate,
    pausedPhase: null,
  };
  stopTicking();
  renderUI(true);
  logseq.UI.showMsg("Task completed! 🎉", "success");
}

async function pausePomodoro() {
  if (getSettings().disablePomodoro) {
    if (!hasAnyDoingTask()) return;
    await pauseDoingTasksForPomodoro();
    syncMainTicking();
    saveStateToStorage();
    renderUI(true);
    return;
  }

  if (pomodoro.phase === "focus") {
    pomodoro.pausedRemaining = getPomodoroRemaining();
    pomodoro.pausedPhase = pomodoro.phase;
    pomodoro.phase = "paused";

    await pauseDoingTasksForPomodoro();

    saveStateToStorage();
    renderUI(true);
  }
}

async function resumePomodoro() {
  if (getSettings().disablePomodoro) {
    await restorePausedDoingTasks();
    syncMainTicking();
    saveStateToStorage();
    renderUI(true);
    return;
  }

  if (pomodoro.phase === "break") {
    startFreshFocusPhase();
    await restorePausedDoingTasks();
    startTicking();

    saveStateToStorage();
    renderUI(true);
    return;
  }

  if (pomodoro.phase === "paused" && pomodoro.pausedPhase) {
    const settings = getSettings();
    const nextPhase = pomodoro.pausedPhase;
    const remaining =
      pomodoro.pausedRemaining > 0
        ? pomodoro.pausedRemaining
        : getPhaseDurationSeconds(nextPhase, settings);
    pomodoro.phase = nextPhase;
    pomodoro.endTime = settings.disablePomodoro
      ? null
      : Date.now() + remaining * 1000;
    pomodoro.pausedRemaining = 0;
    pomodoro.pausedPhase = null;

    await restorePausedDoingTasks();
    startTicking();

    saveStateToStorage();
    renderUI(true);
  }
}

function resetPomodoro() {
  pomodoro = {
    phase: "idle",
    endTime: null,
    pausedRemaining: 0,
    completedCount: pomodoro.completedCount,
    todayDate: pomodoro.todayDate,
    pausedPhase: null,
  };
  pausedDoingUuids = [];
  syncMainTicking();
  saveStateToStorage();
  renderUI(true);
  logseq.UI.showMsg("Pomodoro timer reset.", "info");
}

function resetTask() {
  for (const task of trackedTasks) {
    task.previousSeconds = 0;
    if (task.status === "Doing") {
      task.doingStartedAt = Date.now();
    }
    updateTaskTimeCache(task.uuid, 0);
  }
  globalSession.previousSeconds = 0;
  globalSession.startedAt = hasAnyDoingTask() ? Date.now() : null;
  syncMainTicking();
  saveStateToStorage();
  renderUI(true);
  logseq.UI.showMsg("Task timer reset.", "info");
}

async function setTaskStatus(status: TaskStatus) {
  if (trackedTasks.length === 0) return;
  for (const task of [...trackedTasks]) {
    await updateTaskStatusForTask(task, status);
  }

  syncMainTicking();
  saveStateToStorage();
  renderUI(true);
}

function updateChildStatusInBlocks(
  blocks: TaskChildBlock[],
  uuid: string,
  status: TaskStatus,
): boolean {
  let changed = false;
  for (const block of blocks) {
    if (block.uuid === uuid) {
      block.status = status;
      block.isTask = status !== "No Status";
      changed = true;
    }
    if (updateChildStatusInBlocks(block.children, uuid, status)) {
      changed = true;
    }
  }
  return changed;
}

async function setChildTaskStatus(
  uuid: string,
  status: TaskStatus,
): Promise<void> {
  statusPickerOpenForUuid = null;
  statusPickerTarget = null;
  status = normalizeTaskStatus(status);
  const child = findChildBlock(uuid);
  if (!child?.isTask) {
    renderUI(true);
    return;
  }
  try {
    await logseq.Editor.upsertBlockProperty(
      uuid,
      ":logseq.property/status",
      status,
    );
    log("child upsertBlockProperty succeeded for", uuid, "->", status);
  } catch (e) {
    log("child upsertBlockProperty failed:", e);
  }

  for (const task of trackedTasks) {
    updateChildStatusInBlocks(task.childBlocks, uuid, status);
  }

  saveStateToStorage();
  renderUI(true);
}

function findRenderedBlockImage(
  uuid: string,
  src?: string,
): HTMLImageElement | null {
  const blockEl = findRenderedBlockElement(uuid);
  if (!blockEl) return null;
  const images = Array.from(
    blockEl.querySelectorAll(
      ".asset-container img, .asset-block-wrap img, img",
    ),
  ) as HTMLImageElement[];
  if (!src) return images[0] || null;
  return (
    images.find((img) => img.src === src || img.getAttribute("src") === src) ||
    images[0] ||
    null
  );
}

function getFilePathFromImageSrc(src: string): string {
  try {
    const url = new URL(src);
    if (url.protocol !== "file:") return "";
    return decodeURIComponent(url.pathname);
  } catch {
    return "";
  }
}

async function tryOpenImageWithLogseqAssets(src: string): Promise<boolean> {
  const assets = (logseq as any).Assets;
  if (typeof assets?.builtInOpen !== "function") return false;
  const filePath = getFilePathFromImageSrc(src);
  if (!filePath) return false;
  const graphPath = await getCurrentGraphPath();
  const candidates = [filePath];
  if (graphPath && filePath.startsWith(`${graphPath}/`)) {
    candidates.unshift(filePath.slice(graphPath.length + 1));
  }
  for (const candidate of candidates) {
    try {
      if (await assets.builtInOpen(candidate)) return true;
    } catch (e) {
      log("Asset native open failed for", candidate, e);
    }
  }
  return false;
}

async function openChildImage(
  src: string,
  title = "",
  blockUuid = "",
): Promise<void> {
  if (blockUuid) {
    const nativeImage = findRenderedBlockImage(blockUuid, src);
    if (nativeImage) {
      nativeImage.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: top || window,
        }),
      );
      return;
    }
  }

  if (await tryOpenImageWithLogseqAssets(src)) return;

  imagePreviewState = { src, title: title || "Image preview" };
  renderUI(true);
}

function closeImagePreview() {
  if (!imagePreviewState) return;
  imagePreviewState = null;
  renderUI(true);
}

async function navigateToBlock(blockUuid: string, openInSidebar: boolean) {
  if (openInSidebar) {
    await logseq.Editor.openInRightSidebar(blockUuid);
  } else {
    // LogseqDB: use pushState with block UUID directly
    (logseq.App as any).pushState("page", { name: blockUuid });
  }
}

async function navigateToPage(pageName: string, openInSidebar: boolean) {
  const page = await logseq.Editor.getPage(pageName);
  if (!page) return;
  if (openInSidebar) {
    await logseq.Editor.openInRightSidebar(page.uuid);
  } else {
    await (logseq.App as any).pushState("page", { name: pageName });
  }
}

async function openTaskPage(openInSidebar = false, uuid?: string) {
  const task = uuid ? findKnownTask(uuid) : getPrimaryTask();
  if (!task) return;
  await navigateToBlock(task.uuid, openInSidebar);
}

async function openParentPage(openInSidebar = false, uuid?: string) {
  const task = uuid ? findKnownTask(uuid) : getPrimaryTask();
  if (!task) return;

  if (task.parentUuid) {
    await navigateToBlock(task.parentUuid, openInSidebar);
  } else {
    await navigateToPage(task.pageName, openInSidebar);
  }
}

async function openPage(openInSidebar = false, uuid?: string) {
  const task = uuid ? findKnownTask(uuid) : getPrimaryTask();
  if (!task) return;
  await navigateToPage(task.pageName, openInSidebar);
}

function togglePanel() {
  uiState.panelExpanded = !uiState.panelExpanded;
  renderUI();
}

async function refreshTaskChildren(task: TaskState): Promise<void> {
  const block = await logseq.Editor.getBlock(task.uuid, {
    includeChildren: true,
  });
  task.childBlocks = await loadTaskChildBlocks(task.uuid);
  task.hasChildBlocks = hasBlockChildren(block) || task.childBlocks.length > 0;
  rebuildTrackedTaskIndexes();
}

async function refreshTrackedTaskChildren(): Promise<void> {
  let changed = false;
  for (const task of trackedTasks) {
    if (task.childBlocks.length > 0) continue;
    const previousSignature = `${task.hasChildBlocks}:${task.childBlocks.length}`;
    await refreshTaskChildren(task);
    const nextSignature = `${task.hasChildBlocks}:${task.childBlocks.length}`;
    if (previousSignature !== nextSignature) {
      changed = true;
    }
  }
  if (changed) {
    saveStateToStorage();
    renderUI(true);
  }
}

async function toggleTaskChildren(uuid: string): Promise<void> {
  const task = findTrackedTask(uuid);
  if (!task) return;
  const wasExpanded = task.childrenExpanded;
  await refreshTaskChildren(task);
  if (task.childBlocks.length === 0) return;
  task.childrenExpanded = !wasExpanded;
  saveStateToStorage();
  renderUI(true);
}

function decidePickerDirection(
  uuid: string,
  targetType?: StatusPickerTarget,
  anchorEl?: HTMLElement | null,
) {
  const topDoc = top?.document;
  if (!topDoc) {
    statusPickerOpenUpward = true;
    statusPickerAlignRight = false;
    statusPickerTop = 8;
    statusPickerLeft = 8;
    statusPickerMaxHeight = 0;
    return;
  }
  const targetSelector = targetType
    ? `[data-status-target="${targetType}"]`
    : "";
  const anchoredBtn = anchorEl?.closest(
    `.pomodoro-status-icon[data-task-uuid="${CSS.escape(uuid)}"]${targetSelector}`,
  ) as HTMLElement | null;
  const btn =
    anchoredBtn ||
    (topDoc.querySelector(
      `.pomodoro-status-icon[data-task-uuid="${CSS.escape(uuid)}"]${targetSelector}`,
    ) as HTMLElement | null);
  if (!btn) {
    statusPickerOpenUpward = true;
    statusPickerAlignRight = false;
    statusPickerTop = 8;
    statusPickerLeft = 8;
    statusPickerMaxHeight = 0;
    return;
  }
  const rect = btn.getBoundingClientRect();
  const viewportHeight = topDoc.documentElement.clientHeight;
  const viewportWidth = topDoc.documentElement.clientWidth;
  const PICKER_HEIGHT = 178;
  const PICKER_WIDTH = 150;
  const SAFE_MARGIN = 8;
  const GAP = 4;
  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(Math.max(min, max), value));
  const spaceBelow = viewportHeight - rect.bottom - SAFE_MARGIN;
  const spaceAbove = rect.top - SAFE_MARGIN;
  statusPickerOpenUpward =
    spaceBelow < PICKER_HEIGHT && spaceAbove > spaceBelow;
  statusPickerAlignRight = viewportWidth - rect.left < PICKER_WIDTH;
  const availableHeight =
    (statusPickerOpenUpward ? spaceAbove : spaceBelow) - GAP;
  statusPickerMaxHeight = clamp(
    Math.min(PICKER_HEIGHT, availableHeight),
    96,
    PICKER_HEIGHT,
  );
  statusPickerTop = statusPickerOpenUpward
    ? clamp(
        rect.top - statusPickerMaxHeight - GAP,
        SAFE_MARGIN,
        viewportHeight - statusPickerMaxHeight - SAFE_MARGIN,
      )
    : clamp(
        rect.bottom + GAP,
        SAFE_MARGIN,
        viewportHeight - statusPickerMaxHeight - SAFE_MARGIN,
      );
  statusPickerLeft = statusPickerAlignRight
    ? clamp(
        rect.right - PICKER_WIDTH,
        SAFE_MARGIN,
        viewportWidth - PICKER_WIDTH - SAFE_MARGIN,
      )
    : clamp(rect.left, SAFE_MARGIN, viewportWidth - PICKER_WIDTH - SAFE_MARGIN);
}

function toggleStatusPicker(
  uuid: string,
  targetType: StatusPickerTarget,
  anchorEl?: HTMLElement | null,
) {
  if (statusPickerOpenForUuid === uuid && statusPickerTarget === targetType) {
    statusPickerOpenForUuid = null;
    statusPickerTarget = null;
  } else {
    decidePickerDirection(uuid, targetType, anchorEl);
    statusPickerOpenForUuid = uuid;
    statusPickerTarget = targetType;
  }
  renderUI(true);
}

function closeStatusPicker() {
  if (statusPickerOpenForUuid === null) return;
  statusPickerOpenForUuid = null;
  statusPickerTarget = null;
  renderUI(true);
}

async function setTaskStatusForSingle(
  uuid: string,
  status: TaskStatus,
): Promise<void> {
  const task = findTrackedTask(uuid);
  if (!task) {
    closeStatusPicker();
    return;
  }
  statusPickerOpenForUuid = null;
  statusPickerTarget = null;
  await updateTaskStatusForTask(task, status);

  syncMainTicking();
  saveStateToStorage();
  renderUI(true);
}

function toggleVisibility() {
  uiState.visibilityMode =
    uiState.visibilityMode === "force-hide" ? "force-show" : "force-hide";
  saveStateToStorage();
  renderUI(true);
}

// ─────────────────────────────────────────────────────────────
// Shift+click on status circle to add task to plugin
// ─────────────────────────────────────────────────────────────
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function findBlockUuidFromElement(start: Element | null): string | null {
  let el: Element | null = start;
  while (el && el !== top?.document.body) {
    const attrCandidates = [
      "blockid",
      "data-uuid",
      "data-block-uuid",
      "data-id",
    ];
    for (const attr of attrCandidates) {
      const v = el.getAttribute?.(attr);
      if (v && UUID_RE.test(v)) {
        const m = v.match(UUID_RE);
        if (m) return m[0];
      }
    }
    if (el.id) {
      const m = el.id.match(UUID_RE);
      if (m) return m[0];
    }
    el = el.parentElement;
  }
  return null;
}

function isStatusIconElement(el: Element | null): boolean {
  if (!el) return false;
  // Match elements with class containing "ls-icon-" (Backlog, Todo, InProgress50, InReview, Done, Canceled)
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth < 6) {
    const cls = cur.className;
    const cs = typeof cls === "string" ? cls : (cls as any)?.baseVal || "";
    if (typeof cs === "string" && /\bls-icon-\w+\b/.test(cs)) return true;
    cur = cur.parentElement;
    depth++;
  }
  return false;
}

function setupShiftClickTracking() {
  const topDoc = top?.document;
  if (!topDoc) return;

  topDoc.addEventListener(
    "click",
    async (event: MouseEvent) => {
      if (!event.shiftKey) return;
      const target = event.target as Element | null;
      if (!target) return;
      if (!isStatusIconElement(target)) return;
      const uuid = findBlockUuidFromElement(target);
      if (!uuid) {
        log("Shift+click on status icon: could not resolve block uuid");
        return;
      }
      if (findTrackedTask(uuid)) {
        log("Task already tracked:", uuid);
        return;
      }
      log("Shift+click adding task to plugin:", uuid);
      event.preventDefault();
      event.stopPropagation();
      await startTracking(uuid);
    },
    true, // capture phase, beat Logseq's own click handler
  );
}

async function handleTrackedTaskStatusChange(uuid: string) {
  const tracked = findTrackedTask(uuid);
  if (!tracked) return;
  const fullBlock = await logseq.Editor.getBlock(uuid);
  if (!fullBlock) return;
  const status = await resolveBlockStatus(uuid, fullBlock);
  if (isRecentPluginStatusWrite(uuid, status)) return;
  if (status === "Todo" && isPausedActiveTask(tracked)) {
    clearPausedDoingUuid(uuid);
    syncMainTicking();
    saveStateToStorage();
    renderUI(true);
    return;
  }
  if (tracked.status !== status) {
    log(
      "Task",
      uuid,
      "status changed externally:",
      tracked.status,
      "->",
      status,
    );
    applyStatusTransition(tracked, status);
    syncMainTicking();
    saveStateToStorage();
    renderUI(true);
  }
}

function setupTaskTrackingWatcher() {
  if (taskTrackingUnsubscribe) {
    taskTrackingUnsubscribe();
  }

  taskTrackingUnsubscribe = logseq.DB.onChanged(async ({ blocks }) => {
    for (const block of blocks) {
      if (!block.uuid || !trackedTaskByUuid.has(block.uuid)) continue;
      await handleTrackedTaskStatusChange(block.uuid);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Drag handling
// ─────────────────────────────────────────────────────────────
function setupDragHandlers() {
  const topDoc = top?.document;
  if (!topDoc) return;

  topDoc.addEventListener("mousemove", (e: MouseEvent) => {
    if (!isDragging) return;
    e.preventDefault();

    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;

    // posX is offset from right edge (negative deltaX = moving left = increase offset)
    // posY is offset from bottom edge (negative deltaY = moving down = increase offset)
    uiState.posX = Math.max(0, dragStartPosX - deltaX);
    uiState.posY = Math.max(0, dragStartPosY - deltaY);

    updatePanelPosition();
  });

  topDoc.addEventListener("mouseup", () => {
    isDragging = false;
    updatePanelPosition();
  });

  top?.addEventListener("resize", updatePanelPosition);
}

function updatePanelPosition() {
  const panel = top?.document.querySelector(".pomodoro-panel") as HTMLElement;
  if (panel) {
    const scale = getSettings().panelScale;
    const viewportWidth =
      top?.document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight =
      top?.document.documentElement.clientHeight || window.innerHeight;
    const rect = panel.getBoundingClientRect();
    const maxX = Math.max(0, viewportWidth - rect.width);
    const maxY = Math.max(0, viewportHeight - rect.height);
    uiState.posX = Math.max(0, Math.min(uiState.posX, maxX));
    uiState.posY = Math.max(0, Math.min(uiState.posY, maxY));
    // posX/Y are in viewport pixels; translate is in zoomed pixels — divide by scale.
    const x = Math.round(uiState.posX / scale);
    const y = Math.round(uiState.posY / scale);
    panel.style.transform = `translate(-${x}px, -${y}px)`;
  }
}

function startDrag(e: any) {
  // Now handled in setupPomodoroContainer
}

// ─────────────────────────────────────────────────────────────
// UI Rendering
// ─────────────────────────────────────────────────────────────
function getAppearanceSignature(settings = getSettings()): string {
  return APPEARANCE_SETTING_KEYS.map((key) => String(settings[key] || "")).join(
    "|",
  );
}

function buildPanelInlineStyle(settings = getSettings()): string {
  const scale = settings.panelScale;
  const tx = Math.round(uiState.posX / scale);
  const ty = Math.round(uiState.posY / scale);
  const styles = [`transform: translate(-${tx}px, -${ty}px)`];
  if (scale !== 1) {
    styles.push(`zoom: ${scale}`);
  }
  const cssVarMap: Array<[string, string | null]> = [
    ["--pomo-panel-bg", settings.panelBackgroundColor],
    ["--pomo-dark-panel-bg", settings.darkPanelBackgroundColor],
    ["--pomo-task-font-size", settings.taskFontSize],
    ["--pomo-task-color", settings.taskTextColor],
    ["--pomo-dark-task-color", settings.darkTaskTextColor],
    ["--pomo-parent-font-size", settings.parentFontSize],
    ["--pomo-parent-color", settings.parentTextColor],
    ["--pomo-timer-font-size", settings.timerFontSize],
    ["--pomo-timer-color", settings.timerTextColor],
    ["--pomo-dark-timer-color", settings.darkTimerTextColor],
    ["--pomo-child-block-font-size", settings.taskChildBlockFontSize],
  ];
  for (const [name, value] of cssVarMap) {
    if (value) styles.push(`${name}: ${value}`);
  }
  return styles.join("; ");
}

function getStyles(): string {
  return `
    .pomodoro-panel {
      position: fixed;
      bottom: 0;
      right: 0;
      background: var(--pomo-panel-bg, var(--ls-primary-background-color, #fff));
      color: var(--ls-primary-text-color, #1f2937);
      border: 1px solid var(--ls-border-color, #d0d7de);
      border-radius: 8px;
      min-width: 232px;
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
      box-shadow: 0 14px 40px rgba(15, 23, 42, 0.18), 0 2px 8px rgba(15, 23, 42, 0.1);
      font-family: var(--ls-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      z-index: 999;
      user-select: none;
      pointer-events: auto;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    @media (prefers-color-scheme: dark) {
      .pomodoro-panel {
        background: var(--pomo-dark-panel-bg, var(--pomo-panel-bg, var(--ls-primary-background-color, #1f1f1f)));
        color: var(--ls-primary-text-color, #e5e7eb);
      }
    }
    html[data-theme="dark"] .pomodoro-panel,
    html[data-color="dark"] .pomodoro-panel,
    html.dark .pomodoro-panel,
    html.dark-theme .pomodoro-panel,
    body.dark .pomodoro-panel,
    body.dark-theme .pomodoro-panel {
      background: var(--pomo-dark-panel-bg, var(--pomo-panel-bg, var(--ls-primary-background-color, #1f1f1f)));
      color: var(--ls-primary-text-color, #e5e7eb);
    }
    .pomodoro-panel.hidden { display: none; }
    
    .pomodoro-icons {
      display: block;
      font-size: 12px;
      margin-bottom: 4px;
    }
    .pomodoro-icons:empty {
      display: none;
    }
    
    .pomodoro-phase {
      font-size: 10px;
      padding: 0 10px;
      border-radius: 4px;
      text-transform: uppercase;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      box-sizing: border-box;
      height: 20px;
      line-height: 1;
      min-width: 74px;
    }
    .phase-focus { background: #ff8a8a; color: #fff; }
    .phase-break { background: #69db7c; color: #fff; }
    .phase-idle { background: #adb5bd; color: #fff; }
    .phase-paused { background: #ffd43b; color: #fff; }
    
    .pomodoro-body {
      padding: 8px 10px 9px;
      cursor: grab;
    }
    .pomodoro-body:active { cursor: grabbing; }
    
    .pomodoro-timers {
      display: flex;
      gap: 14px;
      justify-content: center;
      align-items: center;
      flex-wrap: wrap;
    }
    
    .pomodoro-timer-block {
      text-align: center;
      min-width: 84px;
    }
    .pomodoro-timer-label {
      font-size: 11px;
      color: var(--ls-secondary-text-color, #6b7280);
      text-transform: uppercase;
      margin-bottom: 3px;
      line-height: 1.2;
    }
    .pomodoro-timer-value {
      color: var(--pomo-timer-color, var(--ls-primary-text-color, #1f2937));
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: var(--pomo-timer-font-size, 24px);
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    @media (prefers-color-scheme: dark) {
      .pomodoro-timer-value {
        color: var(--pomo-dark-timer-color, var(--pomo-timer-color, var(--ls-primary-text-color, #f3f4f6)));
      }
    }
    html[data-theme="dark"] .pomodoro-timer-value,
    html[data-color="dark"] .pomodoro-timer-value,
    html.dark .pomodoro-timer-value,
    html.dark-theme .pomodoro-timer-value,
    body.dark .pomodoro-timer-value,
    body.dark-theme .pomodoro-timer-value {
      color: var(--pomo-dark-timer-color, var(--pomo-timer-color, var(--ls-primary-text-color, #f3f4f6)));
    }
    .pomodoro-timer-block.pomodoro-timer-secondary .pomodoro-timer-value {
      font-weight: 500;
      opacity: 0.55;
    }
    .pomodoro-timer-block.pomodoro-timer-secondary .pomodoro-timer-label {
      opacity: 0.7;
    }
    
    .pomodoro-icons {
      text-align: right;
      font-size: 14px;
      letter-spacing: 3px;
      margin-top: 0;
      margin-bottom: 2px;
    }
    
    .pomodoro-actions {
      display: flex;
      gap: 6px;
      margin-top: 8px;
      justify-content: center;
    }
    
    .pomodoro-btn {
      background: var(--ls-tertiary-background-color, #f1f3f5);
      border: 1px solid var(--ls-border-color, #ddd);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .pomodoro-btn:hover {
      background: var(--ls-quaternary-background-color, #e9ecef);
    }
    .pomodoro-btn.primary {
      background: #228be6;
      color: #fff;
      border-color: #1c7ed6;
    }
    .pomodoro-btn.primary:hover {
      background: #1c7ed6;
    }
    .pomodoro-btn.danger {
      background: #fa5252;
      color: #fff;
      border-color: #f03e3e;
    }
    .pomodoro-btn.danger:hover {
      background: #f03e3e;
    }
    
    .pomodoro-footer {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 8px;
      border-top: 1px solid var(--ls-border-color, #eee);
      background: var(--ls-secondary-background-color, #f8fafc);
    }
    .pomodoro-footer-left {
      display: flex;
      align-items: center;
      gap: 5px;
      flex: 0 0 auto;
      justify-content: center;
    }
    .pomodoro-footer-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--ls-tertiary-background-color, #f1f3f5);
      border: 1px solid var(--ls-border-color, #ddd);
      border-radius: 3px;
      box-sizing: border-box;
      height: 20px;
      min-width: 74px;
      padding: 0 10px;
      font-size: 11px;
      line-height: 1;
      cursor: pointer;
      transition: background 0.15s;
    }
    .pomodoro-footer-btn:hover {
      background: var(--ls-quaternary-background-color, #e9ecef);
    }
    .pomodoro-expand-btn {
      background: none;
      border: none;
      box-sizing: border-box;
      height: 20px;
      width: 20px;
      padding: 0;
      cursor: pointer;
      font-size: 12px;
      opacity: 0.35;
      transition: opacity 0.15s;
      line-height: 1;
    }
    .pomodoro-expand-btn:hover {
      opacity: 0.8;
    }
    
    .pomodoro-expanded {
      border-top: 1px solid var(--ls-border-color, #eee);
      box-sizing: border-box;
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      padding: 12px 14px 14px;
      font-size: 12px;
      width: min(640px, calc(100vw - 40px));
    }
    
    .pomodoro-task-info {
      margin-bottom: 10px;
    }
    .pomodoro-task-label {
      font-size: 10px;
      opacity: 0.6;
      text-transform: uppercase;
    }
    .pomodoro-task-sublabel {
      color: var(--ls-secondary-text-color, #6b7280);
      font-size: 11px;
      text-transform: uppercase;
      font-weight: 700;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--ls-border-color, #eee);
    }
    .pomodoro-task-sublabel:first-child {
      border-top: none;
      margin-top: 0;
      padding-top: 0;
    }
    .pomodoro-task-link {
      color: var(--pomo-task-color, var(--ls-primary-text-color, #1f2937));
      cursor: pointer;
      text-decoration: none;
      display: block;
      flex: 1;
      min-width: 0;
      margin-top: 2px;
      font-size: var(--pomo-task-font-size, 13px);
      font-weight: 600;
      line-height: 1.25;
      white-space: normal;
      overflow: visible;
      overflow-wrap: anywhere;
      text-overflow: clip;
    }
    @media (prefers-color-scheme: dark) {
      .pomodoro-task-link {
        color: var(--pomo-dark-task-color, var(--pomo-task-color, var(--ls-primary-text-color, #f3f4f6)));
      }
    }
    html[data-theme="dark"] .pomodoro-task-link,
    html[data-color="dark"] .pomodoro-task-link,
    html.dark .pomodoro-task-link,
    html.dark-theme .pomodoro-task-link,
    body.dark .pomodoro-task-link,
    body.dark-theme .pomodoro-task-link {
      color: var(--pomo-dark-task-color, var(--pomo-task-color, var(--ls-primary-text-color, #f3f4f6)));
    }
    .pomodoro-task-link:hover {
      text-decoration: underline;
    }
    .pomodoro-task-row.compact .pomodoro-task-link {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      overflow-wrap: normal;
    }
    .pomodoro-task-row.compact .pomodoro-task-parent {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pomodoro-task-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 6px;
    }
    .pomodoro-task-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 10px;
      border: 1px solid var(--ls-border-color, #d0d7de);
      border-radius: 6px;
      min-width: 0;
    }
    .pomodoro-task-row.draggable {
      cursor: grab;
    }
    .pomodoro-task-row.draggable:active {
      cursor: grabbing;
    }
    .pomodoro-task-row.dragging {
      opacity: 0.4;
    }
    .pomodoro-task-row.drop-before {
      box-shadow: 0 -2px 0 0 var(--ls-link-text-color, #0969da);
    }
    .pomodoro-task-row.drop-after {
      box-shadow: 0 2px 0 0 var(--ls-link-text-color, #0969da);
    }
    .pomodoro-task-row-main {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      min-width: 0;
    }
    .pomodoro-task-children-toggle {
      background: none;
      border: none;
      color: var(--ls-secondary-text-color, #9ca3af);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 11px;
      height: 16px;
      line-height: 1;
      margin: 2px 0 0;
      padding: 0;
      width: 14px;
      opacity: 0.55;
      transition: opacity 0.15s, color 0.15s;
    }
    .pomodoro-task-children-toggle:hover {
      color: var(--ls-primary-text-color, #333);
      opacity: 1;
    }
    .pomodoro-task-children-spacer {
      flex-shrink: 0;
      width: 18px;
    }
    .pomodoro-task-remove {
      background: none;
      border: none;
      color: var(--ls-secondary-text-color, #6c757d);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 16px;
      margin-top: 2px;
      padding: 0;
      font-size: 16px;
      line-height: 1;
      opacity: 0.6;
      transition: opacity 0.15s, color 0.15s;
      flex-shrink: 0;
      width: 16px;
    }
    .pomodoro-task-remove:hover {
      opacity: 1;
      color: #fa5252;
    }
    .pomodoro-task-parent {
      color: var(--pomo-parent-color, var(--ls-secondary-text-color, #6c757d));
      cursor: pointer;
      text-decoration: none;
      font-size: var(--pomo-parent-font-size, 11px);
      padding-left: 20px;
      line-height: 1.25;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pomodoro-task-parent:hover {
      text-decoration: underline;
    }
    .pomodoro-task-children {
      border-left: 1px solid var(--ls-border-color, #d0d7de);
      margin: 4px 0 0 28px;
      max-height: calc(100vh - 190px);
      overflow: auto;
      padding: 0 0 0 12px;
      resize: vertical;
      scrollbar-gutter: stable;
    }
    .pomodoro-task-children ul {
      list-style: none;
      margin: 0;
      padding-left: 0;
    }
    .pomodoro-task-children > ul {
      padding-left: 0;
    }
    .pomodoro-task-child-item {
      color: var(--pomo-parent-color, var(--ls-primary-text-color, #333));
      font-size: var(--pomo-child-block-font-size, calc(var(--pomo-parent-font-size, 11px) + 2px));
      line-height: 1.35;
      margin: 4px 0;
      padding-left: 0;
      position: relative;
    }
    .pomodoro-task-child-item > ul {
      margin-left: 14px;
    }
    .pomodoro-task-child-bullet {
      color: var(--ls-secondary-text-color, #6c757d);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 8px;
      font-size: 13px;
      height: 1.35em;
      line-height: 1;
    }
    .pomodoro-task-child-row {
      align-items: flex-start;
      display: flex;
      gap: 6px;
      min-width: 0;
      position: relative;
      line-height: 1.35;
    }
   
    .pomodoro-task-child-content {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
      user-select: text;
    }
    .pomodoro-child-caption {
      color: var(--ls-secondary-text-color, #6c757d);
      font-size: 10px;
      margin-top: 3px;
    }
    .pomodoro-child-image {
      border: 1px solid var(--ls-border-color, #d0d7de);
      border-radius: 6px;
      cursor: zoom-in;
      display: block;
      height: auto;
      margin: 5px 0;
      max-height: 180px;
      max-width: 100%;
      object-fit: contain;
    }
    .pomodoro-child-image:hover {
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--ls-link-text-color, #0969da) 24%, transparent);
    }
    .pomodoro-task-empty {
      font-size: 11px;
      opacity: 0.6;
      margin-top: 4px;
    }
    
    .pomodoro-current-time {
      font-variant-numeric: tabular-nums;
    }
    .pomodoro-status-wrapper {
      position: relative;
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      height: 1.35em;
      margin-top: 0;
    }
    .pomodoro-status-icon {
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 0;
      flex-shrink: 0;
      border-radius: 50%;
      height: 16px;
      width: 16px;
    }
    .pomodoro-status-icon > svg {
      display: block;
      width: 16px;
      height: 16px;
    }
    .pomodoro-status-icon:hover {
      opacity: 0.7;
    }
    .pomodoro-status-picker {
      position: fixed;
      background: var(--ls-primary-background-color, #fff);
      border: 1px solid var(--ls-border-color, #ddd);
      border-radius: 6px;
      box-shadow: 0 12px 28px rgba(15, 23, 42, 0.18);
      z-index: 10000;
      min-width: 150px;
      padding: 5px;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .pomodoro-status-picker-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 9px;
      width: 100%;
      background: none;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-size: 12px;
      text-align: left;
      color: var(--ls-primary-text-color, #333);
      line-height: 1;
    }
    .pomodoro-status-picker-item:hover {
      background: var(--ls-tertiary-background-color, #f1f3f5);
    }
    .pomodoro-status-picker-item.active {
      background: var(--ls-secondary-background-color, #e9ecef);
    }
    .pomodoro-status-picker-item .pomodoro-status-icon-svg {
      display: inline-flex;
      flex-shrink: 0;
    }
    .pomodoro-image-preview-backdrop {
      position: fixed;
      inset: 0;
      z-index: 10001;
      background: rgba(15, 23, 42, 0.72);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 28px;
      cursor: zoom-out;
    }
    .pomodoro-image-preview-content {
      position: relative;
      max-width: min(96vw, 1200px);
      max-height: 92vh;
      cursor: default;
    }
    .pomodoro-image-preview-img {
      display: block;
      max-width: 100%;
      max-height: 92vh;
      object-fit: contain;
      border-radius: 8px;
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.38);
      background: var(--ls-primary-background-color, #fff);
    }
    .pomodoro-image-preview-close {
      position: absolute;
      top: -14px;
      right: -14px;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: 1px solid var(--ls-border-color, #d0d7de);
      background: var(--ls-primary-background-color, #fff);
      color: var(--ls-primary-text-color, #1f2937);
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      box-shadow: 0 8px 20px rgba(15, 23, 42, 0.18);
    }
  `;
}

function getStatusPickerSignature(): string {
  if (!statusPickerOpenForUuid) return "";
  return `${statusPickerOpenForUuid}|${statusPickerTarget || ""}|${Math.round(statusPickerTop)}|${Math.round(statusPickerLeft)}|${Math.round(statusPickerMaxHeight)}`;
}

function getImagePreviewSignature(): string {
  return imagePreviewState
    ? `${imagePreviewState.src}|${imagePreviewState.title}`
    : "";
}

function buildStatusPickerOverlay(): string {
  const uuid = statusPickerOpenForUuid;
  if (!uuid) return "";
  const targetType =
    statusPickerTarget || (findTrackedTask(uuid) ? "task" : "child");
  const task = targetType === "task" ? findTrackedTask(uuid) : undefined;
  const child = targetType === "child" ? findChildBlock(uuid) : undefined;
  if (targetType === "task" && !task) return "";
  if (targetType === "child" && !child?.isTask) return "";

  const currentStatus = normalizeTaskStatus(
    targetType === "task" ? task?.status : child?.status,
  );
  const action =
    targetType === "child" ? "setStatusForChild" : "setStatusForTask";
  const top = Math.max(8, Math.round(statusPickerTop));
  const left = Math.max(8, Math.round(statusPickerLeft));
  const maxHeight = statusPickerMaxHeight
    ? `max-height: ${Math.round(statusPickerMaxHeight)}px; overflow-y: auto;`
    : "";

  return `<div class="pomodoro-status-picker" style="top: ${top}px; left: ${left}px; ${maxHeight}">${STATUS_PICKER_ORDER.map(
    (s) => `
      <button class="pomodoro-status-picker-item ${s === currentStatus ? "active" : ""}" data-action="${action}" data-status-target="${targetType}" data-task-uuid="${escapeHtml(uuid)}" data-status="${escapeHtml(s)}" title="Set status to ${escapeHtml(s)}">
        <span class="pomodoro-status-icon-svg" style="color: ${STATUS_COLORS[s]}">${getStatusIconSVG(s)}</span>
        <span>${escapeHtml(s)}</span>
      </button>
    `,
  ).join("")}</div>`;
}

function buildImagePreviewOverlay(): string {
  if (!imagePreviewState) return "";
  const title = imagePreviewState.title || "Image preview";
  return `
    <div class="pomodoro-image-preview-backdrop" data-action="closeImagePreview">
      <div class="pomodoro-image-preview-content">
        <button class="pomodoro-image-preview-close" data-action="closeImagePreview" title="Close preview">×</button>
        <img class="pomodoro-image-preview-img" src="${escapeHtml(imagePreviewState.src)}" alt="${escapeHtml(title)}" />
      </div>
    </div>
  `;
}

function getPomodoroControl(): {
  action: "startPomodoro" | "pausePomodoro" | "resumePomodoro";
  label: "Start" | "Pause" | "Resume";
} {
  if (getSettings().disablePomodoro) {
    return hasAnyDoingTask()
      ? { action: "pausePomodoro", label: "Pause" }
      : { action: "resumePomodoro", label: "Resume" };
  }
  if (pomodoro.phase === "idle") {
    return { action: "startPomodoro", label: "Start" };
  }
  if (pomodoro.phase === "focus") {
    return { action: "pausePomodoro", label: "Pause" };
  }
  return { action: "resumePomodoro", label: "Resume" };
}

function getPomodoroControlSignature(): string {
  const control = getPomodoroControl();
  return `${getSettings().disablePomodoro ? "tasks" : pomodoro.phase}:${pomodoro.pausedPhase || ""}:${hasAnyDoingTask() ? "doing" : "not-doing"}:${pausedDoingUuids.length}:${control.action}`;
}

function buildUITemplate(): string {
  checkDailyReset();
  const hasTasks = trackedTasks.length > 0;
  const settings = getSettings();
  const { phase, completedCount } = pomodoro;
  const secondsRemaining = getPomodoroRemaining();

  if (!shouldShowPanel()) {
    return '<div class="pomodoro-panel hidden"></div>';
  }

  const showPomodoroTimer = !settings.disablePomodoro;
  const phaseClass = !showPomodoroTimer
    ? hasAnyDoingTask()
      ? "phase-focus"
      : "phase-paused"
    : phase === "focus"
      ? "phase-focus"
      : phase === "break"
        ? "phase-break"
        : phase === "paused"
          ? "phase-paused"
          : "phase-idle";
  const phaseLabel = !showPomodoroTimer
    ? hasAnyDoingTask()
      ? "Active"
      : "Paused"
    : phase === "paused"
      ? "Paused"
      : phase.charAt(0).toUpperCase() + phase.slice(1);

  const pomodoroTime =
    phase !== "idle" && phase !== "paused"
      ? formatTimeDisplay(secondsRemaining)
      : phase === "paused"
        ? formatTimeDisplay(secondsRemaining)
        : "--:--";
  const tasksTime = formatTimeDisplay(getGlobalSessionSeconds());
  const icons = "🍅".repeat(completedCount);

  const pomodoroControl = getPomodoroControl();

  const renderChildBlocks = (blocks: TaskChildBlock[]): string => {
    if (blocks.length === 0) return "";
    return `<ul>${blocks
      .map((block) => {
        const childStatus = block.status || "No Status";
        const statusColor =
          STATUS_COLORS[childStatus] || STATUS_COLORS["No Status"];
        const statusIcon =
          block.uuid && block.isTask
            ? `<span class="pomodoro-status-wrapper">
                <button class="pomodoro-status-icon" data-action="toggleStatusPicker" data-status-target="child" data-task-uuid="${block.uuid}" style="color: ${statusColor}" title="${escapeHtml(childStatus)} - click to change">${getStatusIconSVG(childStatus)}</button>
              </span>`
            : "";
        return `
          <li class="pomodoro-task-child-item">
            <div class="pomodoro-task-child-row">
              <span class="pomodoro-task-child-bullet">•</span>
              ${statusIcon}
              <div class="pomodoro-task-child-content">${block.html}</div>
            </div>
            ${renderChildBlocks(block.children)}
          </li>
        `;
      })
      .join("")}</ul>`;
  };

  const caretAtEnd = settings.caretPosition === "end";
  const renderTaskRows = (
    tasks: TaskState[],
    opts: { compact?: boolean; draggable?: boolean } = {},
  ) =>
    tasks
      .map((task) => {
        const taskTitleText = getTaskTitle(task.content);
        const taskTitle = escapeHtml(taskTitleText);
        const hasParent = !!task.parentContent;
        const parentTitleText = hasParent
          ? getTaskTitle(task.parentContent!)
          : task.pageName;
        const parentTitle = escapeHtml(parentTitleText);
        const pageName = escapeHtml(task.pageName);
        const showPageRow = settings.alwaysShowPage && hasParent;
        const showParentLine = settings.showTaskParent;
        const taskStatus = task.status || "No Status";
        const statusColor =
          STATUS_COLORS[taskStatus] || STATUS_COLORS["No Status"];
        const hasChildren = task.hasChildBlocks || task.childBlocks.length > 0;
        const caretClass = `pomodoro-task-children-toggle${caretAtEnd ? " end" : ""}`;
        const childToggle = hasChildren
          ? `<button class="${caretClass}" data-action="toggleTaskChildren" data-task-uuid="${task.uuid}" title="${task.childrenExpanded ? "Hide child blocks" : "Show child blocks"}">${task.childrenExpanded ? "▼" : "▶"}</button>`
          : `<span class="pomodoro-task-children-spacer"></span>`;
        const childrenAreaHeight = uiState.taskChildrenAreaHeights[task.uuid];
        const heightStyle = childrenAreaHeight
          ? ` style="height: ${Math.round(childrenAreaHeight)}px"`
          : "";
        const childrenBlock =
          hasChildren && task.childrenExpanded
            ? `<div class="pomodoro-task-children" data-task-uuid="${escapeHtml(task.uuid)}"${heightStyle}>${renderChildBlocks(task.childBlocks)}</div>`
            : "";
        const statusIcon = `
      <span class="pomodoro-status-wrapper">
        <button class="pomodoro-status-icon" data-action="toggleStatusPicker" data-status-target="task" data-task-uuid="${task.uuid}" style="color: ${statusColor}" title="${escapeHtml(taskStatus)} - click to change">${getStatusIconSVG(taskStatus)}</button>
      </span>
    `;
        const startCaret = caretAtEnd ? "" : childToggle;
        const endCaret = caretAtEnd ? childToggle : "";
        const rowClasses = [
          "pomodoro-task-row",
          opts.compact ? "compact" : "",
          opts.draggable ? "draggable" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const draggableAttr = opts.draggable
          ? ` draggable="true" data-drag-uuid="${task.uuid}"`
          : "";
        return `
      <div class="${rowClasses}"${draggableAttr}>
        <div class="pomodoro-task-row-main">
          ${startCaret}
          ${statusIcon}
          <a class="pomodoro-task-link" data-action="openTaskPage" data-task-uuid="${task.uuid}" title="${taskTitle}">${taskTitle}</a>
          ${endCaret}
          <button class="pomodoro-task-remove" data-action="removeTask" data-task-uuid="${task.uuid}" title="Remove from plugin">×</button>
        </div>
        ${
          showParentLine
            ? `<a class="pomodoro-task-parent" data-action="openParentPage" data-task-uuid="${task.uuid}" title="${parentTitle}">-> ${parentTitle}</a>`
            : ""
        }
        ${
          showPageRow
            ? `
          <a class="pomodoro-task-parent" data-action="openPage" data-task-uuid="${task.uuid}" title="${pageName}">-> ${pageName}</a>
        `
            : ""
        }
        ${childrenBlock}
      </div>
    `;
      })
      .join("");

  const activeTasks = trackedTasks.filter(
    (t) => getStatusSection(t) === "active",
  );
  const todoTasks = trackedTasks.filter((t) => getStatusSection(t) === "todo");
  const reviewTasksList = trackedTasks.filter(
    (t) => getStatusSection(t) === "review",
  );
  const backlogTasks = trackedTasks.filter(
    (t) => getStatusSection(t) === "backlog",
  );
  const doneTasks = trackedTasks.filter((t) => getStatusSection(t) === "done");
  const canceledTasks = trackedTasks.filter(
    (t) => getStatusSection(t) === "canceled",
  );

  const sectionHTML = (
    label: string,
    tasks: TaskState[],
    opts: { compact?: boolean; draggable?: boolean } = {},
  ) =>
    tasks.length > 0
      ? `<div class="pomodoro-task-sublabel">${label}</div><div class="pomodoro-task-list">${renderTaskRows(tasks, opts)}</div>`
      : "";

  const tasksBody = hasTasks
    ? `${sectionHTML(`Active tasks (${activeTasks.length})`, activeTasks, { draggable: true })}${sectionHTML(`TODOs (${todoTasks.length})`, todoTasks, { compact: true })}${sectionHTML(`In review (${reviewTasksList.length})`, reviewTasksList, { compact: true })}${sectionHTML(`Backlog (${backlogTasks.length})`, backlogTasks, { compact: true })}${sectionHTML(`Done (${doneTasks.length})`, doneTasks, { compact: true })}${sectionHTML(`Canceled (${canceledTasks.length})`, canceledTasks, { compact: true })}`
    : `<div class="pomodoro-task-empty">No tasks</div>`;

  const expandedPanel = uiState.panelExpanded
    ? `
    <div class="pomodoro-expanded">
      <div class="pomodoro-task-info">
        ${tasksBody}
      </div>
      <div class="pomodoro-actions" style="margin-top: 10px;">
        ${showPomodoroTimer ? `<button class="pomodoro-btn" data-action="resetPomodoro">Reset Pomodoro</button>` : ""}
        <button class="pomodoro-btn" data-action="resetTask">Reset Tasks timer</button>
      </div>
    </div>
  `
    : "";

  const tasksTimeBlock = settings.showTaskTime
    ? `
          <div class="pomodoro-timer-block pomodoro-timer-secondary">
            <div class="pomodoro-timer-label">Tasks time</div>
            <div class="pomodoro-timer-value" id="task-time">${tasksTime}</div>
          </div>
        `
    : "";

  const pomodoroTimeBlock = showPomodoroTimer
    ? `
          <div class="pomodoro-timer-block">
            <div class="pomodoro-timer-label">Pomodoro</div>
            <div class="pomodoro-timer-value" id="pomo-time">${pomodoroTime}</div>
          </div>
        `
    : "";

  const currentTimeBlock = settings.showCurrentTime
    ? `
          <div class="pomodoro-timer-block pomodoro-timer-secondary">
            <div class="pomodoro-timer-label">Current Time</div>
            <div class="pomodoro-timer-value pomodoro-current-time" id="pomo-current-time">${formatCurrentTime()}</div>
          </div>
        `
    : "";

  const iconsBlock = showPomodoroTimer
    ? `<span class="pomodoro-icons" id="pomo-icons">${icons}</span>`
    : "";
  const phaseBlock = `<span class="pomodoro-phase ${phaseClass}" id="pomo-phase">${phaseLabel}</span>
       <button class="pomodoro-footer-btn" data-action="${pomodoroControl.action}">${pomodoroControl.label}</button>`;

  return `
    <div class="pomodoro-panel" style="${buildPanelInlineStyle(settings)};">
      <div class="pomodoro-body" data-action="startDrag">
        ${iconsBlock}
        <div class="pomodoro-timers">
          ${pomodoroTimeBlock}
          ${tasksTimeBlock}
          ${currentTimeBlock}
        </div>
      </div>
      <div class="pomodoro-footer">
        <div class="pomodoro-footer-left">
          ${phaseBlock}
        </div>
        <button class="pomodoro-expand-btn" data-action="togglePanel" title="${uiState.panelExpanded ? "Collapse tasks" : "Expand tasks"}">
          ${uiState.panelExpanded ? "▲" : "▼"}
        </button>
      </div>
      ${expandedPanel}
    </div>
    ${buildStatusPickerOverlay()}
    ${buildImagePreviewOverlay()}
  `;
}

// Track if panel structure needs full rebuild
let lastPanelExpanded: boolean | null = null;
let lastHasTasks: boolean | null = null;
let lastVisibilityMode: UIState["visibilityMode"] | null = null;
let lastShowCurrentTime: boolean | null = null;

function getChildBlocksSignature(blocks: TaskChildBlock[]): string {
  return blocks
    .map(
      (block) =>
        `${block.uuid}:${block.status}:${block.isTask ? "task" : "content"}:${getChildBlocksSignature(block.children)}`,
    )
    .join(",");
}

function getActiveSectionSignature(): string {
  return trackedTasks
    .map(
      (t) =>
        `${t.uuid}:${t.status}:${pausedDoingUuids.includes(t.uuid) ? "paused-active" : ""}:${t.hasChildBlocks ? "has-children" : ""}:${t.childBlocks.length}:${t.childrenExpanded ? "children-open" : ""}:${getChildBlocksSignature(t.childBlocks)}`,
    )
    .join("|");
}

let lastActiveSignature: string | null = null;
let lastDisablePomodoro: boolean | null = null;
let lastShowTaskTime: boolean | null = null;
let lastStatusPickerSignature: string | null = null;
let lastImagePreviewSignature: string | null = null;
let lastAppearanceSignature: string | null = null;
let lastPomodoroControlSignature: string | null = null;

function renderUI(force = false) {
  checkDailyReset();
  const now = Date.now();
  if (!force && now - lastRenderTime < RENDER_THROTTLE_MS) {
    return;
  }
  lastRenderTime = now;

  const hasTasks = trackedTasks.length > 0;
  const settings = getSettings();
  const showCurrentTime = settings.showCurrentTime;
  const showTaskTime = settings.showTaskTime;
  const disablePomodoro = settings.disablePomodoro;
  const activeSignature = getActiveSectionSignature();
  const appearanceSignature = getAppearanceSignature(settings);
  const statusPickerSignature = getStatusPickerSignature();
  const imagePreviewSignature = getImagePreviewSignature();
  const pomodoroControlSignature = getPomodoroControlSignature();
  const topDoc = top?.document;
  if (!topDoc) return;

  const container = topDoc.getElementById("pomodoro-container");
  if (!container) return;

  // Check if we need full rebuild (structure changed)
  const panelExists = !!container.querySelector(".pomodoro-panel");
  const needsRebuild =
    force ||
    !panelExists ||
    lastPanelExpanded !== uiState.panelExpanded ||
    lastHasTasks !== hasTasks ||
    lastVisibilityMode !== uiState.visibilityMode ||
    lastShowCurrentTime !== showCurrentTime ||
    lastShowTaskTime !== showTaskTime ||
    lastDisablePomodoro !== disablePomodoro ||
    lastActiveSignature !== activeSignature ||
    lastStatusPickerSignature !== statusPickerSignature ||
    lastImagePreviewSignature !== imagePreviewSignature ||
    lastPomodoroControlSignature !== pomodoroControlSignature ||
    lastAppearanceSignature !== appearanceSignature;

  if (needsRebuild) {
    lastPanelExpanded = uiState.panelExpanded;
    lastHasTasks = hasTasks;
    lastVisibilityMode = uiState.visibilityMode;
    lastShowCurrentTime = showCurrentTime;
    lastShowTaskTime = showTaskTime;
    lastDisablePomodoro = disablePomodoro;
    lastActiveSignature = activeSignature;
    lastStatusPickerSignature = statusPickerSignature;
    lastImagePreviewSignature = imagePreviewSignature;
    lastPomodoroControlSignature = pomodoroControlSignature;
    lastAppearanceSignature = appearanceSignature;
    const template = buildUITemplate();
    container.innerHTML = template;
    observeTaskChildrenResize();
    updatePanelPosition();
    return;
  }

  // Just update text values - no DOM rebuild
  const pomoTimeEl = topDoc.getElementById("pomo-time");
  const taskTimeEl = topDoc.getElementById("task-time");
  const iconsEl = topDoc.getElementById("pomo-icons");
  const phaseEl = topDoc.getElementById("pomo-phase");
  const currentTimeEl = topDoc.getElementById("pomo-current-time");

  const { phase, completedCount } = pomodoro;
  const secondsRemaining = getPomodoroRemaining();

  const pomodoroTime =
    phase !== "idle" && phase !== "paused"
      ? formatTimeDisplay(secondsRemaining)
      : phase === "paused"
        ? formatTimeDisplay(secondsRemaining)
        : "--:--";
  const tasksTime = formatTimeDisplay(getGlobalSessionSeconds());
  const icons = "🍅".repeat(completedCount);
  const phaseLabel =
    phase === "paused"
      ? "Paused"
      : phase.charAt(0).toUpperCase() + phase.slice(1);

  if (pomoTimeEl) pomoTimeEl.textContent = pomodoroTime;
  if (taskTimeEl) taskTimeEl.textContent = tasksTime;
  if (iconsEl) iconsEl.textContent = icons;
  if (phaseEl) {
    phaseEl.textContent = phaseLabel;
    phaseEl.className = `pomodoro-phase phase-${phase}`;
  }
  if (currentTimeEl) currentTimeEl.textContent = formatCurrentTime();
  updatePanelPosition();
}

let taskChildrenResizeObserver: ResizeObserver | null = null;
let taskChildrenObservedSet = new WeakSet<Element>();
let taskChildrenSaveTimeout: ReturnType<typeof setTimeout> | null = null;
let activeTaskChildrenResizeUuid: string | null = null;
let clearTaskChildrenResizeTimeout: ReturnType<typeof setTimeout> | null = null;

function observeTaskChildrenResize() {
  const topDoc = top?.document;
  if (!topDoc) return;
  if (typeof ResizeObserver === "undefined") return;
  if (!taskChildrenResizeObserver) {
    taskChildrenResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const uuid = el.dataset.taskUuid || "";
        if (!uuid || uuid !== activeTaskChildrenResizeUuid) continue;
        const measured = el.getBoundingClientRect().height;
        if (!measured) continue;
        const savedHeight = uiState.taskChildrenAreaHeights[uuid];
        if (savedHeight !== undefined && Math.abs(savedHeight - measured) < 1)
          continue;
        uiState.taskChildrenAreaHeights[uuid] = Math.round(measured);
        if (taskChildrenSaveTimeout) clearTimeout(taskChildrenSaveTimeout);
        taskChildrenSaveTimeout = setTimeout(() => saveStateToStorage(), 250);
      }
    });
  }
  const els = topDoc.querySelectorAll(".pomodoro-task-children");
  els.forEach((el) => {
    if (taskChildrenObservedSet.has(el)) return;
    taskChildrenObservedSet.add(el);
    taskChildrenResizeObserver!.observe(el);
  });
}

function markTaskChildrenResizeStart(e: MouseEvent) {
  const target = (e.target as HTMLElement | null)?.closest(
    ".pomodoro-task-children",
  ) as HTMLElement | null;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const nearResizeHandle =
    e.clientY >= rect.bottom - 18 && e.clientX >= rect.right - 30;
  if (!nearResizeHandle) return;
  activeTaskChildrenResizeUuid = target.dataset.taskUuid || null;
  if (clearTaskChildrenResizeTimeout) {
    clearTimeout(clearTaskChildrenResizeTimeout);
    clearTaskChildrenResizeTimeout = null;
  }
}

function markTaskChildrenResizeEnd() {
  if (!activeTaskChildrenResizeUuid) return;
  if (clearTaskChildrenResizeTimeout) {
    clearTimeout(clearTaskChildrenResizeTimeout);
  }
  clearTaskChildrenResizeTimeout = setTimeout(() => {
    activeTaskChildrenResizeUuid = null;
    clearTaskChildrenResizeTimeout = null;
  }, 500);
}

function reorderActiveTask(srcUuid: string, tgtUuid: string, before: boolean) {
  if (srcUuid === tgtUuid) return;
  const srcIdx = trackedTasks.findIndex((t) => t.uuid === srcUuid);
  if (srcIdx === -1) return;
  const [moved] = trackedTasks.splice(srcIdx, 1);
  const tgtIdx = trackedTasks.findIndex((t) => t.uuid === tgtUuid);
  if (tgtIdx === -1) {
    trackedTasks.splice(srcIdx, 0, moved);
    return;
  }
  trackedTasks.splice(before ? tgtIdx : tgtIdx + 1, 0, moved);
  saveStateToStorage();
  renderUI(true);
}

function clearTaskDragIndicators(topDoc: Document) {
  topDoc
    .querySelectorAll(
      ".pomodoro-task-row.drop-before, .pomodoro-task-row.drop-after, .pomodoro-task-row.dragging",
    )
    .forEach((el) => {
      el.classList.remove("drop-before", "drop-after", "dragging");
    });
}

function setupPomodoroContainer() {
  // Create a container in the main Logseq document
  const topDoc = top?.document;
  if (!topDoc) return;

  // Remove old container if exists
  const existing = topDoc.getElementById("pomodoro-container");
  if (existing) existing.remove();

  // Reset observer state on container rebuild
  if (taskChildrenResizeObserver) {
    taskChildrenResizeObserver.disconnect();
  }
  taskChildrenObservedSet = new WeakSet<Element>();
  activeTaskChildrenResizeUuid = null;

  // Create new container
  const container = topDoc.createElement("div");
  container.id = "pomodoro-container";
  topDoc.body.appendChild(container);

  // Inject styles
  const existingStyle = topDoc.getElementById("pomodoro-styles");
  if (existingStyle) existingStyle.remove();

  const style = topDoc.createElement("style");
  style.id = "pomodoro-styles";
  style.textContent = getStyles();
  topDoc.head.appendChild(style);

  // Setup event delegation for clicks
  container.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest(
      "[data-action]",
    ) as HTMLElement;
    if (!target) return;

    const action = target.dataset.action;
    const taskUuid = target.dataset.taskUuid;

    switch (action) {
      case "togglePanel":
        togglePanel();
        break;
      case "openTaskPage":
        openTaskPage(e.shiftKey, taskUuid);
        break;
      case "openParentPage":
        openParentPage(e.shiftKey, taskUuid);
        break;
      case "openPage":
        openPage(e.shiftKey, taskUuid);
        break;
      case "removeTask":
        if (taskUuid) removeTrackedOrReviewTask(taskUuid);
        break;
      case "toggleStatusPicker":
        if (taskUuid) {
          const targetType =
            target.dataset.statusTarget === "child" ? "child" : "task";
          toggleStatusPicker(taskUuid, targetType, target);
        }
        break;
      case "toggleTaskChildren":
        if (taskUuid) void toggleTaskChildren(taskUuid);
        break;
      case "setStatusForTask": {
        const status = target.dataset.status as TaskStatus | undefined;
        if (taskUuid && status) setTaskStatusForSingle(taskUuid, status);
        break;
      }
      case "setStatusForChild": {
        const status = target.dataset.status as TaskStatus | undefined;
        if (taskUuid && status) void setChildTaskStatus(taskUuid, status);
        break;
      }
      case "openChildImage": {
        const src = target.dataset.imageSrc || "";
        const title = target.dataset.imageTitle || "";
        const blockUuid = target.dataset.blockUuid || "";
        if (src) void openChildImage(src, title, blockUuid);
        break;
      }
      case "closeImagePreview":
        if (
          target.classList.contains("pomodoro-image-preview-backdrop") &&
          (e.target as HTMLElement | null)?.closest(
            ".pomodoro-image-preview-content",
          )
        ) {
          break;
        }
        closeImagePreview();
        break;
      case "startPomodoro":
        startPomodoro();
        break;
      case "pausePomodoro":
        pausePomodoro();
        break;
      case "resumePomodoro":
        resumePomodoro();
        break;
      case "resetPomodoro":
        resetPomodoro();
        break;
      case "resetTask":
        resetTask();
        break;
    }
  });

  // Close status picker when clicking outside
  topDoc.addEventListener("click", (e) => {
    if (statusPickerOpenForUuid === null) return;
    const targetEl = e.target as HTMLElement | null;
    if (!targetEl) return;
    if (targetEl.closest(".pomodoro-status-picker, .pomodoro-status-icon"))
      return;
    closeStatusPicker();
  });

  // Setup drag on mousedown
  container.addEventListener("mousedown", (e) => {
    markTaskChildrenResizeStart(e);

    const target = (e.target as HTMLElement).closest(
      "[data-action='startDrag']",
    );
    if (!target) return;

    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPosX = uiState.posX;
    dragStartPosY = uiState.posY;
    e.preventDefault();
  });

  // Drag-and-drop reordering for active tasks
  container.addEventListener("dragstart", (e) => {
    const targetEl = e.target as HTMLElement | null;
    const row = targetEl?.closest("[data-drag-uuid]") as HTMLElement | null;
    if (!row) return;
    const interactive = targetEl?.closest("button, a");
    if (interactive && row.contains(interactive)) {
      e.preventDefault();
      return;
    }
    taskDragSourceUuid = row.dataset.dragUuid || null;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", taskDragSourceUuid || "");
    }
    row.classList.add("dragging");
  });

  container.addEventListener("dragover", (e) => {
    if (!taskDragSourceUuid) return;
    const row = (e.target as HTMLElement | null)?.closest(
      "[data-drag-uuid]",
    ) as HTMLElement | null;
    if (!row) return;
    const targetUuid = row.dataset.dragUuid;
    if (!targetUuid || targetUuid === taskDragSourceUuid) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    topDoc
      .querySelectorAll(
        ".pomodoro-task-row.drop-before, .pomodoro-task-row.drop-after",
      )
      .forEach((el) => el.classList.remove("drop-before", "drop-after"));
    row.classList.add(before ? "drop-before" : "drop-after");
  });

  container.addEventListener("dragleave", (e) => {
    const row = (e.target as HTMLElement | null)?.closest(
      "[data-drag-uuid]",
    ) as HTMLElement | null;
    if (!row) return;
    const related = e.relatedTarget as Node | null;
    if (related && row.contains(related)) return;
    row.classList.remove("drop-before", "drop-after");
  });

  container.addEventListener("drop", (e) => {
    if (!taskDragSourceUuid) return;
    const row = (e.target as HTMLElement | null)?.closest(
      "[data-drag-uuid]",
    ) as HTMLElement | null;
    if (!row) {
      taskDragSourceUuid = null;
      clearTaskDragIndicators(topDoc);
      return;
    }
    const targetUuid = row.dataset.dragUuid;
    if (!targetUuid || targetUuid === taskDragSourceUuid) {
      taskDragSourceUuid = null;
      clearTaskDragIndicators(topDoc);
      return;
    }
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const src = taskDragSourceUuid;
    taskDragSourceUuid = null;
    clearTaskDragIndicators(topDoc);
    reorderActiveTask(src, targetUuid, before);
  });

  container.addEventListener("dragend", () => {
    taskDragSourceUuid = null;
    clearTaskDragIndicators(topDoc);
  });

  topDoc.addEventListener("mouseup", markTaskChildrenResizeEnd);
}

function provideStyles() {
  logseq.provideStyle(getStyles());

  // Style the native Logseq timer (.time-spent class)
  logseq.provideStyle(`
    .time-spent {
      font-size: 16px !important;
      font-weight: 700 !important;
      opacity: 1 !important;
      font-variant-numeric: tabular-nums;
    }
    .time-spent .fade-link {
      color: var(--ls-primary-text-color, #333) !important;
      opacity: 1 !important;
      font-weight: 700 !important;
      font-size: 16px !important;
    }
  `);
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────
function runPomodoroControl() {
  if (getSettings().disablePomodoro) {
    if (hasAnyDoingTask()) {
      void pausePomodoro();
    } else {
      void resumePomodoro();
    }
    return;
  }

  if (pomodoro.phase === "idle") {
    startPomodoro();
  } else if (pomodoro.phase === "focus") {
    void pausePomodoro();
  } else {
    void resumePomodoro();
  }
}

function registerCommands() {
  logseq.App.registerCommandPalette(
    { key: "pomodoro-reset", label: "Pomodoro: Reset timer" },
    resetPomodoro,
  );

  logseq.App.registerCommandPalette(
    { key: "pomodoro-toggle", label: "Pomodoro: Show/Hide timer" },
    toggleVisibility,
  );

  logseq.App.registerCommandPalette(
    { key: "pomodoro-pause", label: "Pomodoro: Start/Pause/Resume" },
    runPomodoroControl,
  );
}

// ─────────────────────────────────────────────────────────────
// Settings Schema
// ─────────────────────────────────────────────────────────────
function setupSettings() {
  logseq.useSettingsSchema([
    {
      key: "focusMinutes",
      title: "Focus duration (minutes)",
      description: "Length of each focus/pomodoro session.",
      type: "number",
      default: 45,
    },
    {
      key: "breakMinutes",
      title: "Break duration (minutes)",
      description: "Length of break after each focus session.",
      type: "number",
      default: 5,
    },
    {
      key: "soundEnabled",
      title: "Enable sounds",
      description:
        "Play WebAudio notifications when focus/break ends. Works in Logseq/Electron on macOS, Windows, and Linux when system audio is available.",
      type: "boolean",
      default: true,
    },
    {
      key: "soundVolume",
      title: "Sound volume",
      description: "Volume level from 0.0 to 1.0.",
      type: "number",
      default: 0.5,
    },
    {
      key: "soundType",
      title: "Notification sound",
      description:
        "Short sound played when a focus or break session ends. Changing this setting plays a preview even when sounds are disabled.",
      type: "enum",
      enumChoices: SOUND_TYPES,
      enumPicker: "select",
      default: "beep",
    },
    {
      key: "showCurrentTime",
      title: "Show current time",
      description: "Display the current wall-clock time next to the timers.",
      type: "boolean",
      default: true,
    },
    {
      key: "showTaskTime",
      title: "Show tasks timer",
      description:
        "Display the Tasks timer (counts up while any task is in Doing).",
      type: "boolean",
      default: true,
    },
    {
      key: "disablePomodoro",
      title: "Hide Pomodoro timer",
      description:
        "Hide the countdown, tomato icons, and Reset Pomo button. Task Pause/Resume controls keep working.",
      type: "boolean",
      default: false,
    },
    {
      key: "tickIntervalSeconds",
      title: "Timers update interval (seconds)",
      description:
        "How often the timer display refreshes. Lower = smoother, higher = more efficient. Default 5.",
      type: "number",
      default: 5,
    },
    {
      key: "panelScale",
      title: "Panel scale",
      description:
        "Shrinks the entire plugin panel. 1.0 = full size, 0.5 = half. Steps of 0.1.",
      type: "enum",
      enumChoices: ["0.5", "0.6", "0.7", "0.8", "0.9", "1.0"],
      enumPicker: "select",
      default: "1.0",
    },
    {
      key: "resetPomodorosToday",
      title: "Reset today's pomodoros",
      description:
        "Turn on to reset the tomato count for today. The plugin will turn this option off after resetting.",
      type: "boolean",
      default: false,
    },
    {
      key: "alwaysShowPage",
      title: "Always show parent page",
      description:
        "Always display the parent page name below task's parent. When disabled, page is only shown if task has no parent.",
      type: "boolean",
      default: false,
    },
    {
      key: "appearanceHeading",
      title: "Appearance",
      description:
        "Optional visual overrides. Leave values unset to use the Logseq theme.",
      type: "heading",
      default: null,
    },
    {
      key: "panelBackgroundColor",
      title: "Panel background color",
      description:
        "Unset by default. Pick a color to override the panel background.",
      type: "string",
      inputAs: "color",
      default: "",
    },
    {
      key: "darkPanelBackgroundColor",
      title: "Dark mode panel background color",
      description:
        "Unset by default. Pick a color to override the panel background in dark mode.",
      type: "string",
      inputAs: "color",
      default: "",
    },
    {
      key: "taskFontSize",
      title: "Task font size",
      description:
        "Unset by default. Use a CSS size like 13px, 0.9rem, or 110%.",
      type: "string",
      default: "",
    },
    {
      key: "taskTextColor",
      title: "Task text color",
      description: "Unset by default. Pick a color to override task titles.",
      type: "string",
      inputAs: "color",
      default: "",
    },
    {
      key: "darkTaskTextColor",
      title: "Dark mode task text color",
      description:
        "Unset by default. Pick a color to override task titles in dark mode.",
      type: "string",
      inputAs: "color",
      default: "",
    },
    {
      key: "parentFontSize",
      title: "Parent font size",
      description:
        "Unset by default. Use a CSS size like 11px, 0.8rem, or 100%.",
      type: "string",
      default: "",
    },
    {
      key: "parentTextColor",
      title: "Parent text color",
      description:
        "Unset by default. Pick a color to override parent/page rows.",
      type: "string",
      inputAs: "color",
      default: "",
    },
    {
      key: "timerFontSize",
      title: "Time counter font size",
      description:
        "Unset by default. Use a CSS size like 24px, 1.5rem, or 120%.",
      type: "string",
      default: "",
    },
    {
      key: "timerTextColor",
      title: "Time counter color",
      description: "Unset by default. Pick a color to override timer values.",
      type: "string",
      inputAs: "color",
      default: "",
    },
    {
      key: "darkTimerTextColor",
      title: "Dark mode time counter color",
      description:
        "Unset by default. Pick a color to override timer values in dark mode.",
      type: "string",
      inputAs: "color",
      default: "",
    },
    {
      key: "showTaskParent",
      title: "Show direct parent of task",
      description: "Show the '-> Parent' line under each task title.",
      type: "boolean",
      default: false,
    },
    {
      key: "caretPosition",
      title: "Children caret position",
      description:
        "Where to place the expand/collapse caret on each task row. 'end' places it next to the close button. 'start' places it at the beginning of the row.",
      type: "enum",
      enumChoices: ["end", "start"],
      enumPicker: "select",
      default: "end",
    },
    {
      key: "taskChildBlockFontSize",
      title: "Task child blocks font size",
      description:
        "Font size for the expanded child-block tree under a task. Use a CSS size like 12px, 0.85rem, or 100%.",
      type: "string",
      default: "",
    },
  ]);
}

function handleSettingsActions(
  nextSettings: Record<string, any>,
  previousSettings: Record<string, any> = {},
) {
  if (
    nextSettings.resetPomodorosToday === true &&
    previousSettings.resetPomodorosToday !== true
  ) {
    resetTodayPomodoros();
    logseq.updateSettings({ resetPomodorosToday: false });
    logseq.UI.showMsg("Today's pomodoros reset.", "success");
  }

  if (
    nextSettings.tickIntervalSeconds !== previousSettings.tickIntervalSeconds
  ) {
    restartTickingIfRunning();
  }

  if (nextSettings.disablePomodoro !== previousSettings.disablePomodoro) {
    updatePomodoroTimerForVisibility();
    syncMainTicking();
    saveStateToStorage();
  }

  const appearanceChanged = APPEARANCE_SETTING_KEYS.some(
    (key) => nextSettings[key] !== previousSettings[key],
  );

  if (
    nextSettings.showCurrentTime !== previousSettings.showCurrentTime ||
    nextSettings.showTaskTime !== previousSettings.showTaskTime ||
    nextSettings.disablePomodoro !== previousSettings.disablePomodoro ||
    nextSettings.tickIntervalSeconds !== previousSettings.tickIntervalSeconds ||
    appearanceChanged
  ) {
    manageCurrentTimeInterval();
    renderUI(true);
  }

  // Preview sound when sound settings change, even if notifications are disabled.
  if (
    Object.keys(previousSettings).length > 0 &&
    ((nextSettings.soundType &&
      nextSettings.soundType !== previousSettings.soundType) ||
      nextSettings.soundVolume !== previousSettings.soundVolume)
  ) {
    playFocusEndSound({ ignoreEnabled: true });
  }
}

function setupSettingsHandlers() {
  handleSettingsActions((logseq.settings || {}) as Record<string, any>);
  logseq.onSettingsChanged<Record<string, any>>(handleSettingsActions);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function main() {
  // Load saved state from localStorage
  loadStateFromStorage();

  setupSettings();
  setupSettingsHandlers();
  resumeDoingTimersFromState();
  setupPomodoroContainer();

  logseq.provideModel({
    resetPomodoro,
    startPomodoro,
    pausePomodoro,
    resumePomodoro,
    togglePanel,
    toggleVisibility,
    openTaskPage,
    openPage,
    startDrag,
  });

  logseq.App.registerUIItem("toolbar", {
    key: "pomodoro-visibility-btn",
    template: `
      <button
        class="button"
        data-on-click="toggleVisibility"
        title="Pomodoro: Show/hide timer"
        style="display: flex; align-items: center; padding: 4px 8px;"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
    `,
  });

  registerCommands();
  setupShiftClickTracking();
  setupTaskTrackingWatcher();
  setupDragHandlers();
  manageCurrentTimeInterval();
  syncMainTicking();
  renderUI(true);
  void refreshTrackedTaskChildren();
}

logseq.ready(main).catch(console.error);
