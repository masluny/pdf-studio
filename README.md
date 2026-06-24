# PDF Studio — Tauri + Rust + Tailwind

A professional desktop **PDF editor & viewer**, rebuilt as a native
[Tauri 2](https://tauri.app) app:

- **Rust** backend (native file/sidecar I/O, PDF metadata via `lopdf`).
- **TypeScript + Tailwind v4** frontend (the whole editor UI).
- **PDF.js** for rendering, text, outline, and search.
- **pdf-lib** for structural editing and baked-annotation export — all in the
  webview, so editing is reliable and portable.

This is a from-scratch port of the PySide6 `pdf_annotator` app.

## Features

- **View**: GPU-crisp rendering, page thumbnails, zoom / fit, page navigation.
- **Annotate** (10 tools): select, highlight, text box, rectangle, ellipse,
  line, pen, arrow, sticky note, redact/whiteout. Move, delete, recolour.
- **Edit the document**: rotate, delete, duplicate, move, **drag-free reorder**
  via the page-ops bar, insert blank, **merge** another PDF, **extract** a page.
- **Find** (`⌘F`) with match highlighting + next/prev, **Outline** from the PDF
  bookmarks, **Comments** hub (filter / jump / reply / resolve / delete), and a
  document **Notes** scratchpad.
- **Light / dark** theme, custom SVG icon set, undo/redo.
- **Sidecar persistence**: annotations, comments and notes auto-save to
  `<name>.annot.json` next to the PDF (via the Rust backend).
- **Export**: bakes all marks into a real PDF (`pdf-lib`), including the
  structural edits.

## Develop

```bash
cd pdf-editor-tauri
npm install
npm run tauri dev      # native window (Rust + webview)
```

Or run just the web frontend (auto-loads a bundled sample PDF):

```bash
npm run dev            # http://localhost:1420
```

## Build a native app

```bash
npm run tauri build    # → src-tauri/target/release/bundle/macos/PDF Studio.app
```

## Architecture

| Layer | File(s) | Role |
|-------|---------|------|
| Rust | `src-tauri/src/lib.rs` | `read_file_b64`, `write_file_b64`, `load_sidecar`, `save_sidecar`, `pdf_info` (lopdf) |
| Render | `src/pdfview.ts` | PDF.js: page render, overlay, text, outline, search |
| Tools | `src/tools.ts` | pointer interaction for all 10 annotation tools |
| Edit | `src/editor.ts` | pdf-lib: rotate / reorder / delete / duplicate / insert / merge / extract / export |
| State | `src/state.ts` | annotations, comments, notes, undo/redo, sidecar, page remap |
| UI | `src/ui.ts` | header, tabbed sidebar, find bar, wiring |
| Style | `src/styles.css` | Tailwind v4 + design tokens (light/dark) |
| Icons | `src/icons.ts` | custom inline SVG line icons |
| Backend bridge | `src/backend.ts` | Tauri command wrappers (+ browser fallback) |

## Notes / limitations vs. the Python version

- **Redaction** covers the area opaquely (white/black box). True content
  *removal* needs a server-side pass; PyMuPDF's `apply_redactions` does this in
  the Python app — a follow-up could add it via a Rust `lopdf` command.
- **Highlight** is a rectangular region (not word-snapped); the text layer is
  available to upgrade this later.
- Export bakes marks as page content (WYSIWYG/flattened) rather than re-editable
  PDF annotation objects.
