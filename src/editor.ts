import { PDFDocument, rgb, degrees, StandardFonts } from "pdf-lib";
import { Annotation } from "./state";

function hex01(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}
const col = (hex: string) => rgb(...hex01(hex));

// ---- structural editing (return new PDF bytes) ----------------------------
export async function rotatePage(bytes: Uint8Array, idx: number, deg: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(idx);
  page.setRotation(degrees((page.getRotation().angle + deg + 360) % 360));
  return doc.save();
}

export async function reorderPages(bytes: Uint8Array, order: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, order);
  copied.forEach((p) => out.addPage(p));
  return out.save();
}

export async function deletePage(bytes: Uint8Array, idx: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const order = doc.getPageIndices().filter((i) => i !== idx);
  return reorderPages(bytes, order);
}

export async function movePage(bytes: Uint8Array, from: number, to: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const order = doc.getPageIndices();
  const [m] = order.splice(from, 1);
  order.splice(to, 0, m);
  return reorderPages(bytes, order);
}

export async function duplicatePage(bytes: Uint8Array, idx: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const [copy] = await doc.copyPages(doc, [idx]);
  doc.insertPage(idx + 1, copy);
  return doc.save();
}

export async function insertBlank(bytes: Uint8Array, idx: number, w: number, h: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  doc.insertPage(idx, [w, h]);
  return doc.save();
}

export async function mergePdf(bytes: Uint8Array, other: Uint8Array): Promise<number> {
  // returns count appended; caller uses bytes from the resolved save
  const doc = await PDFDocument.load(bytes);
  const src = await PDFDocument.load(other);
  const pages = await doc.copyPages(src, src.getPageIndices());
  pages.forEach((p) => doc.addPage(p));
  return src.getPageCount();
}

export async function mergePdfBytes(bytes: Uint8Array, other: Uint8Array): Promise<{ bytes: Uint8Array; added: number }> {
  const doc = await PDFDocument.load(bytes);
  const src = await PDFDocument.load(other);
  const pages = await doc.copyPages(src, src.getPageIndices());
  pages.forEach((p) => doc.addPage(p));
  return { bytes: await doc.save(), added: src.getPageCount() };
}

export async function extractPage(bytes: Uint8Array, idx: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const [p] = await out.copyPages(src, [idx]);
  out.addPage(p);
  return out.save();
}

export async function pageSize(bytes: Uint8Array, idx: number): Promise<[number, number]> {
  const doc = await PDFDocument.load(bytes);
  const s = doc.getPage(idx).getSize();
  return [s.width, s.height];
}

// ---- export with baked annotations ----------------------------------------
export async function exportAnnotated(bytes: Uint8Array, annotations: Annotation[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  for (const a of annotations) {
    const page = pages[a.page];
    if (!page) continue;
    const H = page.getSize().height;
    const w = a.width ?? 2;
    const flipY = (yTop: number) => H - yTop;

    switch (a.kind) {
      case "highlight":
        for (const r of a.rects ?? []) {
          page.drawRectangle({ x: r[0], y: flipY(r[3]), width: r[2] - r[0], height: r[3] - r[1], color: col(a.color), opacity: 0.35 });
        }
        break;
      case "rect": {
        const r = a.rect!;
        page.drawRectangle({ x: r[0], y: flipY(r[3]), width: r[2] - r[0], height: r[3] - r[1], borderColor: col(a.color), borderWidth: w, color: a.fill ? col(a.color) : undefined, opacity: a.fill ? 0.25 : undefined });
        break;
      }
      case "ellipse": {
        const r = a.rect!;
        page.drawEllipse({ x: (r[0] + r[2]) / 2, y: flipY((r[1] + r[3]) / 2), xScale: Math.abs(r[2] - r[0]) / 2, yScale: Math.abs(r[3] - r[1]) / 2, borderColor: col(a.color), borderWidth: w, color: a.fill ? col(a.color) : undefined, opacity: a.fill ? 0.25 : undefined });
        break;
      }
      case "line":
        page.drawLine({ start: { x: a.p1![0], y: flipY(a.p1![1]) }, end: { x: a.p2![0], y: flipY(a.p2![1]) }, thickness: w, color: col(a.color) });
        break;
      case "arrow": {
        const p1 = a.p1!, p2 = a.p2!;
        page.drawLine({ start: { x: p1[0], y: flipY(p1[1]) }, end: { x: p2[0], y: flipY(p2[1]) }, thickness: w, color: col(a.color) });
        const ang = Math.atan2(-(p2[1] - p1[1]), p2[0] - p1[0]);
        const hs = Math.max(8, w * 4);
        for (const off of [Math.PI * 0.85, -Math.PI * 0.85]) {
          page.drawLine({ start: { x: p2[0], y: flipY(p2[1]) }, end: { x: p2[0] + hs * Math.cos(ang + off), y: flipY(p2[1]) + hs * Math.sin(ang + off) }, thickness: w, color: col(a.color) });
        }
        break;
      }
      case "pen":
        for (const stroke of a.strokes ?? []) {
          for (let i = 1; i < stroke.length; i++) {
            page.drawLine({ start: { x: stroke[i - 1][0], y: flipY(stroke[i - 1][1]) }, end: { x: stroke[i][0], y: flipY(stroke[i][1]) }, thickness: w, color: col(a.color) });
          }
        }
        break;
      case "text": {
        const r = a.rect!;
        const size = a.fontSize ?? 14;
        page.drawText(a.text ?? "", { x: r[0] + 2, y: flipY(r[1] + size), size, font, color: col(a.color), maxWidth: r[2] - r[0] - 4, lineHeight: size * 1.2 });
        break;
      }
      case "note": {
        const p = a.point!;
        page.drawRectangle({ x: p[0], y: flipY(p[1] + 18), width: 16, height: 18, color: col(a.color), borderColor: rgb(0.36, 0.25, 0.22), borderWidth: 1 });
        if (a.text) page.drawText(a.text, { x: p[0] + 22, y: flipY(p[1] + 12), size: 9, font, color: rgb(0.2, 0.2, 0.2), maxWidth: 180, lineHeight: 11 });
        break;
      }
      case "redact": {
        const r = a.rect!;
        const isRedact = a.mode === "redact";
        page.drawRectangle({ x: r[0], y: flipY(r[3]), width: r[2] - r[0], height: r[3] - r[1], color: isRedact ? rgb(0, 0, 0) : rgb(1, 1, 1) });
        break;
      }
    }
  }
  return doc.save();
}
