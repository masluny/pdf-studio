import "./styles.css";
import { buildUI, openPath } from "./ui";
import { isTauri, startupFile } from "./backend";

buildUI();

if (!isTauri()) {
  // Plain browser dev server: auto-open a bundled sample for development.
  openPath("/sample.pdf").catch(() => {});
} else {
  // Desktop: open a PDF passed on the command line ("Open with" / CLI).
  startupFile().then((p) => { if (p) openPath(p); }).catch(() => {});
}
