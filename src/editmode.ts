import { app, emit, status } from "./state";
import * as be from "./backend";
import { setVisible, renderPage, setEditHooks } from "./pdfview";
import { savePdfDialog, isTauri } from "./backend";

const SVG_NS = "http://www.w3.org/2000/svg";

interface EditBlock {
  index: number;
  wrap: HTMLDivElement;
  img: HTMLImageElement;
  overlay: SVGSVGElement;
  pw: number;
  ph: number;
  objects: be.EditObject[];
  rectEls: Map<number, SVGRectElement>;
  renderedScale: number;
  rendering: boolean;
}

type EditTool = "select" | "text";
type Selection = { page: number; id: number } | null;

let viewerEl!: HTMLElement;
let pagesEl!: HTMLDivElement;
let blocks: EditBlock[] = [];
let selected: Selection = null;
let editTool: EditTool = "select";
let dirty = false;
let activeEditor: HTMLDivElement | null = null;
let scrollScheduled = false;

// drag state
let dragging = false;
let startX = 0;
let startY = 0;
let dragPage = -1;
let dragId: number | null = null;

// manual double-click tracking (pointerdown's `detail` and the native dblclick
// event are unreliable under pointer capture on Windows, so we time it ourselves)
let lastDownTime = 0;
let lastDownId: number | null = null;
let lastDownPage = -1;

export function initEditMode(viewer: HTMLElement) {
  viewerEl = viewer;
  pagesEl = document.createElement("div");
  pagesEl.className = "pages-stack edit-pages-stack";
  pagesEl.style.display = "none";
  viewerEl.appendChild(pagesEl);

  viewerEl.addEventListener("scroll", onEditScroll, { passive: true });
  setEditHooks({ goto: gotoEditPage, relayout: relayoutEditPages });
}

export function selectedObject(): be.EditObject | null {
  if (!selected) return null;
  const block = blocks[selected.page];
  return block?.objects.find((o) => o.id === selected?.id) ?? null;
}

export function isDirty() { return dirty; }
export function currentEditTool(): EditTool { return editTool; }

export function setEditTool(t: EditTool) {
  editTool = t;
  drawAllObjects();
  emit("mode");
}

export async function enterEdit(): Promise<boolean> {
  if (!app.pdfPath || !isTauri()) {
    status("Edit mode needs the desktop app");
    return false;
  }
  try {
    await be.editOpen(app.pdfPath);
  } catch (e) {
    status("Could not open for editing: " + e);
    window.alert("Could not open for editing:\n" + e);
    return false;
  }

  dirty = false;
  selected = null;
  editTool = "select";
  closeTextEditor();
  setVisible(false);
  pagesEl.style.display = "block";

  await buildEditStack();
  gotoEditPage(app.page);
  renderVisibleEditPages();
  emit("mode");
  status("Edit mode — scroll pages, double-click text to retype, T adds text");
  return true;
}

export function leaveEdit() {
  closeTextEditor();
  pagesEl.style.display = "none";
  selected = null;
  setVisible(true);
  renderPage();
}

async function buildEditStack() {
  pagesEl.innerHTML = "";
  blocks = [];
  for (let i = 0; i < app.pageCount; i++) {
    const wrap = document.createElement("div");
    wrap.className = "page-wrap page-shadow";

    const img = document.createElement("img");
    img.className = "pdf-canvas";
    img.draggable = false;

    const overlay = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    overlay.classList.add("overlay");
    overlay.dataset.page = `${i}`;

    wrap.append(img, overlay);
    pagesEl.appendChild(wrap);

    const block: EditBlock = {
      index: i,
      wrap,
      img,
      overlay,
      pw: 612,
      ph: 792,
      objects: [],
      rectEls: new Map(),
      renderedScale: -1,
      rendering: false,
    };
    blocks.push(block);
    attachPointer(block);
  }

  await seedPageSizes();
  for (const block of blocks) layoutBlock(block);
}

async function seedPageSizes() {
  // PDF.js is already loaded in normal app flow, so use it for fast layout
  // sizing. If unavailable, visible PDFium renders will correct dimensions.
  if (!app.pdfDoc) return;
  for (const block of blocks) {
    try {
      const page = await app.pdfDoc.getPage(block.index + 1);
      const vp = page.getViewport({ scale: 1 });
      block.pw = vp.width;
      block.ph = vp.height;
    } catch {
      /* PDFium render will fill this in later. */
    }
  }
}

function layoutBlock(block: EditBlock) {
  const w = block.pw * app.scale;
  const h = block.ph * app.scale;
  block.wrap.style.width = `${w}px`;
  block.wrap.style.height = `${h}px`;
  block.img.style.width = `${w}px`;
  block.img.style.height = `${h}px`;
  block.overlay.setAttribute("width", `${w}`);
  block.overlay.setAttribute("height", `${h}`);
  block.overlay.setAttribute("viewBox", `0 0 ${block.pw} ${block.ph}`);
  block.renderedScale = -1;
}

async function renderEditBlock(block: EditBlock, force = false) {
  if (block.rendering) return;
  if (!force && block.renderedScale === app.scale) return;
  block.rendering = true;
  const myScale = app.scale;
  try {
    const res = await be.editRenderPage(block.index, myScale);
    block.img.src = "data:image/png;base64," + res.png;
    if (block.pw !== res.width || block.ph !== res.height) {
      block.pw = res.width;
      block.ph = res.height;
      layoutBlock(block);
    }
    block.objects = await be.editObjects(block.index);
    block.renderedScale = myScale;
    drawObjects(block);
  } catch (e) {
    status(`Render failed on page ${block.index + 1}: ${e}`);
  } finally {
    block.rendering = false;
  }
  if (app.scale !== myScale) renderEditBlock(block, true);
}

function renderVisibleEditPages() {
  const top = viewerEl.scrollTop - 450;
  const bot = viewerEl.scrollTop + viewerEl.clientHeight + 450;
  for (const block of blocks) {
    const y = block.wrap.offsetTop;
    if (y + block.wrap.offsetHeight >= top && y <= bot) renderEditBlock(block);
  }
}

function relayoutEditPages() {
  const anchorPage = app.page;
  for (const block of blocks) layoutBlock(block);
  const anchor = blocks[anchorPage];
  if (anchor) viewerEl.scrollTop = Math.max(0, anchor.wrap.offsetTop - 14);
  renderVisibleEditPages();
  drawAllObjects();
}

function gotoEditPage(page: number) {
  const block = blocks[page];
  if (!block) return;
  viewerEl.scrollTo({ top: Math.max(0, block.wrap.offsetTop - 14), behavior: "auto" });
  renderVisibleEditPages();
}

function onEditScroll() {
  if (app.mode !== "edit") return;
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    updateEditCurrentPage();
    renderVisibleEditPages();
  });
}

function updateEditCurrentPage() {
  if (!blocks.length) return;
  const center = viewerEl.scrollTop + viewerEl.clientHeight / 2;
  let cur = 0;
  for (const block of blocks) {
    if (block.wrap.offsetTop <= center) cur = block.index;
    else break;
  }
  if (cur !== app.page) {
    app.page = cur;
    emit("page");
  }
}

function drawAllObjects() {
  for (const block of blocks) drawObjects(block);
}

function drawObjects(block: EditBlock) {
  while (block.overlay.firstChild) block.overlay.removeChild(block.overlay.firstChild);
  block.rectEls.clear();
  for (const o of block.objects) {
    const [x0, y0, x1, y1] = o.bbox;
    const r = document.createElementNS(SVG_NS, "rect") as SVGRectElement;
    r.setAttribute("x", `${x0}`);
    r.setAttribute("y", `${y0}`);
    r.setAttribute("width", `${Math.max(1, x1 - x0)}`);
    r.setAttribute("height", `${Math.max(1, y1 - y0)}`);
    r.setAttribute("fill", "transparent");
    const isSel = selected?.page === block.index && selected.id === o.id;
    const stroke = isSel ? "var(--accent)"
      : o.kind === "image" ? "#18b96b"
      : o.kind === "text" ? "#5b82f7" : "#9aa1ac";
    r.setAttribute("stroke", stroke);
    r.setAttribute("stroke-width", isSel ? "1.8" : "1");
    r.setAttribute("stroke-opacity", isSel ? "1" : "0.55");
    if (!isSel) r.setAttribute("stroke-dasharray", "4 3");
    r.setAttribute("data-id", `${o.id}`);
    r.style.cursor = editTool === "select" ? "move" : "text";
    r.style.pointerEvents = "all";
    block.overlay.appendChild(r);
    block.rectEls.set(o.id, r);
  }
}

function toPoint(e: PointerEvent, block: EditBlock): [number, number] {
  const rect = block.overlay.getBoundingClientRect();
  return [
    ((e.clientX - rect.left) / rect.width) * block.pw,
    ((e.clientY - rect.top) / rect.height) * block.ph,
  ];
}

function hit(block: EditBlock, x: number, y: number): be.EditObject | null {
  for (let i = block.objects.length - 1; i >= 0; i--) {
    const [x0, y0, x1, y1] = block.objects[i].bbox;
    if (x >= x0 - 3 && x <= x1 + 3 && y >= y0 - 3 && y <= y1 + 3) {
      return block.objects[i];
    }
  }
  return null;
}

let editMenu: HTMLDivElement | null = null;
function closeEditMenu() { editMenu?.remove(); editMenu = null; }

function showEditMenu(
  clientX: number,
  clientY: number,
  block: EditBlock,
  o: be.EditObject | null,
  pt: [number, number],
) {
  closeEditMenu();
  const menu = document.createElement("div");
  menu.className = "popover edit-context";
  const item = (label: string, fn: () => void, danger = false) => {
    const it = document.createElement("div");
    it.className = "menu-item" + (danger ? " danger" : "");
    it.textContent = label;
    it.onclick = () => { closeEditMenu(); fn(); };
    menu.appendChild(it);
  };
  const sep = () => menu.appendChild(document.createElement("div")).className = "menu-sep";

  if (o) {
    if (o.kind === "text") {
      item("Edit text", () => beginTextEdit(block, o));
      item("Underline", () => applyDecorationToSelection("underline", true));
      item("Strikethrough", () => applyDecorationToSelection("strike", true));
      sep();
    }
    item("Add text here", () => beginNewText(block, pt[0], pt[1]));
    sep();
    item("Delete", () => deleteSelected(), true);
  } else {
    item("Add text here", () => beginNewText(block, pt[0], pt[1]));
  }

  document.body.appendChild(menu);
  // keep the menu on-screen
  const r = menu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - r.width - 8);
  const top = Math.min(clientY, window.innerHeight - r.height - 8);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;
  editMenu = menu;
  setTimeout(() =>
    document.addEventListener("pointerdown", function close(ev) {
      if (!menu.contains(ev.target as Node)) { closeEditMenu(); document.removeEventListener("pointerdown", close); }
    }), 0);
}

function attachPointer(block: EditBlock) {
  block.overlay.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (activeEditor) return;
    const [x, y] = toPoint(e as unknown as PointerEvent, block);
    const o = hit(block, x, y);
    app.page = block.index;
    selected = o ? { page: block.index, id: o.id } : null;
    drawAllObjects();
    emit("mode");
    showEditMenu(e.clientX, e.clientY, block, o, [x, y]);
  });

  block.overlay.addEventListener("pointerdown", (e) => {
    closeEditMenu();
    if (activeEditor) return;
    block.overlay.setPointerCapture(e.pointerId);
    app.page = block.index;
    emit("page");
    const [x, y] = toPoint(e, block);
    // Releasing capture lets the inline editor (created below) keep keyboard
    // focus — otherwise the trailing pointerup is delivered to the captured
    // overlay and focus falls back to <body>, instantly blurring the editor.
    const releaseCapture = () => {
      try { block.overlay.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    if (editTool === "text") {
      releaseCapture();
      beginNewText(block, x, y);
      return;
    }
    const h = hit(block, x, y);

    // Detect a double-click on the same text object ourselves (cross-platform).
    const now = Date.now();
    const isDouble =
      !!h &&
      h.kind === "text" &&
      h.id === lastDownId &&
      block.index === lastDownPage &&
      now - lastDownTime < 450;
    lastDownTime = now;
    lastDownId = h ? h.id : null;
    lastDownPage = block.index;

    selected = h ? { page: block.index, id: h.id } : null;
    drawAllObjects();
    emit("mode");
    if (isDouble && h) {
      releaseCapture();
      beginTextEdit(block, h);
      return;
    }
    if (h) {
      dragging = true;
      dragPage = block.index;
      dragId = h.id;
      startX = x;
      startY = y;
    }
  });

  block.overlay.addEventListener("pointermove", (e) => {
    if (!dragging || dragId === null || dragPage !== block.index) return;
    const [x, y] = toPoint(e, block);
    const r = block.rectEls.get(dragId);
    const o = block.objects.find((ob) => ob.id === dragId);
    if (r && o) {
      r.setAttribute("x", `${o.bbox[0] + (x - startX)}`);
      r.setAttribute("y", `${o.bbox[1] + (y - startY)}`);
    }
  });

  block.overlay.addEventListener("pointerup", async (e) => {
    if (!dragging || dragId === null || dragPage !== block.index) return;
    const [x, y] = toPoint(e, block);
    const dx = x - startX;
    const dy = y - startY;
    const id = dragId;
    dragging = false;
    dragId = null;
    dragPage = -1;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      try {
        await be.editMove(block.index, id, dx, dy);
        dirty = true;
        selected = { page: block.index, id };
        await refreshBlock(block, true);
      } catch (err) {
        status("Move failed: " + err);
        await refreshBlock(block, true);
      }
    }
  });
}

async function refreshBlock(block: EditBlock, force = true) {
  block.renderedScale = -1;
  await renderEditBlock(block, force);
  drawAllObjects();
  emit("mode");
}

function closeTextEditor() {
  activeEditor?.remove();
  activeEditor = null;
}

// In-place editor: a contentEditable laid directly over the text on the page
// (no popup). `rect` and `fontSizePts` are in PDF points; we scale to pixels.
function makeInlineEditor(
  block: EditBlock,
  rect: { x: number; y: number; w: number; h: number },
  value: string,
  fontSizePts: number,
  commit: (text: string) => Promise<void>,
  opts: { isNew?: boolean } = {},
) {
  closeTextEditor();
  const s = app.scale;
  const ed = document.createElement("div");
  ed.className = "inline-text-editor";
  ed.contentEditable = "true";
  ed.spellcheck = false;
  ed.textContent = value;
  ed.style.left = `${Math.max(0, rect.x * s)}px`;
  ed.style.top = `${Math.max(0, rect.y * s)}px`;
  ed.style.minWidth = `${Math.max(8, rect.w * s)}px`;
  ed.style.minHeight = `${Math.max(fontSizePts * s, rect.h * s)}px`;
  ed.style.fontSize = `${Math.max(8, fontSizePts * s)}px`;

  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const text = (ed.innerText ?? "").replace(/\n+$/, "");
    closeTextEditor();
    if (!save) {
      if (opts.isNew) setEditTool("select");
      return;
    }
    if (opts.isNew && !text.trim()) { setEditTool("select"); return; }
    await commit(text);
  };

  ed.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep keys out of the global shortcut handler
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
  });

  block.wrap.appendChild(ed);
  activeEditor = ed;

  const focusEditor = () => {
    if (done) return;
    ed.focus();
    const range = document.createRange();
    range.selectNodeContents(ed);
    if (opts.isNew) range.collapse(false); // caret at end for new text
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  focusEditor();
  // Re-grab focus after the click/pointer sequence settles, then arm blur-commit
  // (deferred so the trailing pointerup that opened us can't blur-close instantly).
  setTimeout(focusEditor, 0);
  setTimeout(() => { if (!done) ed.addEventListener("blur", () => finish(true)); }, 120);
}

function beginTextEdit(block: EditBlock, o: be.EditObject) {
  selected = { page: block.index, id: o.id };
  drawAllObjects();
  const [x0, y0, x1, y1] = o.bbox;
  makeInlineEditor(
    block,
    { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    o.text ?? "",
    o.font_size || (y1 - y0) || 12,
    async (text) => {
      if (text === (o.text ?? "")) return;
      try {
        await be.editSetText(block.index, o.id, text);
        dirty = true;
        await refreshBlock(block, true);
        status("Text updated");
      } catch (err) {
        status("Edit failed: " + err);
        window.alert("Could not edit this text object:\n" + err);
      }
    },
  );
  status("Editing text — Enter applies, Shift+Enter adds a line, Esc cancels");
}

function beginNewText(block: EditBlock, x: number, y: number) {
  selected = null;
  drawAllObjects();
  const size = 16;
  makeInlineEditor(
    block,
    { x, y, w: 120, h: size },
    "",
    size,
    async (text) => {
      try {
        await be.editInsertText(block.index, x, y, text, size);
        dirty = true;
        setEditTool("select");
        await refreshBlock(block, true);
        status("Text inserted");
      } catch (err) {
        status("Insert failed: " + err);
        window.alert("Could not insert text:\n" + err);
      }
    },
    { isNew: true },
  );
  status("Type new text — Enter applies, Shift+Enter adds a line, Esc cancels");
}

export async function undoEdit() {
  try {
    if (await be.editUndo()) {
      invalidateAll();
      renderVisibleEditPages();
      status("Undo");
    } else status("Nothing to undo");
  } catch (e) { status("Undo failed: " + e); }
}

export async function redoEdit() {
  try {
    if (await be.editRedo()) {
      invalidateAll();
      renderVisibleEditPages();
      status("Redo");
    } else status("Nothing to redo");
  } catch (e) { status("Redo failed: " + e); }
}

function invalidateAll() {
  for (const block of blocks) {
    block.renderedScale = -1;
    block.objects = [];
  }
}

export function deselect() {
  closeTextEditor();
  if (selected !== null) {
    selected = null;
    drawAllObjects();
    emit("mode");
  }
}

export async function deleteSelected() {
  if (!selected) return;
  const block = blocks[selected.page];
  if (!block) return;
  try {
    await be.editDelete(selected.page, selected.id);
    dirty = true;
    selected = null;
    await refreshBlock(block, true);
  } catch (err) {
    status("Delete failed: " + err);
  }
}

export async function editText() {
  const o = selectedObject();
  if (!o || o.kind !== "text" || !selected) {
    status("Select a text object first");
    return;
  }
  const block = blocks[selected.page];
  if (block) beginTextEdit(block, o);
}

export async function applyStyleToSelection(opts: be.StyleOpts) {
  if (!selected) { status("Select a text object first"); return; }
  const block = blocks[selected.page];
  const o = selectedObject();
  if (!block || !o || o.kind !== "text") {
    status("Select a text object first");
    return;
  }
  const page = selected.page;
  try {
    await be.editSetStyle(page, selected.id, opts);
    dirty = true;
    block.renderedScale = -1;
    await renderEditBlock(block, true);
    // A font change recreates the object as the page's last object; reselect it
    // so the properties bar keeps tracking the same text.
    if (opts.font) {
      selected = block.objects.length
        ? { page, id: block.objects[block.objects.length - 1].id }
        : null;
    }
    drawAllObjects();
    emit("mode");
    status("Style updated");
  } catch (err) {
    status("Style change failed: " + err);
    window.alert("Could not change the text style:\n" + err);
  }
}

export async function applyDecorationToSelection(
  kind: be.DecorationKind,
  on: boolean,
  color: [number, number, number] = [0, 0, 0],
) {
  if (!selected) { status("Select a text object first"); return; }
  const block = blocks[selected.page];
  const o = selectedObject();
  if (!block || !o || o.kind !== "text") {
    status("Select a text object first");
    return;
  }
  try {
    await be.editSetDecoration(selected.page, selected.id, kind, on, color);
    dirty = true;
    block.renderedScale = -1;
    await renderEditBlock(block, true);
    drawAllObjects();
    emit("mode");
    status(`${kind === "strike" ? "Strikethrough" : "Underline"} ${on ? "added" : "removed"}`);
  } catch (err) {
    status("Decoration failed: " + err);
    window.alert("Could not change the decoration:\n" + err);
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
