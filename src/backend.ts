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
