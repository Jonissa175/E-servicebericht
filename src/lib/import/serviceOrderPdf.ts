/**
 * Liest den Volltext eines PDF-Dokuments aus - hier: ein vom Büro per
 * E-Mail/Teams verschickter Serviceauftrag (siehe serviceOrderImport.ts für
 * die eigentliche Interpretation des Textes). Nutzt `pdfjs-dist`, dynamisch
 * nachgeladen (dasselbe Muster wie bei `docx`/`jsqr`/`tesseract.js` - landet
 * dadurch in einem eigenen Chunk, nicht im Hauptbundle) und mit selbst
 * gehostetem Worker-Skript (public/pdfjs/, kein CDN - konsistent mit dem
 * bestehenden Offline-First-Ansatz der App, siehe BarcodeScanner.svelte
 * "Etikett-Text" für dieselbe Begründung bei tesseract.js).
 *
 * pdfjs-dist liefert Text NICHT zeilenweise, sondern als Liste einzelner
 * Text-Fragmente mit Positionsangabe (transform-Matrix) - für den
 * zeilenbasierten Parser (serviceOrderImport.ts) werden Fragmente hier
 * anhand ihrer Y-Position zu Zeilen gruppiert (kleine Toleranz, da
 * Fragmente derselben Zeile nicht immer exakt dieselbe Y-Koordinate haben,
 * z.B. bei leicht unterschiedlicher Schriftgröße) und innerhalb einer Zeile
 * von links nach rechts sortiert. Liefert bewusst KEINE Leerzeichen
 * zwischen Fragmenten derselben Zeile (das PDF selbst trägt dort keine
 * Trennzeichen ein) - serviceOrderImport.ts ist genau darauf ausgelegt.
 *
 * Ohne `standardFontDataUrl` meldet pdfjs-dist in der Konsole eine Warnung
 * zu nicht eingebetteten Standard-Schriftarten - rein kosmetisch und ohne
 * Effekt auf die Text-Extraktion (es wird nirgends gerendert, nur der reine
 * Text ausgelesen), deshalb bewusst nicht extra nachgeladen.
 */
export async function extractPdfText(file: File): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  const base = import.meta.env.BASE_URL;
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${base}pdfjs/pdf.worker.min.mjs`;

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data, disableFontFace: true });
  const pdf = await loadingTask.promise;

  try {
    const pageTexts: string[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      pageTexts.push(linesFromTextContent(textContent.items).join('\n'));
    }
    return pageTexts.join('\n');
  } finally {
    await loadingTask.destroy();
  }
}

interface PositionedTextItem {
  str: string;
  /** PDF-Transform-Matrix [a, b, c, d, x, y] - nur x (Index 4) und y (Index 5) werden hier gebraucht. */
  transform: number[];
}

function isPositionedTextItem(item: unknown): item is PositionedTextItem {
  const candidate = item as Partial<PositionedTextItem>;
  return typeof candidate.str === 'string' && candidate.str.trim() !== '' && Array.isArray(candidate.transform);
}

/** Gruppiert Text-Fragmente zu Zeilen (siehe Dateikommentar oben), oben nach unten, je Zeile links nach rechts. */
function linesFromTextContent(items: unknown[]): string[] {
  const positioned = items.filter(isPositionedTextItem);
  const Y_TOLERANCE = 2;
  const buckets: { y: number; items: PositionedTextItem[] }[] = [];
  for (const item of positioned) {
    const y = item.transform[5];
    const bucket = buckets.find((candidate) => Math.abs(candidate.y - y) <= Y_TOLERANCE);
    if (bucket) {
      bucket.items.push(item);
    } else {
      buckets.push({ y, items: [item] });
    }
  }
  return buckets
    .sort((a, b) => b.y - a.y)
    .map((bucket) =>
      bucket.items
        .sort((a, b) => a.transform[4] - b.transform[4])
        .map((item) => item.str)
        .join('')
    );
}
