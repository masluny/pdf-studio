import { saveSidecar } from "./backend";

export type Tool =
  | "select" | "highlight" | "text" | "rect" | "ellipse"
  | "line" | "pen" | "arrow" | "note" | "redact";

export type AnnKind = Exclude<Tool, "select">;

export interface Annotation {
  id: string;
  kind: AnnKind;
  page: number; // 0-based
  color: string;
  width?: number;
  fill?: boolean;
  rect?: [number, number, number, number];
  rects?: [number, number, number, number][];
  p1?: [number, number];
  p2?: [number, number];
  strokes?: [number, number][][];
  point?: [number, number];
  text?: string;
  fontSize?: number;
  mode?: "whiteout" | "redact";
}

export interface Comment { reply: string; resolved: boolean; }
export interface Match { page: number; rect: [number, number, number, number]; }

export const DEFAULT_COLORS: Record<string, string> = {
  highlight: "#ffe14d", text: "#1b1e24", rect: "#ff5252", ellipse: "#9b59b6",
  line: "#00c853", pen: "#2962ff", arrow: "#3b6ff6", note: "#ffb020",
};

export const PRESET_COLORS = [
  "#ffe14d", "#ffb020", "#ff5c5c", "#ff7ac6", "#a66bff",
  "#3b6ff6", "#18b96b", "#22c3d6", "#1b1e24", "#ffffff",
];

interface AppState {
  pdfPath: string | null;
  pdfBytes: Uint8Array | null;
  pdfDoc: any | null;
  pageCount: number;
  page: number;
  scale: number;
  tool: Tool;
  color: string;
  width: number;
  redactMode: "whiteout" | "redact";
  theme: "light" | "dark";
  selectedId: string | null;
  annotations: Annotation[];
  comments: Record<string, Comment>;
  notes: string;
  matches: Match[];
  matchIndex: number;
  commentFilter: string;
}

export const app: AppState = {
  pdfPath: null, pdfBytes: null, pdfDoc: null, pageCount: 0, page: 0, scale: 1.2,
  tool: "select", color: "#ffe14d", width: 2, redactMode: "whiteout",
  theme: (matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  selectedId: null, annotations: [], comments: {}, notes: "",
  matches: [], matchIndex: -1, commentFilter: "All",
};

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ---- tiny event bus -------------------------------------------------------
export type Evt = "doc" | "page" | "annotations" | "tool" | "theme" | "search" | "status";
const listeners: Record<string, Set<(p?: any) => void>> = {};
export function on(evt: Evt, cb: (p?: any) => void) {
  (listeners[evt] ??= new Set()).add(cb);
}
export function emit(evt: Evt, payload?: any) {
  listeners[evt]?.forEach((f) => f(payload));
}
export function status(msg: string) { emit("status", msg); }

// ---- undo / redo ----------------------------------------------------------
let undoStack: string[] = [];
let redoStack: string[] = [];
function snapshot(): string {
  return JSON.stringify(app.annotations);
}
export function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}
export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  app.annotations = JSON.parse(undoStack.pop()!);
  app.selectedId = null;
  changed();
}
export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  app.annotations = JSON.parse(redoStack.pop()!);
  app.selectedId = null;
  changed();
}

// ---- mutations ------------------------------------------------------------
export function addAnnotation(a: Annotation) {
  pushUndo();
  app.annotations.push(a);
  changed();
}
export function removeAnnotation(id: string) {
  pushUndo();
  app.annotations = app.annotations.filter((a) => a.id !== id);
  delete app.comments[id];
  if (app.selectedId === id) app.selectedId = null;
  changed();
}
export function getAnnotation(id: string): Annotation | undefined {
  return app.annotations.find((a) => a.id === id);
}
export function annotationsOnPage(page: number): Annotation[] {
  return app.annotations.filter((a) => a.page === page);
}
export function comment(id: string): Comment {
  return app.comments[id] ?? { reply: "", resolved: false };
}
export function setReply(id: string, reply: string) {
  app.comments[id] = { ...comment(id), reply };
  changed();
}
export function setResolved(id: string, resolved: boolean) {
  app.comments[id] = { ...comment(id), resolved };
  changed();
}
export function setNotes(text: string) {
  app.notes = text;
  scheduleSave();
}

export function changed() {
  emit("annotations");
  scheduleSave();
}

// ---- persistence ----------------------------------------------------------
let saveTimer: number | undefined;
export function scheduleSave() {
  if (!app.pdfPath) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 700);
}
export async function saveNow() {
  if (!app.pdfPath) return;
  const data = {
    version: 3,
    source: app.pdfPath.split("/").pop() ?? "",
    annotations: app.annotations,
    comments: app.comments,
    notes: app.notes,
  };
  try { await saveSidecar(app.pdfPath, JSON.stringify(data, null, 2)); } catch {}
}
export function loadSidecarJson(json: string | null) {
  app.annotations = []; app.comments = {}; app.notes = "";
  if (!json) return;
  try {
    const d = JSON.parse(json);
    app.annotations = Array.isArray(d.annotations) ? d.annotations : [];
    app.comments = d.comments ?? {};
    app.notes = d.notes ?? "";
  } catch {}
  undoStack = []; redoStack = [];
}

// Remap annotation pages after a structural edit. `mapper` returns the new page
// index for an old page, or null to drop annotations on that page.
export function remapPages(mapper: (oldPage: number) => number | null) {
  const next: Annotation[] = [];
  for (const a of app.annotations) {
    const np = mapper(a.page);
    if (np !== null) { a.page = np; next.push(a); }
  }
  app.annotations = next;
  undoStack = []; redoStack = [];
  changed();
}
