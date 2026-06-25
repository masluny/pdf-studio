import "./styles.css";
import { buildUI, openPath, enterEditMode } from "./ui";
import { isTauri, startupFile, startupAutoedit } from "./backend";

buildUI();

if (!isTauri()) {
  // Plain browser dev server: auto-open a bundled sample for development.
  openPath("/sample.pdf").catch(() => {});
} else {
  // Desktop: open a PDF passed on the command line ("Open with" / CLI),
  // and auto-enter Edit mode if launched with --edit (diagnostics).
  startupFile().then(async (p) => {
    if (!p) return;
    await openPath(p);
    if (await startupAutoedit()) await enterEditMode();
  }).catch(() => {});
}
