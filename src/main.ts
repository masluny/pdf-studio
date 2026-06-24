import "./styles.css";
import { buildUI, openPath } from "./ui";
import { isTauri } from "./backend";

buildUI();

// In a plain browser dev server (no Tauri), auto-open a bundled sample so the
// app is immediately usable for development and screenshots.
if (!isTauri()) {
  openPath("/sample.pdf").catch(() => {});
}
