//! PDFium-backed content editing (text/object/image) via `pdfium-render`.
//!
//! Functions are stateless: each takes the current PDF bytes, performs one
//! operation, and returns the new bytes (the command layer keeps the current
//! bytes in app state). PDFium uses a bottom-left origin; all coordinates
//! crossing this boundary are converted to/from **top-left points**.

use pdfium_render::prelude::*;
use serde::Serialize;
use std::path::Path;

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Bind to the PDFium dynamic library located in `lib_dir`.
pub fn bind(lib_dir: &Path) -> Result<Pdfium, String> {
    let path = Pdfium::pdfium_platform_library_name_at_path(lib_dir);
    let bindings = Pdfium::bind_to_library(&path)
        .map_err(|e| format!("bind pdfium ({}): {e}", path.display()))?;
    Ok(Pdfium::new(bindings))
}

pub fn page_count(pdfium: &Pdfium, bytes: &[u8]) -> Result<u16, String> {
    let doc = pdfium.load_pdf_from_byte_slice(bytes, None).map_err(e2s)?;
    Ok(doc.pages().len() as u16)
}

#[derive(Serialize)]
pub struct ObjInfo {
    pub id: u32,
    pub kind: String,
    /// [x0, y0, x1, y1] in top-left points.
    pub bbox: [f32; 4],
    pub text: Option<String>,
    pub font_size: Option<f32>,
    pub color: Option<String>,
}

pub fn list_objects(pdfium: &Pdfium, bytes: &[u8], page_index: u16) -> Result<Vec<ObjInfo>, String> {
    let doc = pdfium.load_pdf_from_byte_slice(bytes, None).map_err(e2s)?;
    let page = doc.pages().get(page_index as i32).map_err(e2s)?;
    let h = page.height().value;
    let mut out = Vec::new();
    for (i, obj) in page.objects().iter().enumerate() {
        let b = match obj.bounds() {
            Ok(b) => b,
            Err(_) => continue,
        };
        let bbox = [b.left().value, h - b.top().value, b.right().value, h - b.bottom().value];
        let (kind, text, font_size, color) = match obj.object_type() {
            PdfPageObjectType::Text => {
                if let Some(t) = obj.as_text_object() {
                    let col: Option<String> = None; // colour is per-char; read later
                    ("text".to_string(), Some(t.text()), Some(t.scaled_font_size().value), col)
                } else {
                    ("text".to_string(), None, None, None)
                }
            }
            PdfPageObjectType::Image => ("image".to_string(), None, None, None),
            PdfPageObjectType::Path => ("path".to_string(), None, None, None),
            _ => ("other".to_string(), None, None, None),
        };
        out.push(ObjInfo { id: i as u32, kind, bbox, text, font_size, color });
    }
    Ok(out)
}

/// Render a page to PNG. Returns (png_bytes, page_width_pts, page_height_pts).
pub fn render_page_png(
    pdfium: &Pdfium,
    bytes: &[u8],
    page_index: u16,
    scale: f32,
) -> Result<(Vec<u8>, f32, f32), String> {
    let doc = pdfium.load_pdf_from_byte_slice(bytes, None).map_err(e2s)?;
    let page = doc.pages().get(page_index as i32).map_err(e2s)?;
    let w_pts = page.width().value;
    let h_pts = page.height().value;
    let width = (w_pts * scale).round() as Pixels;
    let height = (h_pts * scale).round() as Pixels;
    let config = PdfRenderConfig::new()
        .set_target_width(width)
        .set_maximum_height(height);
    let bitmap = page.render_with_config(&config).map_err(e2s)?;
    let image = bitmap.as_image().map_err(e2s)?;
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(e2s)?;
    Ok((png, w_pts, h_pts))
}

pub fn set_text(
    pdfium: &Pdfium,
    bytes: &[u8],
    page_index: u16,
    id: u32,
    text: &str,
) -> Result<Vec<u8>, String> {
    let doc = pdfium.load_pdf_from_byte_slice(bytes, None).map_err(e2s)?;
    let mut page = doc.pages().get(page_index as i32).map_err(e2s)?;
    {
        let mut obj = page.objects().get(id as usize).map_err(e2s)?;
        match obj.as_text_object_mut() {
            Some(t) => t.set_text(text).map_err(e2s)?,
            None => return Err("object is not text".to_string()),
        }
    }
    page.regenerate_content().map_err(e2s)?;
    doc.save_to_bytes().map_err(e2s)
}

/// Translate an object by (dx, dy) given in top-left points (dy positive = down).
pub fn move_object(
    pdfium: &Pdfium,
    bytes: &[u8],
    page_index: u16,
    id: u32,
    dx: f32,
    dy_top: f32,
) -> Result<Vec<u8>, String> {
    let doc = pdfium.load_pdf_from_byte_slice(bytes, None).map_err(e2s)?;
    let mut page = doc.pages().get(page_index as i32).map_err(e2s)?;
    {
        let mut obj = page.objects().get(id as usize).map_err(e2s)?;
        obj.translate(PdfPoints::new(dx), PdfPoints::new(-dy_top)).map_err(e2s)?;
    }
    page.regenerate_content().map_err(e2s)?;
    doc.save_to_bytes().map_err(e2s)
}

pub fn delete_object(
    pdfium: &Pdfium,
    bytes: &[u8],
    page_index: u16,
    id: u32,
) -> Result<Vec<u8>, String> {
    let doc = pdfium.load_pdf_from_byte_slice(bytes, None).map_err(e2s)?;
    let mut page = doc.pages().get(page_index as i32).map_err(e2s)?;
    let removed = page.objects_mut().remove_object_at_index(id as usize).map_err(e2s)?;
    // Leak the detached handle: letting its destructor run here double-frees
    // against the page's index cache during regeneration (SIGSEGV). The handle
    // is freed when the document/library drops at the end of the command.
    std::mem::forget(removed);
    page.regenerate_content().map_err(e2s)?;
    doc.save_to_bytes().map_err(e2s)
}

/// Move + resize an object to fit `bbox` ([x0,y0,x1,y1] in top-left points).
pub fn set_bbox(
    pdfium: &Pdfium,
    bytes: &[u8],
    page_index: u16,
    id: u32,
    bbox: [f32; 4],
) -> Result<Vec<u8>, String> {
    let doc = pdfium.load_pdf_from_byte_slice(bytes, None).map_err(e2s)?;
    let mut page = doc.pages().get(page_index as i32).map_err(e2s)?;
    let h = page.height().value;
    let cur = {
        let obj = page.objects().get(id as usize).map_err(e2s)?;
        obj.bounds().map_err(e2s)?
    };
    let n_left = bbox[0];
    let n_right = bbox[2];
    let n_top_pdf = h - bbox[1];
    let n_bottom_pdf = h - bbox[3];
    let cw = (cur.right().value - cur.left().value).abs().max(0.1);
    let ch = (cur.top().value - cur.bottom().value).abs().max(0.1);
    let sx = (n_right - n_left) / cw;
    let sy = (n_top_pdf - n_bottom_pdf) / ch;
    {
        let mut obj = page.objects().get(id as usize).map_err(e2s)?;
        obj.translate(PdfPoints::new(-cur.left().value), PdfPoints::new(-cur.bottom().value))
            .map_err(e2s)?;
        obj.scale(sx, sy).map_err(e2s)?;
        obj.translate(PdfPoints::new(n_left), PdfPoints::new(n_bottom_pdf))
            .map_err(e2s)?;
    }
    page.regenerate_content().map_err(e2s)?;
    doc.save_to_bytes().map_err(e2s)
}

/// Add a new text object at (x, y_top) in top-left points.
pub fn insert_text(
    pdfium: &Pdfium,
    bytes: &[u8],
    page_index: u16,
    x: f32,
    y_top: f32,
    text: &str,
    size: f32,
) -> Result<Vec<u8>, String> {
    let mut doc = pdfium.load_pdf_from_byte_slice(bytes, None).map_err(e2s)?;
    let font = doc.fonts_mut().helvetica();
    let mut page = doc.pages().get(page_index as i32).map_err(e2s)?;
    let y_pdf = page.height().value - y_top - size;
    page.objects_mut()
        .create_text_object(
            PdfPoints::new(x),
            PdfPoints::new(y_pdf),
            text,
            font,
            PdfPoints::new(size),
        )
        .map_err(e2s)?;
    page.regenerate_content().map_err(e2s)?;
    doc.save_to_bytes().map_err(e2s)
}

/// Replace the bitmap of an existing image object in place.
pub fn replace_image(
    pdfium: &Pdfium,
    bytes: &[u8],
    page_index: u16,
    id: u32,
    image_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let dynimg = image::load_from_memory(image_bytes).map_err(e2s)?;
    let doc = pdfium.load_pdf_from_byte_slice(bytes, None).map_err(e2s)?;
    let mut page = doc.pages().get(page_index as i32).map_err(e2s)?;
    {
        let mut obj = page.objects().get(id as usize).map_err(e2s)?;
        match obj.as_image_object_mut() {
            Some(im) => im.set_image(&dynimg).map_err(e2s)?,
            None => return Err("object is not an image".to_string()),
        }
    }
    page.regenerate_content().map_err(e2s)?;
    doc.save_to_bytes().map_err(e2s)
}

pub fn platform_lib_path(dir: &Path) -> std::path::PathBuf {
    Pdfium::pdfium_platform_library_name_at_path(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<u8> {
        std::fs::read("../public/sample.pdf").expect("sample.pdf")
    }

    /// End-to-end proof: open a PDF, edit a heading, SAVE to disk, reopen the
    /// saved file, and render it to a PNG so the edit is visible.
    #[test]
    fn edit_proof() {
        let pdfium = bind(Path::new(".")).expect("bind pdfium");
        let src = if std::path::Path::new("/tmp/edit_test.pdf").exists() {
            "/tmp/edit_test.pdf"
        } else {
            "../public/sample.pdf"
        };
        let bytes = std::fs::read(src).expect("read source");

        let objs = list_objects(&pdfium, &bytes, 0).unwrap();
        let intro = objs
            .iter()
            .find(|o| o.text.as_deref().map(|t| t.contains("Introduction")).unwrap_or(false))
            .expect("Introduction heading");

        // edit + save to disk (mirrors what edit_set_text + edit_save do)
        let edited = set_text(&pdfium, &bytes, 0, intro.id, "EDITED BY PDF STUDIO").unwrap();
        std::fs::write("/tmp/edit_test_out.pdf", &edited).unwrap();

        // reopen the SAVED file from disk, verify + render
        let disk = std::fs::read("/tmp/edit_test_out.pdf").unwrap();
        let changed = list_objects(&pdfium, &disk, 0)
            .unwrap()
            .iter()
            .any(|o| o.text.as_deref().map(|t| t.contains("EDITED BY PDF STUDIO")).unwrap_or(false));
        assert!(changed, "saved file does not contain the edit");

        let (png, _w, _h) = render_page_png(&pdfium, &disk, 0, 1.6).unwrap();
        std::fs::write("/tmp/edit_proof.png", &png).unwrap();
        eprintln!("EDIT PROOF: wrote /tmp/edit_test_out.pdf and /tmp/edit_proof.png");
    }

    #[test]
    fn pdfium_edit_roundtrip() {
        let pdfium = bind(Path::new(".")).expect("bind pdfium");
        let bytes = sample();

        assert_eq!(page_count(&pdfium, &bytes).unwrap(), 3);

        let objs = list_objects(&pdfium, &bytes, 0).unwrap();
        let texts: Vec<&ObjInfo> = objs.iter().filter(|o| o.kind == "text").collect();
        assert!(!texts.is_empty(), "expected text objects on page 0");
        let intro = texts
            .iter()
            .find(|o| o.text.as_deref().map(|t| t.contains("Introduction")).unwrap_or(false))
            .expect("an 'Introduction' text object");

        // Edit it, save, reload, confirm the change persisted.
        let edited = set_text(&pdfium, &bytes, 0, intro.id, "Edited Heading").unwrap();
        let objs2 = list_objects(&pdfium, &edited, 0).unwrap();
        let changed = objs2.iter().any(|o| {
            o.text.as_deref().map(|t| t.contains("Edited Heading")).unwrap_or(false)
        });
        assert!(changed, "set_text did not persist");

        // Move the object; should still save.
        let moved = move_object(&pdfium, &edited, 0, 0, 10.0, 5.0).unwrap();
        assert!(!moved.is_empty());

        // Delete the first object — count should drop by one.
        let n0 = list_objects(&pdfium, &bytes, 0).unwrap().len();
        let deleted = delete_object(&pdfium, &bytes, 0, 0).unwrap();
        let n1 = list_objects(&pdfium, &deleted, 0).unwrap().len();
        assert_eq!(n1, n0 - 1, "delete did not remove an object");

        // Insert a new text object.
        let added = insert_text(&pdfium, &bytes, 0, 100.0, 500.0, "Inserted Line", 16.0).unwrap();
        let has_new = list_objects(&pdfium, &added, 0)
            .unwrap()
            .iter()
            .any(|o| o.text.as_deref().map(|t| t.contains("Inserted Line")).unwrap_or(false));
        assert!(has_new, "insert_text did not add text");
        eprintln!("INSERT OK");

        // Resize via bbox.
        let resized = set_bbox(
            &pdfium, &edited, 0, intro.id,
            [intro.bbox[0], intro.bbox[1], intro.bbox[2] + 40.0, intro.bbox[3]],
        )
        .unwrap();
        assert!(!resized.is_empty());
        eprintln!("RESIZE OK");

        // Render produces a non-trivial PNG.
        let (png, _w, _h) = render_page_png(&pdfium, &bytes, 0, 1.5).unwrap();
        assert!(png.len() > 1000, "render produced too little data");
    }
}
