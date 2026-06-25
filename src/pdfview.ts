import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { app, emit, on, Match } from "./state";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const SVG_NS = "http://www.w3.org/2000/svg";

let viewerEl!: HTMLElement;
let pageWrap!: HTMLDivElement;
let canvas!: HTMLCanvasElement;
let overlay!: SVGSVGElement;
let ctx!: CanvasRenderingContext2D;

let pageW = 0;
let pageH = 0;
let renderToken = 0;

export interface OutlineNode { title: string; page: number; children: OutlineNode[]; }

export function mountViewer(container: HTMLElement) {
  viewerEl = container;
  viewerEl.classList.add("viewer");
  pageWrap = document.createElement("div");
  pageWrap.className = "page-wrap page-shadow";
  canvas = document.createElement("canvas");
  canvas.className = "pdf-canvas";
  overlay = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  overlay.classList.add("overlay");
  pageWrap.appendChild(canvas);
  pageWrap.appendChild(overlay);
  viewerEl.appendChild(pageWrap);
  ctx = canvas.getContext("2d")!;
  attachPointer();

  on("annotations", renderOverlay);
  on("search", renderOverlay);
}

export async function loadPdfBytes(bytes: Uint8Array) {
  const task = pdfjsLib.getDocument({ data: bytes });
  app.pdfDoc = await task.promise;
  app.pageCount = app.pdfDoc.numPages;
  app.page = Math.min(app.page, app.pageCount - 1);
  emit("doc");
  await renderPage();
}

export async function renderPage() {
  if (!app.pdfDoc) return;
  const token = ++renderToken;
  const page = await app.pdfDoc.getPage(app.page + 1);
  if (token !== renderToken) return;
  const vp1 = page.getViewport({ scale: 1 });
  pageW = vp1.width; pageH = vp1.height;
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: app.scale });

  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = `${vp.width}px`;
  canvas.style.height = `${vp.height}px`;
  pageWrap.style.width = `${vp.width}px`;
  pageWrap.style.height = `${vp.height}px`;
  overlay.setAttribute("width", `${vp.width}`);
  overlay.setAttribute("height", `${vp.height}`);
  overlay.setAttribute("viewBox", `0 0 ${pageW} ${pageH}`);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  if (token !== renderToken) return;
  renderOverlay();
  emit("page");
}

export function gotoPage(n: number) {
  const clamped = Math.max(0, Math.min(n, app.pageCount - 1));
  if (clamped === app.page && app.pdfDoc) return;
  app.page = clamped;
  app.selectedId = null;
  renderPage();
}

export function setZoom(s: number) {
  app.scale = Math.max(0.25, Math.min(6, s));
  emit("page");
  renderPage();
}
export function zoomIn() { setZoom(app.scale * 1.2); }
export function zoomOut() { setZoom(app.scale / 1.2); }
export function fitWidth() {
  if (!pageW) return;
  const avail = viewerEl.clientWidth - 64;
  if (avail > 0) setZoom(avail / pageW);
}

// ---------------------------------------------------------------- thumbnails
export async function renderThumb(target: HTMLCanvasElement, pageNum: number) {
  if (!app.pdfDoc) return;
  const page = await app.pdfDoc.getPage(pageNum + 1);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = 150 / vp1.width;
  const vp = page.getViewport({ scale });
  target.width = vp.width; target.height = vp.height;
  const c = target.getContext("2d")!;
  await page.render({ canvasContext: c, viewport: vp }).promise;
}

// ---------------------------------------------------------------- outline
export async function getOutlineTree(): Promise<OutlineNode[]> {
  if (!app.pdfDoc) return [];
  const raw = await app.pdfDoc.getOutline();
  if (!raw) return [];
  const resolve = async (dest: any): Promise<number> => {
    try {
      let d = dest;
      if (typeof d === "string") d = await app.pdfDoc.getDestination(d);
      if (!d) return 0;
      const ref = d[0];
      if (ref && typeof ref === "object") return await app.pdfDoc.getPageIndex(ref);
    } catch {}
    return 0;
  };
  const walk = async (items: any[]): Promise<OutlineNode[]> => {
    const out: OutlineNode[] = [];
    for (const it of items) {
      out.push({
        title: it.title || "Untitled",
        page: await resolve(it.dest),
        children: it.items?.length ? await walk(it.items) : [],
      });
    }
    return out;
  };
  return walk(raw);
}

// ---------------------------------------------------------------- search
export async function runSearch(query: string): Promise<Match[]> {
  const matches: Match[] = [];
  const q = query.trim().toLowerCase();
  if (!q || !app.pdfDoc) { app.matches = []; app.matchIndex = -1; emit("search"); return matches; }
  for (let p = 0; p < app.pageCount; p++) {
    const page = await app.pdfDoc.getPage(p + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    for (const item of tc.items as any[]) {
      const s: string = item.str ?? "";
      if (s && s.toLowerCase().includes(q)) {
        matches.push({ page: p, rect: itemRect(item, vp1) });
      }
    }
  }
  app.matches = matches;
  app.matchIndex = matches.length ? 0 : -1;
  emit("search");
  if (matches.length) gotoMatch(0);
  return matches;
}

export function gotoMatch(i: number) {
  if (!app.matches.length) return;
  app.matchIndex = (i + app.matches.length) % app.matches.length;
  const m = app.matches[app.matchIndex];
  if (m.page !== app.page) { app.page = m.page; renderPage().then(() => scrollToRect(m.rect)); }
  else { renderOverlay(); scrollToRect(m.rect); }
  emit("search");
}
export function nextMatch() { gotoMatch(app.matchIndex + 1); }
export function prevMatch() { gotoMatch(app.matchIndex - 1); }
export function clearSearch() { app.matches = []; app.matchIndex = -1; emit("search"); renderOverlay(); }

function scrollToRect(r: [number, number, number, number]) {
  const cx = ((r[0] + r[2]) / 2) * app.scale;
  const cy = ((r[1] + r[3]) / 2) * app.scale;
  viewerEl.scrollTo({
    left: pageWrap.offsetLeft + cx - viewerEl.clientWidth / 2,
    top: pageWrap.offsetTop + cy - viewerEl.clientHeight / 2,
    behavior: "smooth",
  });
}

function itemRect(item: any, vp1: any): [number, number, number, number] {
  const t = pdfjsLib.Util.transform(vp1.transform, item.transform);
  const h = item.height || Math.hypot(t[2], t[3]) || 10;
  const w = item.width || 0;
  const x0 = t[4];
  const y1 = t[5];
  return [x0, y1 - h, x0 + w, y1 + h * 0.18];
}

// ---------------------------------------------------------------- overlay
function el(name: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export function renderOverlay() {
  if (!overlay) return;
  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);

  // search highlights (under annotations)
  for (let i = 0; i < app.matches.length; i++) {
    const m = app.matches[i];
    if (m.page !== app.page) continue;
    const active = i === app.matchIndex;
    overlay.appendChild(el("rect", {
      x: m.rect[0], y: m.rect[1], width: Math.max(1, m.rect[2] - m.rect[0]),
      height: Math.max(1, m.rect[3] - m.rect[1]),
      fill: active ? "#ff9a3d" : "#ffe14d", "fill-opacity": active ? 0.55 : 0.4,
      stroke: active ? "#ff7a00" : "none", "stroke-width": active ? 1 : 0,
    }));
  }

  for (const a of app.annotations) {
    if (a.page !== app.page) continue;
    drawAnnotation(a);
  }
}

function drawAnnotation(a: any) {
  const w = a.width ?? 2;
  const g = el("g", { "data-id": a.id, style: app.tool === "select" ? "cursor:move" : "" }) as SVGGElement;
  switch (a.kind) {
    case "highlight":
      for (const r of a.rects ?? []) {
        g.appendChild(el("rect", { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], fill: a.color, "fill-opacity": 0.35 }));
      }
      break;
    case "rect":
      g.appendChild(el("rect", { x: a.rect[0], y: a.rect[1], width: a.rect[2] - a.rect[0], height: a.rect[3] - a.rect[1], fill: a.fill ? a.color : "none", "fill-opacity": a.fill ? 0.25 : 0, stroke: a.color, "stroke-width": w }));
      break;
    case "ellipse": {
      const cx = (a.rect[0] + a.rect[2]) / 2, cy = (a.rect[1] + a.rect[3]) / 2;
      g.appendChild(el("ellipse", { cx, cy, rx: Math.abs(a.rect[2] - a.rect[0]) / 2, ry: Math.abs(a.rect[3] - a.rect[1]) / 2, fill: a.fill ? a.color : "none", "fill-opacity": a.fill ? 0.25 : 0, stroke: a.color, "stroke-width": w }));
      break;
    }
    case "line":
      g.appendChild(el("line", { x1: a.p1[0], y1: a.p1[1], x2: a.p2[0], y2: a.p2[1], stroke: a.color, "stroke-width": w, "stroke-linecap": "round" }));
      break;
    case "arrow": {
      g.appendChild(el("line", { x1: a.p1[0], y1: a.p1[1], x2: a.p2[0], y2: a.p2[1], stroke: a.color, "stroke-width": w, "stroke-linecap": "round" }));
      const ang = Math.atan2(a.p2[1] - a.p1[1], a.p2[0] - a.p1[0]);
      const hs = Math.max(8, w * 4);
      for (const off of [Math.PI * 0.85, -Math.PI * 0.85]) {
        g.appendChild(el("line", { x1: a.p2[0], y1: a.p2[1], x2: a.p2[0] + hs * Math.cos(ang + off), y2: a.p2[1] + hs * Math.sin(ang + off), stroke: a.color, "stroke-width": w, "stroke-linecap": "round" }));
      }
      break;
    }
    case "pen":
      for (const stroke of a.strokes ?? []) {
        g.appendChild(el("polyline", { points: stroke.map((p: number[]) => `${p[0]},${p[1]}`).join(" "), fill: "none", stroke: a.color, "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round" }));
      }
      break;
    case "text": {
      const r = a.rect;
      const t = el("text", { x: r[0] + 2, y: r[1] + (a.fontSize ?? 14), fill: a.color, "font-size": a.fontSize ?? 14, "font-family": "sans-serif" });
      t.textContent = a.text || "Text…";
      if (!a.text) t.setAttribute("opacity", "0.5");
      g.appendChild(el("rect", { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], fill: "none", stroke: a.color, "stroke-width": 0.8, "stroke-dasharray": "3 3", opacity: 0.5 }));
      g.appendChild(t);
      break;
    }
    case "note": {
      const p = a.point;
      const note = el("g", { transform: `translate(${p[0]},${p[1]})` });
      note.appendChild(el("path", { d: "M0 0 H13 L18 5 V20 H0 Z", fill: a.color, stroke: "#5d4037", "stroke-width": 1 }));
      note.appendChild(el("path", { d: "M13 0 V5 H18", fill: "none", stroke: "#5d4037", "stroke-width": 1 }));
      const title = el("title", {}); title.textContent = a.text || "(empty note)";
      note.appendChild(title);
      g.appendChild(note);
      break;
    }
    case "redact":
      g.appendChild(el("rect", { x: a.rect[0], y: a.rect[1], width: a.rect[2] - a.rect[0], height: a.rect[3] - a.rect[1], fill: a.mode === "redact" ? "#111" : "#fff", stroke: a.mode === "redact" ? "#111" : "#bbb", "stroke-width": 1 }));
      break;
  }
  if (app.selectedId === a.id) {
    const bb = annBBox(a);
    g.appendChild(el("rect", { x: bb[0] - 2, y: bb[1] - 2, width: bb[2] - bb[0] + 4, height: bb[3] - bb[1] + 4, fill: "none", stroke: "var(--accent)", "stroke-width": 1.2, "stroke-dasharray": "4 3" }));
  }
  overlay.appendChild(g);
}

export function annBBox(a: any): [number, number, number, number] {
  if (a.rect) return a.rect;
  if (a.rects?.length) {
    const xs = a.rects.flatMap((r: number[]) => [r[0], r[2]]);
    const ys = a.rects.flatMap((r: number[]) => [r[1], r[3]]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (a.p1 && a.p2) return [Math.min(a.p1[0], a.p2[0]), Math.min(a.p1[1], a.p2[1]), Math.max(a.p1[0], a.p2[0]), Math.max(a.p1[1], a.p2[1])];
  if (a.strokes?.length) {
    const pts = a.strokes.flat();
    const xs = pts.map((p: number[]) => p[0]); const ys = pts.map((p: number[]) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (a.point) return [a.point[0], a.point[1], a.point[0] + 18, a.point[1] + 20];
  return [0, 0, 0, 0];
}

// ---------------------------------------------------------------- pointer / tools
let toolHandler: ((type: string, x: number, y: number, e: PointerEvent) => void) | null = null;
export function setToolHandler(fn: typeof toolHandler) { toolHandler = fn; }

function toPoint(e: PointerEvent): [number, number] {
  const r = overlay.getBoundingClientRect();
  return [(e.clientX - r.left) / app.scale, (e.clientY - r.top) / app.scale];
}

function attachPointer() {
  overlay.addEventListener("pointerdown", (e) => {
    overlay.setPointerCapture(e.pointerId);
    const [x, y] = toPoint(e);
    toolHandler?.("down", x, y, e);
  });
  overlay.addEventListener("pointermove", (e) => {
    const [x, y] = toPoint(e);
    toolHandler?.("move", x, y, e);
  });
  overlay.addEventListener("pointerup", (e) => {
    const [x, y] = toPoint(e);
    toolHandler?.("up", x, y, e);
  });
  overlay.addEventListener("dblclick", (e) => {
    const [x, y] = toPoint(e as unknown as PointerEvent);
    toolHandler?.("dbl", x, y, e as unknown as PointerEvent);
  });
}

export function setVisible(v: boolean) {
  if (pageWrap) pageWrap.style.display = v ? "block" : "none";
}
export function viewerElement(): HTMLElement { return viewerEl; }

export function previewLayer(): SVGSVGElement { return overlay; }
export function makeSvg(name: string, attrs: Record<string, string | number>) { return el(name, attrs); }
export function pagePoints(): [number, number] { return [pageW, pageH]; }
