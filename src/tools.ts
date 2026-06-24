import {
  app, emit, uid, addAnnotation, getAnnotation, removeAnnotation,
  pushUndo, scheduleSave, Annotation,
} from "./state";
import {
  setToolHandler, annBBox, makeSvg, previewLayer, renderOverlay,
} from "./pdfview";

const MIN = 3;

let startX = 0, startY = 0;
let lastX = 0, lastY = 0;
let drawing = false;
let moving = false;
let penPts: [number, number][] = [];
let temp: SVGElement | null = null;

function translate(a: Annotation, dx: number, dy: number) {
  if (a.rect) a.rect = [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy];
  if (a.rects) a.rects = a.rects.map((r) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
  if (a.p1) a.p1 = [a.p1[0] + dx, a.p1[1] + dy];
  if (a.p2) a.p2 = [a.p2[0] + dx, a.p2[1] + dy];
  if (a.strokes) a.strokes = a.strokes.map((s) => s.map((p) => [p[0] + dx, p[1] + dy] as [number, number]));
  if (a.point) a.point = [a.point[0] + dx, a.point[1] + dy];
}

function hitTest(x: number, y: number): Annotation | null {
  const onPage = app.annotations.filter((a) => a.page === app.page);
  for (let i = onPage.length - 1; i >= 0; i--) {
    const b = annBBox(onPage[i]);
    if (x >= b[0] - 4 && x <= b[2] + 4 && y >= b[1] - 4 && y <= b[3] + 4) return onPage[i];
  }
  return null;
}

function clearTemp() { if (temp) { temp.remove(); temp = null; } }

export function initTools() {
  setToolHandler((type, x, y, e) => {
    if (type === "dbl") { onDouble(x, y); return; }
    if (app.tool === "select") return onSelect(type, x, y);
    return onDraw(type, x, y, e);
  });
}

function onSelect(type: string, x: number, y: number) {
  if (type === "down") {
    const hit = hitTest(x, y);
    app.selectedId = hit ? hit.id : null;
    moving = !!hit;
    lastX = x; lastY = y;
    if (hit) pushUndo();
    renderOverlay();
  } else if (type === "move" && moving && app.selectedId) {
    const a = getAnnotation(app.selectedId);
    if (a) { translate(a, x - lastX, y - lastY); lastX = x; lastY = y; emit("annotations"); }
  } else if (type === "up" && moving) {
    moving = false;
    scheduleSave();
  }
}

function onDouble(x: number, y: number) {
  const hit = hitTest(x, y);
  if (hit && (hit.kind === "note" || hit.kind === "text")) {
    const txt = window.prompt(hit.kind === "note" ? "Note:" : "Text:", hit.text ?? "");
    if (txt !== null) { hit.text = txt; emit("annotations"); scheduleSave(); }
  }
}

function onDraw(type: string, x: number, y: number, _e: PointerEvent) {
  if (app.tool === "note" && type === "down") { createNote(x, y); return; }

  if (type === "down") {
    drawing = true; startX = x; startY = y;
    penPts = [[x, y]];
    clearTemp();
    if (app.tool === "pen" || app.tool === "line" || app.tool === "arrow") {
      temp = makeSvg("path", { fill: "none", stroke: app.color, "stroke-width": app.width, "stroke-dasharray": "4 3" });
    } else {
      temp = makeSvg("rect", { fill: "none", stroke: app.color, "stroke-width": app.width, "stroke-dasharray": "4 3" });
    }
    previewLayer().appendChild(temp);
  } else if (type === "move" && drawing && temp) {
    if (app.tool === "pen") {
      penPts.push([x, y]);
      temp.setAttribute("d", "M" + penPts.map((p) => p.join(" ")).join(" L "));
    } else if (app.tool === "line" || app.tool === "arrow") {
      temp.setAttribute("d", `M${startX} ${startY} L${x} ${y}`);
    } else {
      const rx = Math.min(startX, x), ry = Math.min(startY, y);
      temp.setAttribute("x", `${rx}`); temp.setAttribute("y", `${ry}`);
      temp.setAttribute("width", `${Math.abs(x - startX)}`);
      temp.setAttribute("height", `${Math.abs(y - startY)}`);
    }
  } else if (type === "up" && drawing) {
    drawing = false;
    clearTemp();
    finalize(x, y);
  }
}

function rectOf(x: number, y: number): [number, number, number, number] {
  return [Math.min(startX, x), Math.min(startY, y), Math.max(startX, x), Math.max(startY, y)];
}

function finalize(x: number, y: number) {
  const base = { id: uid(), page: app.page, color: app.color };
  const t = app.tool;
  if (t === "rect" || t === "ellipse") {
    const r = rectOf(x, y);
    if (r[2] - r[0] < MIN || r[3] - r[1] < MIN) return;
    addAnnotation({ ...base, kind: t, rect: r, width: app.width, fill: false });
  } else if (t === "highlight") {
    const r = rectOf(x, y);
    if (r[2] - r[0] < MIN || r[3] - r[1] < MIN) return;
    addAnnotation({ ...base, kind: "highlight", rects: [r] });
  } else if (t === "redact") {
    const r = rectOf(x, y);
    if (r[2] - r[0] < MIN || r[3] - r[1] < MIN) return;
    addAnnotation({ ...base, kind: "redact", rect: r, mode: app.redactMode });
  } else if (t === "line" || t === "arrow") {
    if (Math.hypot(x - startX, y - startY) < MIN) return;
    addAnnotation({ ...base, kind: t, p1: [startX, startY], p2: [x, y], width: app.width });
  } else if (t === "pen") {
    if (penPts.length < 2) return;
    addAnnotation({ ...base, kind: "pen", strokes: [penPts.slice()], width: app.width });
  } else if (t === "text") {
    let r = rectOf(x, y);
    if (r[2] - r[0] < 16 || r[3] - r[1] < 10) r = [startX, startY, startX + 200, startY + 30];
    const txt = window.prompt("Text:", "") ?? "";
    addAnnotation({ ...base, kind: "text", rect: r, text: txt, fontSize: 14 });
  }
}

function createNote(x: number, y: number) {
  const txt = window.prompt("Note:", "") ?? "";
  addAnnotation({ id: uid(), page: app.page, color: app.color, kind: "note", point: [x, y], text: txt });
}

export function deleteSelected() {
  if (app.selectedId) removeAnnotation(app.selectedId);
}
