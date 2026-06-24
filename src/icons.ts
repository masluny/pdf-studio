// Line icons (Lucide-style), stroke = currentColor so they inherit text colour.
const S = (inner: string, fill = false) =>
  `<svg viewBox="0 0 24 24" fill="${fill ? "currentColor" : "none"}" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ICONS: Record<string, string> = {
  select: S(`<path d="M5 3 L5 19 L9.4 14.6 L12.4 20.6 L14.6 19.6 L11.7 13.9 L17 13.6 Z" fill="currentColor" stroke-width="1.2"/>`),
  highlight: S(`<line x1="7" y1="8.5" x2="17" y2="8.5" stroke-width="1.6"/><line x1="6" y1="15" x2="18" y2="15" stroke-width="4"/>`),
  text: S(`<line x1="6" y1="6.5" x2="18" y2="6.5"/><line x1="12" y1="6.5" x2="12" y2="18"/>`),
  box: S(`<rect x="4.5" y="5.5" width="15" height="13" rx="2.5"/>`),
  ellipse: S(`<ellipse cx="12" cy="12" rx="7.5" ry="6"/>`),
  line: S(`<line x1="5" y1="19" x2="19" y2="5"/>`),
  pen: S(`<path d="M3 21 L4 17 L16.5 4.5 L19.5 7.5 L7 20 Z"/><line x1="14.4" y1="6.6" x2="17.4" y2="9.6"/>`),
  arrow: S(`<line x1="6" y1="18" x2="17.5" y2="6.5"/><polyline points="9.5,6.5 17.5,6.5 17.5,14.5"/>`),
  note: S(`<path d="M5 4 H15 L19 8 V20 H5 Z"/><polyline points="15,4 15,8 19,8"/><line x1="8" y1="12" x2="15" y2="12" stroke-width="1.5"/><line x1="8" y1="15" x2="13" y2="15" stroke-width="1.5"/>`),
  redact: S(`<rect x="4.5" y="8" width="15" height="8" rx="1.5" fill="currentColor" stroke="none"/>`),
  open: S(`<path d="M3.5 7.5 H8.6 L10.6 9.8 H20.5 V18 H3.5 Z"/>`),
  save: S(`<rect x="4.5" y="4.5" width="15" height="15" rx="2"/><rect x="8.5" y="4.7" width="7" height="4"/><rect x="7.8" y="12.2" width="8.4" height="7.3"/>`),
  export: S(`<polyline points="4.5,13.5 4.5,19.5 19.5,19.5 19.5,13.5"/><line x1="12" y1="4" x2="12" y2="15"/><polyline points="8,8 12,4 16,8"/>`),
  zoomIn: S(`<circle cx="10.5" cy="10.5" r="5.6"/><line x1="14.8" y1="14.8" x2="20" y2="20"/><line x1="10.5" y1="8" x2="10.5" y2="13"/><line x1="8" y1="10.5" x2="13" y2="10.5"/>`),
  zoomOut: S(`<circle cx="10.5" cy="10.5" r="5.6"/><line x1="14.8" y1="14.8" x2="20" y2="20"/><line x1="8" y1="10.5" x2="13" y2="10.5"/>`),
  fit: S(`<polyline points="4,8 4,4 8,4"/><polyline points="16,4 20,4 20,8"/><polyline points="20,16 20,20 16,20"/><polyline points="8,20 4,20 4,16"/>`),
  chevLeft: S(`<polyline points="14.5,6 9,12 14.5,18" stroke-width="2.2"/>`),
  chevRight: S(`<polyline points="9.5,6 15,12 9.5,18" stroke-width="2.2"/>`),
  chevUp: S(`<polyline points="6,15 12,9 18,15" stroke-width="2.2"/>`),
  chevDown: S(`<polyline points="6,9 12,15 18,9" stroke-width="2.2"/>`),
  rotateCw: S(`<path d="M5 5 a9 9 0 1 1 -1.5 9" stroke-width="2"/><polyline points="3 8 3.5 13.5 9 13" stroke-width="2"/>`),
  rotateCcw: S(`<path d="M19 5 a9 9 0 1 0 1.5 9" stroke-width="2"/><polyline points="21 8 20.5 13.5 15 13" stroke-width="2"/>`),
  duplicate: S(`<rect x="8" y="8" width="11" height="11" rx="2" stroke-width="1.8"/><polyline points="5,14 5,5 14,5" stroke-width="1.8"/>`),
  trash: S(`<line x1="5" y1="7" x2="19" y2="7" stroke-width="1.8"/><polyline points="7,7 7.7,19 16.3,19 17,7" stroke-width="1.8"/><polyline points="9.5,7 9.5,5 14.5,5 14.5,7" stroke-width="1.8"/>`),
  plus: S(`<line x1="12" y1="5.5" x2="12" y2="18.5"/><line x1="5.5" y1="12" x2="18.5" y2="12"/>`),
  merge: S(`<rect x="3.5" y="4" width="8" height="11" rx="1.5" stroke-width="1.7"/><rect x="12.5" y="9" width="8" height="11" rx="1.5" stroke-width="1.7"/>`),
  search: S(`<circle cx="10.5" cy="10.5" r="5.6"/><line x1="14.8" y1="14.8" x2="20" y2="20"/>`),
  sun: S(`<circle cx="12" cy="12" r="3.4"/><g stroke-width="1.8"><line x1="12" y1="2.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21.5" y2="12"/><line x1="5.2" y1="5.2" x2="7" y2="7"/><line x1="17" y1="17" x2="18.8" y2="18.8"/><line x1="18.8" y1="5.2" x2="17" y2="7"/><line x1="7" y1="17" x2="5.2" y2="18.8"/></g>`),
  moon: S(`<path d="M20 14.5 A8 8 0 1 1 9.5 4 A6.2 6.2 0 0 0 20 14.5 Z" fill="currentColor" stroke="none"/>`),
  extract: S(`<path d="M14 3 H7 a2 2 0 0 0 -2 2 V19 a2 2 0 0 0 2 2 H17 a2 2 0 0 0 2 -2 V8 Z" stroke-width="1.7"/><polyline points="14,3 14,8 19,8" stroke-width="1.7"/>`),
  chevDownSmall: S(`<polyline points="6,9 12,15 18,9" stroke-width="2"/>`),
};

export function icon(name: string): string {
  return ICONS[name] ?? "";
}
