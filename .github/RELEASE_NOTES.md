# PDF Studio v0.2.0

A professional, native **PDF editor & viewer** for Windows, macOS and Linux —
built with [Tauri 2](https://tauri.app), Rust, TypeScript and Tailwind v4.

> Lightweight, fast and private: all editing happens locally on your machine.
> No uploads, no accounts, no telemetry.

---

## ✨ Features

### Viewing
- GPU-crisp PDF.js rendering with page thumbnails
- Zoom / fit-width / fit-page, keyboard page navigation
- Light & dark themes with a custom SVG icon set

### Annotating (10 tools)
Select · Highlight · Text box · Rectangle · Ellipse · Line · Pen · Arrow ·
Sticky note · Redact / whiteout. Move, delete and recolour any mark; full
undo/redo.

### Editing the document
Rotate · Delete · Duplicate · Move · **drag-free page reorder** · Insert blank ·
**Merge** another PDF · **Extract** a page.

### Productivity
- **Find** (`⌘F` / `Ctrl+F`) with match highlighting and next/prev
- **Outline** panel from the PDF bookmarks
- **Comments** hub — filter, jump, reply, resolve, delete
- Document **Notes** scratchpad
- **Sidecar persistence** — annotations, comments and notes auto-save to
  `<name>.annot.json` next to the PDF
- **Export** — bakes all marks into a real, flattened PDF (via `pdf-lib`)

---

## 📥 Downloads

Pick the installer for your platform from the **Assets** below.

| Platform | File |
|----------|------|
| **Windows** (x64) | `PDF.Studio_0.2.0_x64-setup.exe` or `..._x64_en-US.msi` |
| **macOS** (Apple Silicon) | `PDF.Studio_0.2.0_aarch64.dmg` |
| **macOS** (Intel) | `PDF.Studio_0.2.0_x64.dmg` |
| **Linux** (Debian/Ubuntu) | `PDF.Studio_0.2.0_amd64.deb` |
| **Linux** (Fedora/RHEL) | `PDF.Studio-0.2.0-1.x86_64.rpm` |
| **Linux** (portable) | `PDF.Studio_0.2.0_amd64.AppImage` |

### Install notes
- **macOS**: on first launch you may need to right-click → *Open* (the app is
  not yet code-signed). Apple Silicon builds are notarization-friendly.
- **Windows**: if SmartScreen warns, choose *More info* → *Run anyway*.
- **Linux**: make the AppImage executable (`chmod +x *.AppImage`) and run, or
  install the `.deb` / `.rpm` with your package manager.

---

## 🛠️ Tech stack

| Layer | Role |
|-------|------|
| Rust backend | Native file & sidecar I/O, PDF metadata (`lopdf`) |
| PDF.js | Rendering, text layer, outline, search |
| pdf-lib | Structural editing & baked-annotation export |
| Tailwind v4 + TS | The full editor UI |

## ⚠️ Known limitations
- **Redaction** covers content opaquely; true content *removal* is a follow-up.
- **Highlight** is a rectangular region (word-snap is a future upgrade).
- Export flattens marks as page content rather than re-editable PDF annotations.

---

*Built by Kacper Kotowski. Source: https://github.com/masluny/pdf-studio*
