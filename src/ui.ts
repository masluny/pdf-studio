import {
  app, on, emit, status, undo, redo, uid, changed, remapPages,
  setNotes, setReply, setResolved, comment, getAnnotation, removeAnnotation,
  loadSidecarJson, saveNow, DEFAULT_COLORS, PRESET_COLORS, Tool, Annotation,
} from "./state";
import { icon } from "./icons";
import {
  mountViewer, loadPdfBytes, renderPage, gotoPage, zoomIn, zoomOut, fitWidth,
  renderThumb, getOutlineTree, runSearch, nextMatch, prevMatch, clearSearch,
  renderOverlay, OutlineNode,
} from "./pdfview";
import { initTools, deleteSelected } from "./tools";
import {
  openPdfDialog, savePdfDialog, readFile, writeFile, loadSidecar, isTauri,
} from "./backend";
import * as edit from "./editor";
import {
  initEditMode, enterEdit, leaveEdit, setEditTool, editText,
  deleteSelected as editDeleteSelected, saveEdited, isDirty, selectedObject,
  undoEdit, redoEdit, deselect as editDeselect,
} from "./editmode";
import { startupFile } from "./backend";

const TOOLS: [Tool, string, string, string][] = [
  ["select", "select", "Select / move", "V"],
  ["highlight", "highlight", "Highlight", "H"],
  ["text", "text", "Text box", "T"],
  ["rect", "box", "Rectangle", "R"],
  ["ellipse", "ellipse", "Ellipse", "E"],
  ["line", "line", "Line", "L"],
  ["pen", "pen", "Pen", "P"],
  ["arrow", "arrow", "Arrow", "A"],
  ["note", "note", "Sticky note", "N"],
  ["redact", "redact", "Redact / whiteout", "K"],
];
const KIND_LABELS: Record<string, string> = {
  highlight: "Highlight", text: "Text", rect: "Box", ellipse: "Ellipse",
  line: "Line", pen: "Pen", arrow: "Arrow", note: "Note", redact: "Redaction",
};

function h(tag: string, cls = "", html = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}
function iconBtn(name: string, title: string, onClick: () => void, cls = "btn"): HTMLButtonElement {
  const b = h("button", cls, icon(name)) as HTMLButtonElement;
  b.title = title;
  b.onclick = onClick;
  return b;
}

// element refs
let pageInput!: HTMLInputElement;
let pageTotal!: HTMLElement;
let zoomLabel!: HTMLElement;
let swatchEl!: HTMLElement;
let widthInput!: HTMLInputElement;
let segBtns: Record<string, HTMLElement> = {};
let statusEl!: HTMLElement;
let thumbsEl!: HTMLElement;
let outlineEl!: HTMLElement;
let commentsEl!: HTMLElement;
let notesArea!: HTMLTextAreaElement;
let findBar!: HTMLElement;
let findInput!: HTMLInputElement;
let findCount!: HTMLElement;
let docControls: HTMLElement[] = [];
let editInfoEl!: HTMLElement;
const modeBtns: { view?: HTMLElement; edit?: HTMLElement } = {};

export function buildUI() {
  const root = document.getElementById("app")!;
  document.documentElement.setAttribute("data-theme", app.theme);

  const grid = h("div", "app-grid");
  grid.appendChild(buildHeader());
  const body = h("div", "body-grid");
  body.appendChild(buildSidebar());
  const col = h("div");
  col.style.cssText = "display:flex;flex-direction:column;min-height:0;";
  col.appendChild(buildFindBar());
  const viewer = h("div");
  viewer.style.flex = "1";
  viewer.style.minHeight = "0";
  col.appendChild(viewer);
  body.appendChild(col);
  grid.appendChild(body);
  grid.appendChild(buildStatus());
  root.appendChild(grid);

  mountViewer(viewer);
  initEditMode(viewer);
  initTools();
  setTool("select");
  setEnabled(false);
  wireEvents();
  wireShortcuts();
  status("Open a PDF to begin  ·  ⌘O");
}

// ------------------------------------------------------------------ header
function buildHeader(): HTMLElement {
  const bar = h("div", "header");

  bar.appendChild(iconBtn("sidebar", "Hide / show sidebar  ·  ⌘B", toggleSidebar));
  bar.appendChild(iconBtn("open", "Open PDF  ·  ⌘O", openPdf));
  const save = iconBtn("save", "Save annotations  ·  ⌘S", () => { saveNow(); status("Annotations saved"); });
  bar.appendChild(save); docControls.push(save);

  const exportBtn = h("button", "btn-primary", icon("export") + "<span>Export</span>") as HTMLButtonElement;
  exportBtn.title = "Export PDF with marks baked in  ·  ⌘E";
  exportBtn.style.marginLeft = "2px";
  exportBtn.onclick = exportPdf;
  bar.appendChild(exportBtn); docControls.push(exportBtn);

  bar.appendChild(h("div", "divider"));

  // View / Edit mode toggle
  const modeSeg = h("div", "segment");
  const mkMode = (label: string, title: string, fn: () => void) => {
    const b = h("button", "seg-btn", label);
    b.style.width = "auto"; b.style.padding = "0 12px"; b.style.fontWeight = "600";
    b.title = title; b.onclick = fn;
    return b;
  };
  modeBtns.view = mkMode("View", "View & annotate", () => setMode("view"));
  modeBtns.view.classList.add("active");
  modeBtns.edit = mkMode("Edit", "Edit PDF content (text, images, objects)", () => setMode("edit"));
  modeSeg.append(modeBtns.view, modeBtns.edit);
  bar.appendChild(modeSeg); docControls.push(modeSeg);
  bar.appendChild(h("div", "divider"));

  // annotation tool segment (View mode)
  const seg = h("div", "segment view-only");
  for (const [tool, ic, label, key] of TOOLS) {
    const b = h("button", "seg-btn", icon(ic));
    b.title = `${label}  ·  ${key}`;
    b.onclick = () => setTool(tool);
    seg.appendChild(b);
    segBtns[tool] = b;
  }
  bar.appendChild(seg);

  // edit toolbar (Edit mode)
  const editSeg = h("div", "segment edit-only hidden");
  const eb = (inner: string, title: string, fn: () => void) => {
    const b = h("button", "seg-btn", inner);
    if (!inner.startsWith("<")) { b.style.width = "auto"; b.style.padding = "0 9px"; b.style.fontWeight = "600"; }
    b.title = title; b.onclick = fn;
    return b;
  };
  editSeg.append(
    eb(icon("select"), "Select / move (drag, Delete to remove)", () => { setEditTool("select"); status("Select tool"); }),
    eb(icon("text"), "Add text — click on the page", () => { setEditTool("text"); status("Click on the page to add text"); }),
    eb("Edit text", "Edit selected text object (or double-click)", () => editText()),
    eb(icon("trash"), "Delete selected object", () => editDeleteSelected()),
    eb("↶", "Undo  ·  ⌘Z", () => undoEdit()),
    eb("↷", "Redo  ·  ⌘⇧Z", () => redoEdit()),
  );
  bar.appendChild(editSeg);
  editInfoEl = h("span", "pill edit-only hidden", "");
  bar.appendChild(editInfoEl);
  const saveEditBtn = h("button", "btn-primary edit-only hidden", icon("save") + "<span>Save PDF</span>") as HTMLButtonElement;
  saveEditBtn.style.marginLeft = "2px"; saveEditBtn.title = "Save the edited PDF";
  saveEditBtn.onclick = () => saveEdited();
  bar.appendChild(saveEditBtn);

  // colour + width (View mode)
  swatchEl = h("div", "swatch view-only");
  swatchEl.title = "Annotation colour";
  swatchEl.onclick = openColorMenu;
  bar.appendChild(swatchEl); docControls.push(swatchEl);

  widthInput = h("input", "field view-only") as HTMLInputElement;
  widthInput.type = "number"; widthInput.min = "0.5"; widthInput.max = "20"; widthInput.step = "0.5";
  widthInput.value = "2"; widthInput.style.width = "56px"; widthInput.title = "Stroke width";
  widthInput.oninput = () => { app.width = parseFloat(widthInput.value) || 2; };
  bar.appendChild(widthInput); docControls.push(widthInput);

  bar.appendChild(h("div", "", "")).style.flex = "1";

  // zoom
  const zo = iconBtn("zoomOut", "Zoom out  ·  ⌘−", zoomOut); bar.appendChild(zo); docControls.push(zo);
  zoomLabel = h("span", "pill", "100%"); zoomLabel.style.width = "44px"; zoomLabel.style.textAlign = "center";
  bar.appendChild(zoomLabel);
  const zi = iconBtn("zoomIn", "Zoom in  ·  ⌘+", zoomIn); bar.appendChild(zi); docControls.push(zi);
  const ft = iconBtn("fit", "Fit width  ·  ⌘0", fitWidth); bar.appendChild(ft); docControls.push(ft);

  bar.appendChild(h("div", "divider"));

  // page nav
  const prev = iconBtn("chevLeft", "Previous page", () => gotoPage(app.page - 1)); bar.appendChild(prev); docControls.push(prev);
  pageInput = h("input", "field") as HTMLInputElement;
  pageInput.type = "number"; pageInput.value = "1"; pageInput.style.width = "46px"; pageInput.style.textAlign = "center";
  pageInput.onchange = () => gotoPage((parseInt(pageInput.value) || 1) - 1);
  bar.appendChild(pageInput); docControls.push(pageInput);
  pageTotal = h("span", "pill", "/ 0"); bar.appendChild(pageTotal);
  const next = iconBtn("chevRight", "Next page", () => gotoPage(app.page + 1)); bar.appendChild(next); docControls.push(next);

  bar.appendChild(h("div", "divider"));
  const find = iconBtn("search", "Find  ·  ⌘F", toggleFind); bar.appendChild(find); docControls.push(find);
  bar.appendChild(iconBtn(app.theme === "dark" ? "sun" : "moon", "Toggle light / dark  ·  ⌘L", toggleTheme));
  return bar;
}

// ------------------------------------------------------------------ sidebar
function buildSidebar(): HTMLElement {
  const side = h("div", "sidebar");

  // find bar lives above the viewer, but we add it to the grid body via viewer; keep simple: put in sidebar? No — add to header area of viewer. We'll insert before viewer in body. Build separately.
  const tabbar = h("div", "tabbar");
  const panels: Record<string, HTMLElement> = {};
  const tabs = ["Pages", "Outline", "Comments", "Notes"];
  const tabEls: Record<string, HTMLElement> = {};
  for (const t of tabs) {
    const tb = h("button", "tab", t);
    tb.onclick = () => {
      for (const x of tabs) { tabEls[x].classList.toggle("active", x === t); panels[x].classList.toggle("active", x === t); }
    };
    tabbar.appendChild(tb); tabEls[t] = tb;
  }
  side.appendChild(tabbar);

  panels["Pages"] = buildPagesPanel();
  panels["Outline"] = buildOutlinePanel();
  panels["Comments"] = buildCommentsPanel();
  panels["Notes"] = buildNotesPanel();
  for (const t of tabs) side.appendChild(panels[t]);
  tabEls["Pages"].classList.add("active");
  panels["Pages"].classList.add("active");
  return side;
}

function buildPagesPanel(): HTMLElement {
  const p = h("div", "tab-panel");
  const ops = h("div", "pageops");
  const opSpecs: [string, string, () => void][] = [
    ["rotateCcw", "Rotate left", () => rotate(-90)],
    ["rotateCw", "Rotate right", () => rotate(90)],
    ["chevUp", "Move page up", () => movePage(-1)],
    ["chevDown", "Move page down", () => movePage(1)],
    ["duplicate", "Duplicate page", duplicatePage],
    ["plus", "Insert blank page", insertBlank],
    ["merge", "Merge PDF…", mergePdf],
    ["extract", "Extract page…", extractPage],
    ["trash", "Delete page", deletePage],
  ];
  for (const [ic, title, fn] of opSpecs) ops.appendChild(iconBtn(ic, title, fn));
  p.appendChild(ops);
  thumbsEl = h("div", "thumbs");
  p.appendChild(thumbsEl);
  return p;
}

function buildOutlinePanel(): HTMLElement {
  const p = h("div", "tab-panel");
  outlineEl = h("div", "list");
  p.appendChild(outlineEl);
  return p;
}

function buildCommentsPanel(): HTMLElement {
  const p = h("div", "tab-panel");
  const sel = h("select", "field") as HTMLSelectElement;
  sel.style.margin = "10px"; sel.style.height = "32px";
  for (const o of ["All", "This page", "Unresolved", "Resolved"]) {
    const opt = document.createElement("option"); opt.textContent = o; sel.appendChild(opt);
  }
  sel.onchange = () => { app.commentFilter = sel.value; refreshComments(); };
  p.appendChild(sel);
  commentsEl = h("div", "list"); commentsEl.style.flex = "1";
  p.appendChild(commentsEl);
  const row = h("div", "cbtn-row");
  const reply = h("button", "ghost-sm", "Reply"); reply.onclick = doReply;
  const resolve = h("button", "ghost-sm", "Resolve"); resolve.onclick = doResolve;
  const del = h("button", "ghost-sm", "Delete"); del.onclick = () => { if (app.selectedId) { removeAnnotation(app.selectedId); } };
  row.append(reply, resolve, del);
  p.appendChild(row);
  return p;
}

function buildNotesPanel(): HTMLElement {
  const p = h("div", "tab-panel");
  notesArea = h("textarea", "notes-area") as HTMLTextAreaElement;
  notesArea.placeholder = "Document notes — saved alongside this PDF…";
  notesArea.oninput = () => setNotes(notesArea.value);
  p.appendChild(notesArea);
  return p;
}

function buildStatus(): HTMLElement {
  const s = h("div", "statusbar");
  statusEl = h("span", "", "");
  const right = h("span", "pill", "");
  s.append(statusEl, right);
  on("status", (m) => (statusEl.textContent = m));
  on("annotations", () => (right.textContent = app.pdfPath ? `${app.annotations.length} mark(s)` : ""));
  return s;
}

// ------------------------------------------------------------------ find bar
function buildFindBar(): HTMLElement {
  findBar = h("div", "findbar");
  findInput = h("input", "field") as HTMLInputElement;
  findInput.placeholder = "Find in document…"; findInput.style.width = "260px";
  let t: number | undefined;
  findInput.oninput = () => { clearTimeout(t); t = window.setTimeout(() => runSearch(findInput.value), 200); };
  findInput.onkeydown = (e) => { if (e.key === "Enter") nextMatch(); if (e.key === "Escape") closeFind(); };
  findCount = h("span", "pill", "");
  const prev = h("button", "ghost-sm", "Prev"); prev.style.flex = "0 0 auto"; prev.onclick = prevMatch;
  const next = h("button", "ghost-sm", "Next"); next.style.flex = "0 0 auto"; next.onclick = nextMatch;
  const done = h("button", "ghost-sm", "Done"); done.style.flex = "0 0 auto"; done.onclick = closeFind;
  findBar.append(h("span", "", icon("search")), findInput, findCount, h("div", "", ""));
  (findBar.lastChild as HTMLElement).style.flex = "1";
  findBar.append(prev, next, done);
  on("search", () => {
    findCount.textContent = app.matches.length ? `${app.matchIndex + 1} / ${app.matches.length}` : (findInput.value ? "0" : "");
  });
  return findBar;
}

function toggleFind() {
  if (findBar.classList.contains("show")) closeFind();
  else { findBar.classList.add("show"); findInput.focus(); findInput.select(); }
}
function closeFind() {
  findBar.classList.remove("show"); findInput.value = ""; clearSearch();
}

// ------------------------------------------------------------------ actions
async function openPdf() {
  const path = await openPdfDialog();
  if (path) await openPath(path);
}
function forceViewMode() {
  if (app.mode === "edit") leaveEdit();
  app.mode = "view";
  modeBtns.view?.classList.add("active");
  modeBtns.edit?.classList.remove("active");
  document.querySelectorAll(".view-only").forEach((e) => e.classList.remove("hidden"));
  document.querySelectorAll(".edit-only").forEach((e) => e.classList.add("hidden"));
}

export async function openPath(path: string) {
  try {
    forceViewMode();
    await saveNow();
    app.pdfPath = path;
    const bytes = await readFile(path);
    app.pdfBytes = bytes;
    loadSidecarJson(await loadSidecar(path));
    await loadPdfBytes(bytes.slice());
    app.page = 0;
    notesArea.value = app.notes;
    pageInput.value = "1"; pageTotal.textContent = `/ ${app.pageCount}`;
    setEnabled(true);
    fitWidth();
    refreshThumbs(); refreshOutline(); refreshComments();
    status(`Opened ${path.split("/").pop()}  ·  ${app.pageCount} pages  ·  ${app.annotations.length} mark(s)`);
  } catch (e) {
    status("Failed to open: " + e);
  }
}

async function exportPdf() {
  if (!app.pdfBytes) return;
  const def = (app.pdfPath ?? "document.pdf").replace(/\.pdf$/i, ".annotated.pdf");
  const out = await savePdfDialog(def);
  if (!out) return;
  status("Exporting…");
  const bytes = await edit.exportAnnotated(app.pdfBytes, app.annotations);
  await writeFile(out, bytes);
  status("Exported → " + out.split("/").pop());
}

async function reloadPdf(keepPage: number) {
  await loadPdfBytes(app.pdfBytes!.slice());
  app.page = Math.max(0, Math.min(keepPage, app.pageCount - 1));
  await renderPage();
  pageTotal.textContent = `/ ${app.pageCount}`;
  refreshThumbs(); refreshOutline(); refreshComments();
}

async function rotate(deg: number) {
  if (!app.pdfBytes) return;
  app.pdfBytes = await edit.rotatePage(app.pdfBytes, app.page, deg);
  await reloadPdf(app.page);
  status("Rotated page " + (app.page + 1));
}
async function deletePage() {
  if (!app.pdfBytes || app.pageCount <= 1) return;
  const idx = app.page;
  const order = Array.from({ length: app.pageCount }, (_, i) => i).filter((i) => i !== idx);
  app.pdfBytes = await edit.reorderPages(app.pdfBytes, order);
  remapPages((old) => { const ni = order.indexOf(old); return ni === -1 ? null : ni; });
  await reloadPdf(Math.min(idx, app.pageCount - 2));
}
async function movePage(delta: number) {
  if (!app.pdfBytes) return;
  const from = app.page, to = from + delta;
  if (to < 0 || to >= app.pageCount) return;
  const order = Array.from({ length: app.pageCount }, (_, i) => i);
  order.splice(to, 0, order.splice(from, 1)[0]);
  app.pdfBytes = await edit.reorderPages(app.pdfBytes, order);
  remapPages((old) => order.indexOf(old));
  await reloadPdf(to);
}
async function duplicatePage() {
  if (!app.pdfBytes) return;
  const idx = app.page;
  app.pdfBytes = await edit.duplicatePage(app.pdfBytes, idx);
  const copies = app.annotations.filter((a) => a.page === idx)
    .map((a) => ({ ...JSON.parse(JSON.stringify(a)), id: uid(), page: idx + 1 } as Annotation));
  remapPages((old) => (old >= idx + 1 ? old + 1 : old));
  app.annotations.push(...copies); changed();
  await reloadPdf(idx + 1);
}
async function insertBlank() {
  if (!app.pdfBytes) return;
  const at = app.page + 1;
  const [w, ht] = await edit.pageSize(app.pdfBytes, app.page);
  app.pdfBytes = await edit.insertBlank(app.pdfBytes, at, w, ht);
  remapPages((old) => (old >= at ? old + 1 : old));
  await reloadPdf(at);
}
async function mergePdf() {
  if (!app.pdfBytes) return;
  const path = await openPdfDialog();
  if (!path) return;
  const other = await readFile(path);
  const res = await edit.mergePdfBytes(app.pdfBytes, other);
  app.pdfBytes = res.bytes;
  await reloadPdf(app.page);
  status(`Merged ${res.added} page(s)`);
}
async function extractPage() {
  if (!app.pdfBytes) return;
  const def = (app.pdfPath ?? "page.pdf").replace(/\.pdf$/i, `.page${app.page + 1}.pdf`);
  const out = await savePdfDialog(def);
  if (!out) return;
  const bytes = await edit.extractPage(app.pdfBytes, app.page);
  await writeFile(out, bytes);
  status("Extracted page → " + out.split("/").pop());
}

// ------------------------------------------------------------------ tools/colour
function setTool(tool: Tool) {
  app.tool = tool;
  for (const [t] of TOOLS) segBtns[t].classList.toggle("active", t === tool);
  if (DEFAULT_COLORS[tool]) { app.color = DEFAULT_COLORS[tool]; updateSwatch(); }
  renderOverlay();
  status(`${KIND_LABELS[tool] ?? "Select"} tool`);
}

export function enterEditMode() { return setMode("edit"); }

async function setMode(m: "view" | "edit") {
  if (m === app.mode) return;
  if (!app.pdfPath) { status("Open a PDF first"); return; }
  if (m === "edit") {
    if (!isTauri()) { status("Editing requires the desktop app (PDFium engine)"); return; }
    const ok = await enterEdit();
    if (!ok) return;
  } else {
    if (isDirty() && !window.confirm("Discard unsaved content edits?")) return;
    leaveEdit();
  }
  app.mode = m;
  modeBtns.view?.classList.toggle("active", m === "view");
  modeBtns.edit?.classList.toggle("active", m === "edit");
  document.querySelectorAll(".view-only").forEach((e) => e.classList.toggle("hidden", m === "edit"));
  document.querySelectorAll(".edit-only").forEach((e) => e.classList.toggle("hidden", m !== "edit"));
  emit("mode");
}
function updateSwatch() { swatchEl.style.background = app.color; }

function openColorMenu() {
  document.querySelector(".popover")?.remove();
  const pop = h("div", "popover");
  const grid = h("div", "swatch-grid");
  for (const c of PRESET_COLORS) {
    const cell = h("div", "swatch-cell"); cell.style.background = c;
    cell.onclick = () => { app.color = c; updateSwatch(); pop.remove(); };
    grid.appendChild(cell);
  }
  pop.appendChild(grid);
  const custom = h("input", "") as HTMLInputElement;
  custom.type = "color"; custom.value = app.color; custom.style.marginTop = "8px"; custom.style.width = "100%";
  custom.oninput = () => { app.color = custom.value; updateSwatch(); };
  pop.appendChild(custom);
  const r = swatchEl.getBoundingClientRect();
  pop.style.left = `${r.left}px`; pop.style.top = `${r.bottom + 6}px`;
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener("pointerdown", function close(ev) {
    if (!pop.contains(ev.target as Node)) { pop.remove(); document.removeEventListener("pointerdown", close); }
  }), 0);
}

function toggleSidebar() {
  document.querySelector(".body-grid")?.classList.toggle("sidebar-hidden");
}

function toggleTheme() {
  app.theme = app.theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", app.theme);
  // rebuild header theme icon by reloading icon (find the theme button)
  emit("theme");
}

// ------------------------------------------------------------------ sidebar refresh
function refreshThumbs() {
  thumbsEl.innerHTML = "";
  for (let i = 0; i < app.pageCount; i++) {
    const div = h("div", "thumb" + (i === app.page ? " active" : ""));
    const c = document.createElement("canvas");
    div.appendChild(c);
    div.appendChild(h("div", "num", `${i + 1}`));
    div.onclick = () => gotoPage(i);
    thumbsEl.appendChild(div);
    renderThumb(c, i);
  }
}
async function refreshOutline() {
  outlineEl.innerHTML = "";
  const tree = await getOutlineTree();
  if (!tree.length) {
    const e = h("div", "list-item resolved", "No bookmarks in this PDF");
    e.style.cursor = "default";
    outlineEl.appendChild(e); return;
  }
  const render = (nodes: OutlineNode[], depth: number) => {
    for (const n of nodes) {
      const it = h("div", "list-item");
      it.style.paddingLeft = `${9 + depth * 14}px`;
      it.textContent = n.title;
      it.onclick = () => gotoPage(n.page);
      outlineEl.appendChild(it);
      if (n.children.length) render(n.children, depth + 1);
    }
  };
  render(tree, 0);
}
function refreshComments() {
  if (!commentsEl) return;
  commentsEl.innerHTML = "";
  const mode = app.commentFilter;
  for (const a of app.annotations) {
    const c = comment(a.id);
    if (mode === "Unresolved" && c.resolved) continue;
    if (mode === "Resolved" && !c.resolved) continue;
    if (mode === "This page" && a.page !== app.page) continue;
    const it = h("div", "list-item" + (c.resolved ? " resolved" : "") + (a.id === app.selectedId ? " sel" : ""));
    const dot = h("div", "dot"); dot.style.background = a.color;
    let label = `Page ${a.page + 1} · ${KIND_LABELS[a.kind] ?? a.kind}`;
    const body = a.text || c.reply;
    if (body) label += " — " + body.split("\n")[0].slice(0, 26);
    if (c.resolved) label = "✓ " + label;
    const span = h("span", "", ""); span.textContent = label;
    it.append(dot, span);
    it.onclick = () => { app.selectedId = a.id; gotoPage(a.page); renderOverlay(); refreshComments(); };
    commentsEl.appendChild(it);
  }
}
function doReply() {
  if (!app.selectedId) { status("Select a mark first"); return; }
  const cur = comment(app.selectedId).reply;
  const t = window.prompt("Reply:", cur);
  if (t !== null) { setReply(app.selectedId, t); refreshComments(); }
}
function doResolve() {
  if (!app.selectedId) { status("Select a mark first"); return; }
  setResolved(app.selectedId, !comment(app.selectedId).resolved);
  refreshComments();
}

function setEnabled(on_: boolean) {
  for (const el of docControls) (el as HTMLButtonElement).disabled = !on_;
  for (const t in segBtns) (segBtns[t] as HTMLButtonElement).disabled = !on_;
}

// ------------------------------------------------------------------ events
function wireEvents() {
  on("doc", () => {
    pageTotal.textContent = `/ ${app.pageCount}`;
    pageInput.value = `${app.page + 1}`;
  });
  on("page", () => {
    pageInput.value = `${app.page + 1}`;
    zoomLabel.textContent = `${Math.round(app.scale * 100)}%`;
    thumbsEl?.querySelectorAll(".thumb").forEach((t, i) => t.classList.toggle("active", i === app.page));
    if (app.commentFilter === "This page") refreshComments();
  });
  on("annotations", () => refreshComments());
  on("theme", () => {
    // swap moon/sun icon: find last header button
    const btns = document.querySelectorAll(".header > .btn");
    const last = btns[btns.length - 1] as HTMLElement;
    if (last) last.innerHTML = icon(app.theme === "dark" ? "sun" : "moon");
  });
  on("mode", () => {
    if (app.mode !== "edit") { editInfoEl.textContent = ""; return; }
    const o = selectedObject();
    editInfoEl.textContent = o
      ? (o.kind === "text" ? `text · ${Math.round(o.font_size || 0)}pt` : o.kind)
      : "no selection";
  });
}

function wireShortcuts() {
  window.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    const target = e.target as HTMLElement;
    const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
    if (meta && e.key === "o") { e.preventDefault(); openPdf(); }
    else if (meta && e.key === "s") { e.preventDefault(); saveNow(); status("Saved"); }
    else if (meta && e.key === "e") { e.preventDefault(); exportPdf(); }
    else if (meta && e.key === "f") { e.preventDefault(); toggleFind(); }
    else if (meta && e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (app.mode === "edit") redoEdit(); else { redo(); renderOverlay(); }
    }
    else if (meta && e.key === "z") {
      e.preventDefault();
      if (app.mode === "edit") undoEdit(); else { undo(); renderOverlay(); }
    }
    else if (e.key === "Escape" && app.mode === "edit") { editDeselect(); }
    else if (meta && e.key === "l") { e.preventDefault(); toggleTheme(); }
    else if (meta && e.key === "b") { e.preventDefault(); toggleSidebar(); }
    else if (meta && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomIn(); }
    else if (meta && e.key === "-") { e.preventDefault(); zoomOut(); }
    else if (meta && e.key === "0") { e.preventDefault(); fitWidth(); }
    else if (!typing && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      if (app.mode === "edit") editDeleteSelected(); else deleteSelected();
    }
    else if (!typing && !meta && app.mode === "view" && app.pdfDoc) {
      const t = TOOLS.find(([, , , k]) => k.toLowerCase() === e.key.toLowerCase());
      if (t) setTool(t[0]);
    }
  });
}

