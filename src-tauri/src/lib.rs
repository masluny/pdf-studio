//! Tauri backend for PDF Studio.
//!
//! Native responsibilities: file + sidecar read/write, and PDF metadata via
//! `lopdf`. Rendering and editing happen in the webview (PDF.js + pdf-lib).

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

mod pdf_edit;

/// Current in-memory PDF bytes for Edit mode (the editable source of truth),
/// plus undo/redo history of byte snapshots.
#[derive(Default)]
struct EditState {
    bytes: Mutex<Vec<u8>>,
    undo: Mutex<Vec<Vec<u8>>>,
    redo: Mutex<Vec<Vec<u8>>>,
}

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

// ----------------------------------------------------------- PDFium edit mode
/// Locate the directory containing the PDFium dynamic library.
fn pdfium_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(d) = app.path().resource_dir() {
        candidates.push(d.clone());
        candidates.push(d.join("_up_"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe.parent() {
            candidates.push(p.to_path_buf());
            // macOS bundle: Contents/MacOS/<bin> -> Contents/Resources, Contents/Frameworks
            if let Some(contents) = p.parent() {
                candidates.push(contents.join("Resources"));
                candidates.push(contents.join("Frameworks"));
            }
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    for d in &candidates {
        if pdf_edit::platform_lib_path(d).exists() {
            return Ok(d.clone());
        }
    }
    let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    Err(format!("PDFium library not found. Looked in: {}", tried.join("; ")))
}

/// PDFium can only be initialized once per process, so bind it once and share
/// it (the `thread_safe` feature serializes access across command threads).
fn pdfium(app: &tauri::AppHandle) -> Result<&'static pdfium_render::prelude::Pdfium, String> {
    use std::sync::OnceLock;
    static PDFIUM: OnceLock<pdfium_render::prelude::Pdfium> = OnceLock::new();
    if let Some(p) = PDFIUM.get() {
        return Ok(p);
    }
    let bound = pdf_edit::bind(&pdfium_dir(app)?)?;
    let _ = PDFIUM.set(bound);
    PDFIUM.get().ok_or_else(|| "pdfium initialization race".to_string())
}

#[tauri::command]
fn edit_open(app: tauri::AppHandle, state: tauri::State<EditState>, path: String) -> Result<usize, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let pd = pdfium(&app).map_err(|e| {
        eprintln!("[pdf-studio] edit_open: PDFium load failed: {e}");
        e
    })?;
    let count = pdf_edit::page_count(pd, &bytes)?;
    eprintln!("[pdf-studio] edit_open ok: {count} pages");
    *state.bytes.lock().unwrap() = bytes;
    state.undo.lock().unwrap().clear();
    state.redo.lock().unwrap().clear();
    Ok(count as usize)
}

/// Was the app launched with `--edit` (auto-enter Edit mode; for diagnostics).
#[tauri::command]
fn startup_autoedit() -> bool {
    std::env::args().any(|a| a == "--edit")
}

/// Frontend diagnostic log -> stderr.
#[tauri::command]
fn dbg_log(msg: String) {
    eprintln!("[js] {msg}");
}

#[tauri::command]
fn edit_objects(
    app: tauri::AppHandle,
    state: tauri::State<EditState>,
    page: u16,
) -> Result<Vec<pdf_edit::ObjInfo>, String> {
    let bytes = state.bytes.lock().unwrap().clone();
    let r = pdf_edit::list_objects(pdfium(&app)?, &bytes, page);
    match &r {
        Ok(v) => eprintln!("[pdf-studio] edit_objects page {page}: {} objects", v.len()),
        Err(e) => eprintln!("[pdf-studio] edit_objects error: {e}"),
    }
    r
}

#[derive(Serialize)]
struct RenderResult {
    png: String,
    width: f32,
    height: f32,
}

#[tauri::command]
fn edit_render_page(
    app: tauri::AppHandle,
    state: tauri::State<EditState>,
    page: u16,
    scale: f32,
) -> Result<RenderResult, String> {
    let bytes = state.bytes.lock().unwrap().clone();
    match pdf_edit::render_page_png(pdfium(&app)?, &bytes, page, scale) {
        Ok((png, width, height)) => {
            eprintln!("[pdf-studio] edit_render_page page {page}: {} bytes ({width}x{height}pt)", png.len());
            Ok(RenderResult { png: STANDARD.encode(png), width, height })
        }
        Err(e) => {
            eprintln!("[pdf-studio] edit_render_page error: {e}");
            Err(e)
        }
    }
}

fn apply(
    state: &tauri::State<EditState>,
    new_bytes: Result<Vec<u8>, String>,
) -> Result<(), String> {
    let b = new_bytes?;
    // Snapshot the pre-edit state for undo (cap history to keep memory bounded).
    let prev = state.bytes.lock().unwrap().clone();
    {
        let mut undo = state.undo.lock().unwrap();
        undo.push(prev);
        if undo.len() > 40 {
            undo.remove(0);
        }
    }
    state.redo.lock().unwrap().clear();
    *state.bytes.lock().unwrap() = b;
    Ok(())
}

#[tauri::command]
fn edit_undo(state: tauri::State<EditState>) -> Result<bool, String> {
    let prev = state.undo.lock().unwrap().pop();
    match prev {
        Some(p) => {
            let cur = state.bytes.lock().unwrap().clone();
            state.redo.lock().unwrap().push(cur);
            *state.bytes.lock().unwrap() = p;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
fn edit_redo(state: tauri::State<EditState>) -> Result<bool, String> {
    let next = state.redo.lock().unwrap().pop();
    match next {
        Some(n) => {
            let cur = state.bytes.lock().unwrap().clone();
            state.undo.lock().unwrap().push(cur);
            *state.bytes.lock().unwrap() = n;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// First `.pdf` path passed on the command line (for "Open with" / CLI use).
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args().skip(1).find(|a| {
        a.to_lowercase().ends_with(".pdf") && Path::new(a).exists()
    })
}

#[tauri::command]
fn edit_set_text(
    app: tauri::AppHandle,
    state: tauri::State<EditState>,
    page: u16,
    id: u32,
    text: String,
) -> Result<(), String> {
    let bytes = state.bytes.lock().unwrap().clone();
    apply(&state, pdf_edit::set_text(pdfium(&app)?, &bytes, page, id, &text))
}

#[tauri::command]
fn edit_move(
    app: tauri::AppHandle,
    state: tauri::State<EditState>,
    page: u16,
    id: u32,
    dx: f32,
    dy: f32,
) -> Result<(), String> {
    let bytes = state.bytes.lock().unwrap().clone();
    apply(&state, pdf_edit::move_object(pdfium(&app)?, &bytes, page, id, dx, dy))
}

#[tauri::command]
fn edit_set_bbox(
    app: tauri::AppHandle,
    state: tauri::State<EditState>,
    page: u16,
    id: u32,
    bbox: [f32; 4],
) -> Result<(), String> {
    let bytes = state.bytes.lock().unwrap().clone();
    apply(&state, pdf_edit::set_bbox(pdfium(&app)?, &bytes, page, id, bbox))
}

#[tauri::command]
fn edit_delete(
    app: tauri::AppHandle,
    state: tauri::State<EditState>,
    page: u16,
    id: u32,
) -> Result<(), String> {
    let bytes = state.bytes.lock().unwrap().clone();
    apply(&state, pdf_edit::delete_object(pdfium(&app)?, &bytes, page, id))
}

#[tauri::command]
fn edit_insert_text(
    app: tauri::AppHandle,
    state: tauri::State<EditState>,
    page: u16,
    x: f32,
    y: f32,
    text: String,
    size: f32,
) -> Result<(), String> {
    let bytes = state.bytes.lock().unwrap().clone();
    apply(&state, pdf_edit::insert_text(pdfium(&app)?, &bytes, page, x, y, &text, size))
}

#[tauri::command]
fn edit_replace_image(
    app: tauri::AppHandle,
    state: tauri::State<EditState>,
    page: u16,
    id: u32,
    image_b64: String,
) -> Result<(), String> {
    let img = STANDARD.decode(image_b64.as_bytes()).map_err(|e| e.to_string())?;
    let bytes = state.bytes.lock().unwrap().clone();
    apply(&state, pdf_edit::replace_image(pdfium(&app)?, &bytes, page, id, &img))
}

#[tauri::command]
fn edit_save(state: tauri::State<EditState>, path: String) -> Result<(), String> {
    let bytes = state.bytes.lock().unwrap().clone();
    fs::write(&path, bytes).map_err(|e| format!("write {path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(EditState::default())
        .invoke_handler(tauri::generate_handler![
            read_file_b64,
            write_file_b64,
            load_sidecar,
            save_sidecar,
            pdf_info,
            edit_open,
            edit_objects,
            edit_render_page,
            edit_set_text,
            edit_move,
            edit_set_bbox,
            edit_delete,
            edit_insert_text,
            edit_replace_image,
            edit_save,
            edit_undo,
            edit_redo,
            startup_file,
            startup_autoedit,
            dbg_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PDF Studio");
}
