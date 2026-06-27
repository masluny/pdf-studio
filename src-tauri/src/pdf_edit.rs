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

/// Map a font name to one of PDFium's 14 standard fonts.
fn font_token(doc: &mut PdfDocument, name: &str) -> PdfFontToken {
    let f = doc.fonts_mut();
    match name {
        "helvetica_bold" => f.helvetica_bold(),
        "helvetica_oblique" | "helvetica_italic" => f.helvetica_oblique(),
        "helvetica_bold_oblique" | "helvetica_bold_italic" => f.helvetica_bold_oblique(),
        "times_roman" | "times" => f.times_roman(),
        "times_bold" => f.times_bold(),
        "times_italic" => f.times_italic(),
        "times_bold_italic" => f.times_bold_italic(),
        "courier" => f.courier(),
        "courier_bold" => f.courier_bold(),
        "courier_oblique" | "courier_italic" => f.courier_oblique(),
        "courier_bold_oblique" | "courier_bold_italic" => f.courier_bold_oblique(),
        _ => f.helvetica(),
    }
}

/// Change a text object's font size, colour and/or font face.
///
/// - `size`: new absolute font size in points (scales the object in place,
///   preserving the existing font face).
/// - `color`: new fill (text) colour as [r, g, b].
/// - `font`: a standard-font name (e.g. "helvetica_bold"). Because PDFium 0.9.2
///   has no font setter for existing text, changing the face **recreates** the
///   object with the chosen standard font at the same baseline — so the
///   recreated object becomes the page's last object (caller should reselect).
pub fn set_style(
    pdfium: &Pdfium,
    bytes: &[u8],
    page_index: u16,
    id: u32,
    size: Option<f32>,
    color: Option<[u8; 3]>,
    font: Option<String>,
) -> Result<Vec<u8>, String> {
    let mut doc = pdfium.load_pdf_from_byte_slice(bytes, None).map_err(e2s)?;

    // Read current text-object properties first (immutable borrow released here).
    let (cur_text, cur_size, left, bottom) = {
        let page = doc.pages().get(page_index as i32).map_err(e2s)?;
        let obj = page.objects().get(id as usize).map_err(e2s)?;
        let t = obj
            .as_text_object()
            .ok_or_else(|| "object is not text".to_string())?;
        let b = obj.bounds().map_err(e2s)?;
        (t.text(), t.scaled_font_size().value, b.left().value, b.bottom().value)
    };

    if let Some(fname) = font.as_deref() {
        // Recreate with a standard font at the same baseline.
        let new_size = size.unwrap_or(cur_size).max(1.0);
        let token = font_token(&mut doc, fname);
        let mut page = doc.pages().get(page_index as i32).map_err(e2s)?;
        let removed = page.objects_mut().remove_object_at_index(id as usize).map_err(e2s)?;
        std::mem::forget(removed); // see delete_object: avoid double-free SIGSEGV
        let mut newobj = page
            .objects_mut()
            .create_text_object(
                PdfPoints::new(left),
                PdfPoints::new(bottom),
                &cur_text,
                token,
                PdfPoints::new(new_size),
            )
            .map_err(e2s)?;
        if let Some(c) = color {
            newobj.set_fill_color(PdfColor::new(c[0], c[1], c[2], 255)).map_err(e2s)?;
        }
        page.regenerate_content().map_err(e2s)?;
        return doc.save_to_bytes().map_err(e2s);
    }

    // No font change: scale for size, set fill colour — both in place.
    let mut page = doc.pages().get(page_index as i32).map_err(e2s)?;
    {
        let mut obj = page.objects().get(id as usize).map_err(e2s)?;
        if let Some(ns) = size {
            let f = (ns / cur_size.max(0.1)).max(0.01);
            if (f - 1.0).abs() > 0.001 {
                obj.translate(PdfPoints::new(-left), PdfPoints::new(-bottom)).map_err(e2s)?;
                obj.scale(f, f).map_err(e2s)?;
                obj.translate(PdfPoints::new(left), PdfPoints::new(bottom)).map_err(e2s)?;
            }
        }
        if let Some(c) = color {
            obj.set_fill_color(PdfColor::new(c[0], c[1], c[2], 255)).map_err(e2s)?;
        }
    }
    page.regenerate_content().map_err(e2s)?;
    doc.save_to_bytes().map_err(e2s)
}

/// Add or remove an underline / strikethrough line for a text object.
///
/// PDF text has no native decoration, so these are drawn as thin horizontal line
/// path objects. Toggling **off** is best-effort: it removes the first thin,
/// horizontal line found in the decoration zone of the text. The line does not
/// track the text if the text is later moved.
pub fn set_decoration(
    pdfium: &Pdfium,
    bytes: &[u8],
    page_index: u16,
    id: u32,
    kind: &str,
    on: bool,
    color: [u8; 3],
) -> Result<Vec<u8>, String> {
    let doc = pdfium.load_pdf_from_byte_slice(bytes, None).map_err(e2s)?;
    let mut page = doc.pages().get(page_index as i32).map_err(e2s)?;

    // Text bounds in PDF (bottom-left origin) coords.
    let (left, right, top, bottom) = {
        let obj = page.objects().get(id as usize).map_err(e2s)?;
        if obj.object_type() != PdfPageObjectType::Text {
            return Err("object is not text".to_string());
        }
        let b = obj.bounds().map_err(e2s)?;
        (b.left().value, b.right().value, b.top().value, b.bottom().value)
    };
    let size = (top - bottom).abs().max(1.0);
    let target_y = match kind {
        "strike" => (top + bottom) / 2.0,
        _ /* underline */ => bottom - 1.0,
    };

    if on {
        let width = (size / 15.0).max(0.6);
        page.objects_mut()
            .create_path_object_line(
                PdfPoints::new(left),
                PdfPoints::new(target_y),
                PdfPoints::new(right),
                PdfPoints::new(target_y),
                PdfColor::new(color[0], color[1], color[2], 255),
                PdfPoints::new(width),
            )
            .map_err(e2s)?;
    } else {
        // Find a thin, horizontal path line in the decoration zone and drop it.
        let text_w = (right - left).abs().max(1.0);
        let mut hit: Option<usize> = None;
        for (i, obj) in page.objects().iter().enumerate() {
            if obj.object_type() != PdfPageObjectType::Path {
                continue;
            }
            let b = match obj.bounds() {
                Ok(b) => b,
                Err(_) => continue,
            };
            let lh = (b.top().value - b.bottom().value).abs();
            let lw = (b.right().value - b.left().value).abs();
            let ly = (b.top().value + b.bottom().value) / 2.0;
            let overlaps_x = b.left().value < right && b.right().value > left;
            let near_y = (ly - target_y).abs() < size * 0.35 + 1.5;
            if lh < 2.5 && lw >= text_w * 0.4 && overlaps_x && near_y {
                hit = Some(i);
                break;
            }
        }
        if let Some(i) = hit {
            let removed = page.objects_mut().remove_object_at_index(i).map_err(e2s)?;
            std::mem::forget(removed); // see delete_object: avoid double-free SIGSEGV
        }
    }

    page.regenerate_content().map_err(e2s)?;
    doc.save_to_bytes().map_err(e2s)
}

/// Translate an object by (dx, dy) given in top-left points (dy positive = down).
///
/// When the moved object is text, any underline / strikethrough lines drawn in
/// its decoration zone are translated by the same delta so they follow the text.
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

    // Collect the target plus any decoration lines that ride with it.
    let mut move_ids: Vec<usize> = vec![id as usize];
    {
        let target = page.objects().get(id as usize).map_err(e2s)?;
        if target.object_type() == PdfPageObjectType::Text {
            let b = target.bounds().map_err(e2s)?;
            let (left, right, top, bottom) =
                (b.left().value, b.right().value, b.top().value, b.bottom().value);
            let size = (top - bottom).abs().max(1.0);
            let text_w = (right - left).abs().max(1.0);
            for (i, o) in page.objects().iter().enumerate() {
                if i == id as usize || o.object_type() != PdfPageObjectType::Path {
                    continue;
                }
                let lb = match o.bounds() { Ok(b) => b, Err(_) => continue };
                let lh = (lb.top().value - lb.bottom().value).abs();
                let lw = (lb.right().value - lb.left().value).abs();
                let ly = (lb.top().value + lb.bottom().value) / 2.0;
                let overlaps_x = lb.left().value < right && lb.right().value > left;
                let in_zone = ly >= bottom - size * 0.6 && ly <= top + 1.0;
                if lh < 2.5 && lw >= text_w * 0.4 && overlaps_x && in_zone {
                    move_ids.push(i);
                }
            }
        }
    }

    for idx in move_ids {
        let mut obj = page.objects().get(idx).map_err(e2s)?;
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
    fn style_size_color_font() {
        let pdfium = bind(Path::new(".")).expect("bind pdfium");
        let bytes = sample();

        let objs = list_objects(&pdfium, &bytes, 0).unwrap();
        let intro = objs
            .iter()
            .find(|o| o.text.as_deref().map(|t| t.contains("Introduction")).unwrap_or(false))
            .expect("Introduction heading");
        let id = intro.id;
        let orig_size = intro.font_size.unwrap();
        let orig_text = intro.text.clone().unwrap();

        // Grow the font size ~2x via scaling; the object stays in place + same text.
        let target = orig_size * 2.0;
        let bigger = set_style(&pdfium, &bytes, 0, id, Some(target), None, None).unwrap();
        let after = &list_objects(&pdfium, &bigger, 0).unwrap()[id as usize];
        let new_size = after.font_size.unwrap();
        assert!((new_size - target).abs() < 1.0, "size {new_size} not ~{target}");
        assert_eq!(after.text.as_deref(), Some(orig_text.as_str()), "text changed on resize");

        // Colour-only change must save and keep the object as text.
        let recolored = set_style(&pdfium, &bytes, 0, id, None, Some([220, 30, 120]), None).unwrap();
        assert!(!recolored.is_empty());

        // Font change recreates the object as the page's last object with same text.
        let bolded = set_style(&pdfium, &bytes, 0, id, None, None, Some("helvetica_bold".into())).unwrap();
        let objs2 = list_objects(&pdfium, &bolded, 0).unwrap();
        assert_eq!(objs2.len(), objs.len(), "object count should be unchanged after recreate");
        let last = objs2.last().unwrap();
        assert_eq!(last.text.as_deref(), Some(orig_text.as_str()), "recreated text mismatch");
        eprintln!("STYLE OK: size {orig_size}->{new_size}, recolor+font recreate fine");
    }

    #[test]
    fn decoration_underline_strike() {
        let pdfium = bind(Path::new(".")).expect("bind pdfium");
        let bytes = sample();
        let objs = list_objects(&pdfium, &bytes, 0).unwrap();
        let intro = objs
            .iter()
            .find(|o| o.text.as_deref().map(|t| t.contains("Introduction")).unwrap_or(false))
            .expect("Introduction heading");
        let id = intro.id;
        let n0 = objs.len();

        // Underline ON adds one path object.
        let underlined = set_decoration(&pdfium, &bytes, 0, id, "underline", true, [0, 0, 0]).unwrap();
        let n1 = list_objects(&pdfium, &underlined, 0).unwrap().len();
        assert_eq!(n1, n0 + 1, "underline ON should add one object");

        // Underline OFF removes it again.
        let cleared = set_decoration(&pdfium, &underlined, 0, id, "underline", false, [0, 0, 0]).unwrap();
        let n2 = list_objects(&pdfium, &cleared, 0).unwrap().len();
        assert_eq!(n2, n0, "underline OFF should remove the line");

        // Strikethrough ON also adds one object.
        let struck = set_decoration(&pdfium, &bytes, 0, id, "strike", true, [200, 20, 20]).unwrap();
        let n3 = list_objects(&pdfium, &struck, 0).unwrap().len();
        assert_eq!(n3, n0 + 1, "strike ON should add one object");

        // Moving the underlined text must drag the underline along with it.
        let thin_line_y = |bytes: &[u8]| -> f32 {
            list_objects(&pdfium, bytes, 0)
                .unwrap()
                .iter()
                .filter(|o| o.kind == "path" && (o.bbox[3] - o.bbox[1]).abs() < 3.0)
                .map(|o| o.bbox[1])
                .fold(f32::MAX, f32::min)
        };
        let y_before = thin_line_y(&underlined);
        let moved = move_object(&pdfium, &underlined, 0, id, 0.0, 30.0).unwrap();
        let y_after = thin_line_y(&moved);
        assert!(
            (y_after - y_before - 30.0).abs() < 2.0,
            "underline did not follow the moved text: {y_before} -> {y_after}"
        );
        eprintln!("DECORATION OK: underline +1/-1, strike +1, underline follows move");
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
