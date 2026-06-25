// Thin wrappers over the Rust commands, with a browser fallback so the UI can
// also run in a plain Vite dev server (for development / screenshots).

import { invoke } from "@tauri-apps/api/core";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export async function openPdfDialog(): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const res = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    return (res as string) ?? null;
  }
  // Browser fallback: a bundled sample.
  return "/sample.pdf";
}

export async function savePdfDialog(defaultPath: string): Promise<string | null> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return (await save({ defaultPath, filters: [{ name: "PDF", extensions: ["pdf"] }] })) ?? null;
  }
  return defaultPath;
}

export async function readFile(path: string): Promise<Uint8Array> {
  if (isTauri()) {
    const b64 = await invoke<string>("read_file_b64", { path });
    return b64ToBytes(b64);
  }
  const resp = await fetch(path);
  return new Uint8Array(await resp.arrayBuffer());
}

export async function writeFile(path: string, bytes: Uint8Array): Promise<void> {
  if (isTauri()) {
    await invoke("write_file_b64", { path, dataB64: bytesToB64(bytes) });
    return;
  }
  // Browser: trigger a download.
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() ?? "document.pdf";
  a.click();
  URL.revokeObjectURL(url);
}

export async function loadSidecar(pdfPath: string): Promise<string | null> {
  if (isTauri()) {
    return await invoke<string | null>("load_sidecar", { pdfPath });
  }
  return localStorage.getItem("sidecar:" + pdfPath);
}

export async function saveSidecar(pdfPath: string, json: string): Promise<void> {
  if (isTauri()) {
    await invoke("save_sidecar", { pdfPath, json });
    return;
  }
  localStorage.setItem("sidecar:" + pdfPath, json);
}

export async function pdfInfo(path: string): Promise<{ page_count: number } | null> {
  if (isTauri()) {
    try {
      return await invoke("pdf_info", { path });
    } catch {
      return null;
    }
  }
  return null;
}

// ---- PDFium content-editing commands (Edit mode; Tauri only) --------------
export interface EditObject {
  id: number;
  kind: "text" | "image" | "path" | "other";
  bbox: [number, number, number, number];
  text?: string | null;
  font_size?: number | null;
  color?: string | null;
}

export const editOpen = (path: string) => invoke<number>("edit_open", { path });
export const editObjects = (page: number) => invoke<EditObject[]>("edit_objects", { page });
export interface RenderResult { png: string; width: number; height: number; }
export const editRenderPage = (page: number, scale: number) =>
  invoke<RenderResult>("edit_render_page", { page, scale });
export const editSetText = (page: number, id: number, text: string) =>
  invoke("edit_set_text", { page, id, text });
export const editMove = (page: number, id: number, dx: number, dy: number) =>
  invoke("edit_move", { page, id, dx, dy });
export const editSetBbox = (page: number, id: number, bbox: [number, number, number, number]) =>
  invoke("edit_set_bbox", { page, id, bbox });
export const editDelete = (page: number, id: number) => invoke("edit_delete", { page, id });
export const editInsertText = (page: number, x: number, y: number, text: string, size: number) =>
  invoke("edit_insert_text", { page, x, y, text, size });
export const editReplaceImage = (page: number, id: number, imageB64: string) =>
  invoke("edit_replace_image", { page, id, imageB64 });
export const editSave = (path: string) => invoke("edit_save", { path });
export const editUndo = () => invoke<boolean>("edit_undo");
export const editRedo = () => invoke<boolean>("edit_redo");
export const startupFile = async (): Promise<string | null> => {
  if (!isTauri()) return null;
  try { return (await invoke<string | null>("startup_file")) ?? null; } catch { return null; }
};
export const startupAutoedit = async (): Promise<boolean> => {
  if (!isTauri()) return false;
  try { return !!(await invoke<boolean>("startup_autoedit")); } catch { return false; }
};
export const dbgLog = (msg: string) => {
  if (isTauri()) invoke("dbg_log", { msg }).catch(() => {});
  // eslint-disable-next-line no-console
  console.log("[dbg]", msg);
};
