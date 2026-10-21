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
 *
 * Bewusst der "legacy"-Build (`pdfjs-dist/legacy/build/pdf.mjs`, nicht der
 * Standard-Build `pdfjs-dist`): Auf einem iPhone (Servicetechniker vor Ort)
 * ist nicht sichergestellt, dass immer die allerneueste Safari-Version
 * läuft, und der Standard-Build setzt neuere JS-Engine-Features voraus.
 *
 * Konkret ermittelte Ursache für einen auf einem echten iPhone
 * beobachteten Laufzeitfehler ("undefined is not a function"): pdfjs-dist
 * nutzt bereits beim Laden des Moduls `Promise.withResolvers()` - diese
 * Methode gibt es erst ab Safari 17.4, und sie wird auch vom Legacy-Build
 * NICHT mitpolyfilled (der deckt nur ältere Sprachsyntax ab, keine neuen
 * Standardbibliotheks-Methoden). Ein auf einem älteren iPhone/iPad noch
 * nicht aktualisiertes Safari hat diese Methode schlicht nicht - deshalb
 * hier ein eigener, winziger Polyfill, synchron VOR dem dynamischen Import
 * von pdfjs-dist gesetzt (das Modul wertet ihn schon beim Laden aus, ein
 * Polyfill danach wäre zu spät).
 *
 * WICHTIG - das allein reicht NICHT: `Promise.withResolvers()` wird nicht
 * nur im Haupt-Thread aufgerufen, sondern genauso im selbst gehosteten
 * Worker-Skript (public/pdfjs/pdf.worker.min.mjs, als Module-Worker über
 * `new Worker(url, {type: "module"})` geladen) - ein eigener globaler
 * Scope mit eigenem `Promise`, den der hier gesetzte Polyfill NICHT
 * erreicht. Derselbe Fehler trat deshalb identisch weiter auf, bis
 * zusätzlich direkt in public/pdfjs/pdf.worker.min.mjs derselbe Polyfill
 * als allererste Zeile der Datei eingefügt wurde (ein Module-Worker
 * wertet seinen Dateiinhalt top-down aus, der Polyfill muss also vor dem
 * restlichen - von pdfjs-dist selbst stammenden, nicht editierbaren -
 * Code der Datei stehen). Bei einem künftigen pdfjs-dist-Upgrade (neue
 * Worker-Datei aus node_modules/pdfjs-dist/legacy/build/ kopiert) muss
 * dieser Patch manuell erneut angewendet werden - die erste Zeile der
 * aktuellen public/pdfjs/pdf.worker.min.mjs zeigt den exakten Wortlaut.
 *
 * TATSÄCHLICHE URSACHE (per detailliertem Fehlerbericht von einem echten
 * iPhone mit aktuellem iOS/Safari bestätigt - obiges
 * `Promise.withResolvers` war trotz korrekter Behebung NICHT die Ursache
 * des eigentlich gemeldeten Fehlers, blieb aber als zusätzliche
 * Absicherung bestehen): pdfjs-dist implementiert `page.getTextContent()`
 * intern als `for await (const value of this.streamTextContent(params))`
 * über ein `ReadableStream` - das setzt Async-Iteration auf
 * `ReadableStream` voraus (`ReadableStream.prototype[Symbol.asyncIterator]`),
 * was in Safari erst mit WebKit 26 (2025) eingeführt wurde und je nach
 * genauer Build-/Punktversion noch fehlen oder sich anders verhalten
 * kann. Der Fehlerbericht zeigte den Absturz exakt in
 * `getTextContent@pdf-*.js`, aufgerufen aus unserem eigenen
 * `extractPdfText()`. Workaround, von mehreren Drittprojekten mit
 * demselben pdfjs-dist-Fehlerbild bestätigt (s. Quellen unten): NICHT
 * `page.getTextContent()` aufrufen, sondern dieselbe Aggregation manuell
 * über `page.streamTextContent()` + `ReadableStream.getReader()`/`.read()`
 * nachbauen - das ist die seit Jahren universell unterstützte,
 * Promise-basierte Streaming-API (kein `for await`, keine
 * Async-Iteration nötig). Siehe `collectPageTextItems()` unten.
 * Quellen: https://github.com/keenanlk/stayput/pull/196,
 * https://github.com/mjramos86/bookreader/pull/5
 */
interface PromiseWithResolversConstructor {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
}

function ensurePromiseWithResolversPolyfill(): void {
  const promiseCtor = Promise as unknown as PromiseWithResolversConstructor;
  if (typeof promiseCtor.withResolvers === 'function') return;
  promiseCtor.withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

/**
 * Cache-Busting für die Worker-Datei: `vite.config.ts` cacht public/pdfjs/
 * über Workbox `runtimeCaching` mit "CacheFirst" + 1 Jahr Gültigkeit (statt
 * im normalen Precache, s. dort) - ändert sich der Dateiinhalt (wie hier,
 * Promise.withResolvers-Polyfill ergänzt), bleibt ein bereits
 * zwischengespeichertes Gerät sonst DAUERHAFT auf der alten Datei hängen,
 * da CacheFirst bei gleichbleibender URL nie erneut nachfragt - ein reines
 * Redeploy der App (die übrige, gehashte Precache-Dateien bekommt
 * automatisch frische URLs) reicht hier NICHT aus. Der Versions-Query-
 * Parameter ändert die von Workbox als Cache-Key verwendete URL und zwingt
 * dadurch zu einem frischen Download. Bei jeder inhaltlichen Änderung an
 * public/pdfjs/pdf.worker.min.mjs muss dieser Wert erhöht werden.
 */
const PDF_WORKER_CACHE_VERSION = 2;

export async function extractPdfText(file: File): Promise<string> {
  ensurePromiseWithResolversPolyfill();
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const base = import.meta.env.BASE_URL;
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${base}pdfjs/pdf.worker.min.mjs?v=${PDF_WORKER_CACHE_VERSION}`;

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data, disableFontFace: true });
  const pdf = await loadingTask.promise;

  try {
    const pageTexts: string[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const items = await collectPageTextItems(page);
      pageTexts.push(linesFromTextContent(items).join('\n'));
    }
    return pageTexts.join('\n');
  } finally {
    await loadingTask.destroy();
  }
}

interface StreamedTextContentChunk {
  items: unknown[];
}

function isStreamedTextContentChunk(value: unknown): value is StreamedTextContentChunk {
  return typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items);
}

/**
 * Entspricht inhaltlich `(await page.getTextContent()).items`, aber ohne
 * `for await` über das zurückgegebene ReadableStream (s. Dateikommentar
 * oben, "TATSÄCHLICHE URSACHE") - stattdessen der klassische, überall
 * unterstützte `getReader()`/`.read()`-Lesezyklus.
 */
async function collectPageTextItems(page: { streamTextContent(): ReadableStream }): Promise<unknown[]> {
  const reader = page.streamTextContent().getReader();
  const items: unknown[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (isStreamedTextContentChunk(value)) items.push(...value.items);
    }
  } finally {
    reader.releaseLock();
  }
  return items;
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
