//! Tauri backend for PDF Studio.
//!
//! Native responsibilities: file + sidecar read/write, and PDF metadata via
//! `lopdf`. Rendering and editing happen in the webview (PDF.js + pdf-lib).

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Sidecar path next to a PDF: `foo.pdf` -> `foo.annot.json`.
fn sidecar_path(pdf_path: &str) -> PathBuf {
    Path::new(pdf_path).with_extension("annot.json")
}

/// Read a file and return its bytes as base64 (robust over the IPC bridge).
#[tauri::command]
fn read_file_b64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    Ok(STANDARD.encode(bytes))
}

/// Write base64 bytes to a path.
#[tauri::command]
fn write_file_b64(path: String, data_b64: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("decode: {e}"))?;
    fs::write(&path, bytes).map_err(|e| format!("write {path}: {e}"))
}

/// Load the JSON sidecar for a PDF, if present.
#[tauri::command]
fn load_sidecar(pdf_path: String) -> Result<Option<String>, String> {
    let p = sidecar_path(&pdf_path);
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(&p)
        .map(Some)
        .map_err(|e| format!("read sidecar: {e}"))
}

/// Save the JSON sidecar for a PDF.
#[tauri::command]
fn save_sidecar(pdf_path: String, json: String) -> Result<(), String> {
    let p = sidecar_path(&pdf_path);
    fs::write(&p, json).map_err(|e| format!("write sidecar: {e}"))
}

#[derive(Serialize)]
struct PdfInfo {
    page_count: usize,
    title: Option<String>,
    encrypted: bool,
}

/// Read basic metadata with lopdf (demonstrates native PDF handling).
#[tauri::command]
fn pdf_info(path: String) -> Result<PdfInfo, String> {
    let doc = lopdf::Document::load(&path).map_err(|e| format!("load pdf: {e}"))?;
    let page_count = doc.get_pages().len();
    let encrypted = doc.trailer.get(b"Encrypt").is_ok();
    let title = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|o| o.as_reference().ok())
        .and_then(|id| doc.get_object(id).ok())
        .and_then(|o| o.as_dict().ok())
        .and_then(|d| d.get(b"Title").ok())
        .and_then(|o| o.as_str().ok())
        .map(|s| String::from_utf8_lossy(s).into_owned());
    Ok(PdfInfo {
        page_count,
        title,
        encrypted,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file_b64,
            write_file_b64,
            load_sidecar,
            save_sidecar,
            pdf_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PDF Studio");
}
