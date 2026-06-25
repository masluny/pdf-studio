import { app, on, emit, status } from "./state";
import * as be from "./backend";
import { setVisible, renderPage } from "./pdfview";
import { savePdfDialog, isTauri } from "./backend";

const SVG_NS = "http://www.w3.org/2000/svg";

let viewerEl!: HTMLElement;
let editWrap!: HTMLDivElement;
let img!: HTMLImageElement;
let overlay!: SVGSVGElement;

let objects: be.EditObject[] = [];
let rectEls = new Map<number, SVGRectElement>();
let pageW = 0;
let pageH = 0;
let selected: number | null = null;
let editTool: "select" | "text" = "select";
let dirty = false;

// drag state
let dragging = false;
let startX = 0, startY = 0;
let dragId: number | null = null;

export function initEditMode(viewer: HTMLElement) {
  viewerEl = viewer;
  editWrap = document.createElement("div");
  editWrap.className = "page-wrap page-shadow";
  editWrap.style.display = "none";
  img = document.createElement("img");
  img.className = "pdf-canvas";
  img.draggable = false;
  overlay = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  overlay.classList.add("overlay");
  editWrap.append(img, overlay);
  viewerEl.appendChild(editWrap);
  attachPointer();

  on("page", () => { if (app.mode === "edit") renderEditPage(); });
}

export function selectedObject(): be.EditObject | null {
  return objects.find((o) => o.id === selected) ?? null;
}
export function isDirty() { return dirty; }
export function setEditTool(t: "select" | "text") { editTool = t; }

export async function enterEdit(): Promise<boolean> {
  if (!app.pdfPath || !isTauri()) {
    status("Edit mode needs the desktop app");
    return false;
  }
  try {
    await be.editOpen(app.pdfPath);
  } catch (e) {
    status("Could not open for editing: " + e);
    return false;
  }
  dirty = false;
  selected = null;
  setVisible(false);
  editWrap.style.display = "block";
  await renderEditPage();
  status("Edit mode — click text to retype, drag to move, Delete to remove");
  return true;
}

export function leaveEdit() {
  editWrap.style.display = "none";
  selected = null;
  setVisible(true);
  renderPage();
}

async function renderEditPage() {
  if (!app.pdfDoc) return;
  const scale = app.scale;
  let b64: string;
  try {
    b64 = await be.editRenderPage(app.page, scale);
  } catch (e) {
    status("Render failed: " + e);
    return;
  }
  img.src = "data:image/png;base64," + b64;

  const page = await app.pdfDoc.getPage(app.page + 1);
  const vp1 = page.getViewport({ scale: 1 });
  pageW = vp1.width; pageH = vp1.height;
  const dispW = pageW * scale, dispH = pageH * scale;
  img.style.width = `${dispW}px`; img.style.height = `${dispH}px`;
  editWrap.style.width = `${dispW}px`; editWrap.style.height = `${dispH}px`;
  overlay.setAttribute("width", `${dispW}`);
  overlay.setAttribute("height", `${dispH}`);
  overlay.setAttribute("viewBox", `0 0 ${pageW} ${pageH}`);

  try {
    objects = await be.editObjects(app.page);
  } catch {
    objects = [];
  }
  drawObjects();
  emit("mode");
}

function drawObjects() {
  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
  rectEls.clear();
  for (const o of objects) {
    const [x0, y0, x1, y1] = o.bbox;
    const r = document.createElementNS(SVG_NS, "rect") as SVGRectElement;
    r.setAttribute("x", `${x0}`);
    r.setAttribute("y", `${y0}`);
    r.setAttribute("width", `${Math.max(1, x1 - x0)}`);
    r.setAttribute("height", `${Math.max(1, y1 - y0)}`);
    r.setAttribute("fill", "transparent");
    const isSel = o.id === selected;
    const stroke = isSel ? "var(--accent)" : o.kind === "image" ? "#18b96b" : "#9aa1ac";
    r.setAttribute("stroke", stroke);
    r.setAttribute("stroke-width", isSel ? "1.4" : "0.7");
    if (!isSel) r.setAttribute("stroke-dasharray", "3 3");
    r.setAttribute("data-id", `${o.id}`);
    r.style.cursor = editTool === "select" ? "move" : "crosshair";
    overlay.appendChild(r);
    rectEls.set(o.id, r);
  }
}

function toPoint(e: PointerEvent): [number, number] {
  const rect = overlay.getBoundingClientRect();
  return [
    ((e.clientX - rect.left) / rect.width) * pageW,
    ((e.clientY - rect.top) / rect.height) * pageH,
  ];
}

function hit(x: number, y: number): be.EditObject | null {
  // topmost (last drawn) object whose bbox contains the point
  for (let i = objects.length - 1; i >= 0; i--) {
    const [x0, y0, x1, y1] = objects[i].bbox;
    if (x >= x0 - 2 && x <= x1 + 2 && y >= y0 - 2 && y <= y1 + 2) return objects[i];
  }
  return null;
}

function attachPointer() {
  overlay.addEventListener("pointerdown", (e) => {
    overlay.setPointerCapture(e.pointerId);
    const [x, y] = toPoint(e);
    if (editTool === "text") {
      addText(x, y);
      return;
    }
    const h = hit(x, y);
    selected = h ? h.id : null;
    drawObjects();
    emit("mode");
    if (h) {
      dragging = true;
      dragId = h.id;
      startX = x;
      startY = y;
    }
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!dragging || dragId === null) return;
    const [x, y] = toPoint(e);
    const r = rectEls.get(dragId);
    const o = objects.find((ob) => ob.id === dragId);
    if (r && o) {
      r.setAttribute("x", `${o.bbox[0] + (x - startX)}`);
      r.setAttribute("y", `${o.bbox[1] + (y - startY)}`);
    }
  });
  overlay.addEventListener("pointerup", async (e) => {
    if (!dragging || dragId === null) return;
    const [x, y] = toPoint(e);
    const dx = x - startX, dy = y - startY;
    dragging = false;
    const id = dragId;
    dragId = null;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      try {
        await be.editMove(app.page, id, dx, dy);
        dirty = true;
        await renderEditPage();
        selected = id;
        drawObjects();
      } catch (err) {
        status("Move failed: " + err);
        await renderEditPage();
      }
    }
  });
  overlay.addEventListener("dblclick", async (e) => {
    const [x, y] = toPoint(e as unknown as PointerEvent);
    const o = hit(x, y);
    if (o && o.kind === "text") {
      selected = o.id;
      drawObjects();
      const t = window.prompt("Edit text:", o.text ?? "");
      if (t !== null && t !== o.text) {
        try {
          await be.editSetText(app.page, o.id, t);
          dirty = true;
          await renderEditPage();
        } catch (err) {
          status("Edit failed: " + err);
        }
      }
    }
  });
}

async function addText(x: number, y: number) {
  const t = window.prompt("New text:", "");
  if (t) {
    try {
      await be.editInsertText(app.page, x, y, t, 16);
      dirty = true;
      await renderEditPage();
    } catch (err) {
      status("Insert failed: " + err);
    }
  }
  editTool = "select";
  emit("mode");
}

export async function undoEdit() {
  try {
    if (await be.editUndo()) { await renderEditPage(); status("Undo"); }
    else status("Nothing to undo");
  } catch (e) { status("Undo failed: " + e); }
}

export async function redoEdit() {
  try {
    if (await be.editRedo()) { await renderEditPage(); status("Redo"); }
    else status("Nothing to redo");
  } catch (e) { status("Redo failed: " + e); }
}

export function deselect() {
  if (selected !== null) { selected = null; drawObjects(); emit("mode"); }
}

export async function deleteSelected() {
  if (selected === null) return;
  try {
    await be.editDelete(app.page, selected);
    dirty = true;
    selected = null;
    await renderEditPage();
  } catch (err) {
    status("Delete failed: " + err);
  }
}

export async function editText() {
  const o = selectedObject();
  if (!o || o.kind !== "text") {
    status("Select a text object first");
    return;
  }
  const t = window.prompt("Edit text:", o.text ?? "");
  if (t !== null && t !== o.text) {
    await be.editSetText(app.page, o.id, t);
    dirty = true;
    await renderEditPage();
  }
}

export async function saveEdited() {
  if (!app.pdfPath) return;
  const def = app.pdfPath.replace(/\.pdf$/i, ".edited.pdf");
  const out = await savePdfDialog(def);
  if (!out) return;
  try {
    await be.editSave(out);
    dirty = false;
    status("Saved edited PDF → " + out.split("/").pop());
  } catch (err) {
    status("Save failed: " + err);
  }
}
