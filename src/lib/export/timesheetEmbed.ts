import type PizZip from 'pizzip';
import type { TimeEntry } from '../db/types';
import { formatDateDE } from '../utils/date';

/**
 * Befüllt die in die ELSA-Vorlage eingebettete Excel-"Zeiten"-Tabelle mit
 * `report.timeEntries`. Das ist KEINE normale Word-Tabelle (daher in der
 * ersten Umsetzung von buildReportDocx übersehen), sondern ein eingebettetes
 * OLE-Objekt (`<w:object>`/`ProgID="Excel.Sheet.8"`) - eine komplette,
 * eigenständige Excel-97-2003-Arbeitsmappe (`.xls`, binäres BIFF8/OLE2-
 * Compound-Document-Format, NICHT das moderne ZIP-basierte .xlsx), die der
 * Nutzer bisher händisch ausgefüllt hat, indem er im Word-Dokument doppelt
 * darauf klickt.
 *
 * WARUM NICHT MIT `docx`/`xlsx`-BIBLIOTHEKEN WIE BEI DER WORD-VORLAGE SELBST:
 * Die gängige, gepflegte JS-Bibliothek für Excel-Dateien (`xlsx`/SheetJS)
 * kann diese konkrete Datei nicht einlesen ("XLS Record 0x2 Truncated") -
 * nachweislich kein Bug meinerseits, sondern eine echte Einschränkung der
 * Bibliothek: Excel speichert beim "Nur Speichern" (ohne "Speichern unter")
 * über viele Jahre inkrementell, wodurch im BIFF8-Stream nach dem
 * eigentlichen Inhalt (erkennbar am abschließenden `EOF`-Record) noch
 * "Slack"-Reste einer früheren, größeren Version der Datei übrig bleiben
 * (diese Datei wurde laut eingebetteten Metadaten zuletzt 2026 gespeichert,
 * ursprünglich aber 2010 angelegt) - SheetJS' Parser versucht diese Reste
 * fälschlich als weiteren Record zu interpretieren und bricht ab. Ein
 * eigener, bewusst minimaler BIFF8-Scanner (`scanRecordsUntilEof()` unten)
 * umgeht das, indem er wie Excel selbst exakt beim `EOF`-Record aufhört.
 * Für den äußeren OLE2-Container (Compound File Binary Format) kommt
 * stattdessen das schlanke, von SheetJS separat veröffentlichte `cfb`-Paket
 * zum Einsatz (keine Sicherheitslücken, nur zwei kleine Abhängigkeiten,
 * anders als das große `xlsx`-Hauptpaket - das zudem an genau dieser Datei
 * ohnehin scheitert) - rein für Lesen/Schreiben der rohen Streams, ohne
 * jede BIFF8-Interpretation.
 *
 * ZELL-STRUKTUR (per Hand mit `xlrd`/eigenem Scanner an der Originaldatei
 * untersucht, siehe auch Analyse im Export-Modul-Kommentar): Das Blatt
 * "Tabelle1" hat 15 vorformatierte Dateneingabe-Zeilen (Excel-Zeilen 3-17,
 * 0-indiziert 2-16), jede mit genau einem `MULBLANK`-Record über die
 * Spalten 0-5 (Datum/Techniker/Anfahrt-Fahrzeit/Anfahrt-Km/von/bis - alle
 * leer). Die Spalten 6 ("Stunden") und 7 ("Ü-Std.") sowie 13/14 (versteckte
 * Zwischenrechnung, Spaltenkopf "NUR BERECHNUNG!") sind FORMEL-Zellen, die
 * "von"/"bis" (Spalte 4/5) als echte Excel-Uhrzeitwerte referenzieren
 * (bestätigt durch Dekodierung der RPN-Tokens: `col13 = F - E`, `col6`
 * verrechnet wiederum `col13`/`col14`) - deshalb werden "von"/"bis" hier NICHT
 * als Text, sondern als Zahl (Bruchteil eines 24h-Tages, Excels natives
 * Uhrzeit-Format) geschrieben, damit die Formelkette beim Öffnen in Excel
 * korrekt neu rechnet (die Arbeitsmappe steht auf automatischer Berechnung,
 * `CalcMode`-Record bestätigt das). Nur "Datum" (Spalte 0) ist reiner Text,
 * da keine Formel sie referenziert.
 *
 * BEKANNTE EINSCHRÄNKUNG (ausdrücklich zu kommunizieren, nicht zu
 * verschweigen): Die zwischengespeicherten Formel-ERGEBNISSE (Stunden/
 * Ü-Std./Gesamtsumme) sowie das eingebettete Vorschaubild, das Word OHNE
 * Öffnen des Excel-Objekts anzeigt (separates `media/image3.emf`,
 * Enhanced-Metafile-Format, nur ein vollwertiger Rendering-Motor für Excel
 * könnte das neu erzeugen), werden durch diesen Eingriff NICHT aktualisiert
 * - sie zeigen bis zum ersten Öffnen/Neuberechnen in echtem Excel (Doppelklick
 * auf das Objekt, oder einfach die docx in Word öffnen - automatische
 * Berechnung ist aktiviert) weiterhin "0,0"/den alten Platzhalterstand. Die
 * eingetragenen Rohdaten (Datum/von/bis) selbst sind sofort korrekt und
 * dauerhaft in der Datei gespeichert.
 *
 * Nebeneffekt von `cfb` beim Neuschreiben des OLE2-Containers (unschädlich):
 * `CFB.write()` fügt automatisch einen winzigen (4 Byte), mit `\u0001Sh33tJ5`
 * benannten Signatur-Stream hinzu, an dem sich Excel/Word nicht stören (kein
 * Programm referenziert oder benötigt ihn) - ein Entfernen würde ein
 * riskantes, nicht öffentlich dokumentiertes Nachführen interner `cfb`-
 * Arrays (`FileIndex`/`FullPaths`) erfordern und wurde deshalb bewusst nicht
 * versucht.
 */

/** Pfad der eingebetteten Arbeitsmappe innerhalb der Vorlage - siehe `<o:OLEObject ... r:id="rId21">` in word/document.xml. */
const EMBEDDED_WORKBOOK_PATH = 'word/embeddings/Microsoft_Excel_97-2003_Worksheet.xls';

/** Erste/letzte 0-indizierte Datenzeile im Tabellenblatt "Tabelle1" (Excel-Zeilen 3-17). */
const FIRST_DATA_ROW = 2;
const LAST_DATA_ROW = 16;
/** Harte Obergrenze aus dem Vorlagen-Layout: genau 15 vorformatierte Zeilen, nicht änderbar ohne das Blatt selbst umzubauen. */
const MAX_TIME_ENTRIES = LAST_DATA_ROW - FIRST_DATA_ROW + 1;

const RT_EOF = 0x000a;
const RT_BOF = 0x0809;
const RT_MULBLANK = 0x00be;
const RT_LABEL = 0x0204;
const RT_BLANK = 0x0201;
const RT_NUMBER = 0x0203;

interface Biff8Record {
  type: number;
  pos: number;
  len: number;
  bodyStart: number;
}

/** Läuft die Records eines BIFF8-Streams ab `startPos` ab und bricht - wie Excel selbst - exakt beim ersten `EOF` ab (siehe Dateikommentar: alles danach kann "Slack" einer älteren Dateiversion sein). */
function scanRecordsUntilEof(stream: Uint8Array, view: DataView, startPos: number): Biff8Record[] {
  const records: Biff8Record[] = [];
  let pos = startPos;
  while (pos + 4 <= stream.length) {
    const type = view.getUint16(pos, true);
    const len = view.getUint16(pos + 2, true);
    const bodyStart = pos + 4;
    records.push({ type, pos, len, bodyStart });
    if (type === RT_EOF) break;
    pos = bodyStart + len;
  }
  return records;
}

/** Position des zweiten `BOF`-Records (= Beginn des Tabellenblatt-Substreams, nach dem globalen Substream). */
function findWorksheetBofOffset(stream: Uint8Array, view: DataView): number {
  let pos = 0;
  let bofSeen = 0;
  while (pos + 4 <= stream.length) {
    const type = view.getUint16(pos, true);
    const len = view.getUint16(pos + 2, true);
    if (type === RT_BOF) {
      bofSeen++;
      if (bofSeen === 2) return pos;
    }
    pos += 4 + len;
  }
  throw new Error('Worksheet-BOF nicht gefunden - unerwartete Struktur der eingebetteten Arbeitsmappe');
}

function buildLabelRecord(row: number, col: number, ixfe: number, text: string): Uint8Array {
  const textBytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) textBytes[i] = text.charCodeAt(i) & 0xff;
  const out = new Uint8Array(4 + 9 + textBytes.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, RT_LABEL, true);
  view.setUint16(2, 9 + textBytes.length, true);
  view.setUint16(4, row, true);
  view.setUint16(6, col, true);
  view.setUint16(8, ixfe, true);
  view.setUint16(10, textBytes.length, true);
  view.setUint8(12, 0x00); // flags: komprimierte 8-Bit-Zeichen (reicht für Datum/Uhrzeit-Text)
  out.set(textBytes, 13);
  return out;
}

function buildBlankRecord(row: number, col: number, ixfe: number): Uint8Array {
  const out = new Uint8Array(4 + 6);
  const view = new DataView(out.buffer);
  view.setUint16(0, RT_BLANK, true);
  view.setUint16(2, 6, true);
  view.setUint16(4, row, true);
  view.setUint16(6, col, true);
  view.setUint16(8, ixfe, true);
  return out;
}

function buildNumberRecord(row: number, col: number, ixfe: number, value: number): Uint8Array {
  const out = new Uint8Array(4 + 14);
  const view = new DataView(out.buffer);
  view.setUint16(0, RT_NUMBER, true);
  view.setUint16(2, 14, true);
  view.setUint16(4, row, true);
  view.setUint16(6, col, true);
  view.setUint16(8, ixfe, true);
  view.setFloat64(10, value, true);
  return out;
}

/** "HH:mm" als Bruchteil eines 24h-Tages (Excels natives Uhrzeitformat), z.B. "08:00" -> 0,3333... */
function timeToExcelFraction(hhmm: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return (hours * 3600 + minutes * 60) / 86400;
}

/**
 * `cfb` liefert `FileIndex[].content` je nach Umgebung als `Uint8Array`,
 * Node-`Buffer` ODER als einfaches `Array<number>` (beobachtet beim Lesen
 * der von PizZip entpackten Bytes) - `Uint8Array.from()` kopiert aus allen
 * drei Formen zuverlässig die reinen Byte-Werte, ohne sich auf `.buffer`/
 * `.byteOffset` zu verlassen (die bei einem einfachen Array gar nicht
 * existieren).
 */
function toUint8Array(content: ArrayLike<number>): Uint8Array {
  return Uint8Array.from(content);
}

/** Patcht die Workbook-BIFF8-Records der übergebenen Rohdaten direkt (keine Neuerzeugung der Arbeitsmappe - nur gezielte Zell-Records innerhalb der 15 Datenzeilen werden ausgetauscht, alles andere bleibt byte-identisch). */
function patchWorkbookStream(stream: Uint8Array, entries: TimeEntry[]): Uint8Array {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const worksheetBof = findWorksheetBofOffset(stream, view);
  const records = scanRecordsUntilEof(stream, view, worksheetBof);

  const rowBlankRecords = new Map<number, Biff8Record>();
  for (const record of records) {
    if (record.type !== RT_MULBLANK) continue;
    const row = view.getUint16(record.bodyStart, true);
    const firstCol = view.getUint16(record.bodyStart + 2, true);
    if (row < FIRST_DATA_ROW || row > LAST_DATA_ROW || firstCol !== 0) continue;
    const lastCol = view.getUint16(record.bodyStart + record.len - 2, true);
    if (lastCol === 5) rowBlankRecords.set(row, record);
  }

  const edits: { start: number; end: number; bytes: Uint8Array }[] = [];
  let dataRow = FIRST_DATA_ROW;
  for (const entry of entries) {
    const record = rowBlankRecords.get(dataRow);
    if (!record) break;
    const startFraction = entry.startTime ? timeToExcelFraction(entry.startTime) : undefined;
    const endFraction = entry.endTime ? timeToExcelFraction(entry.endTime) : undefined;
    if (startFraction === undefined || endFraction === undefined) {
      dataRow++;
      continue;
    }

    const ixfe = [0, 1, 2, 3, 4, 5].map((col) => view.getUint16(record.bodyStart + 4 + col * 2, true));
    const parts = [
      buildLabelRecord(dataRow, 0, ixfe[0], formatDateDE(entry.date)),
      buildBlankRecord(dataRow, 1, ixfe[1]),
      buildBlankRecord(dataRow, 2, ixfe[2]),
      buildBlankRecord(dataRow, 3, ixfe[3]),
      buildNumberRecord(dataRow, 4, ixfe[4], startFraction),
      buildNumberRecord(dataRow, 5, ixfe[5], endFraction)
    ];
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    edits.push({ start: record.pos, end: record.bodyStart + record.len, bytes });
    dataRow++;
  }

  if (edits.length === 0) return stream;

  const patched = new Uint8Array(stream.length + edits.reduce((sum, e) => sum + (e.bytes.length - (e.end - e.start)), 0));
  let srcCursor = 0;
  let dstCursor = 0;
  for (const edit of edits) {
    patched.set(stream.subarray(srcCursor, edit.start), dstCursor);
    dstCursor += edit.start - srcCursor;
    patched.set(edit.bytes, dstCursor);
    dstCursor += edit.bytes.length;
    srcCursor = edit.end;
  }
  patched.set(stream.subarray(srcCursor), dstCursor);
  return patched;
}

/** Siehe Dateikommentar oben - mutiert `zip` direkt. Einträge ohne `startTime`/`endTime` oder mit `isBreak` werden übersprungen, mehr als `MAX_TIME_ENTRIES` werden gekappt (siehe README). */
export async function injectTimeEntries(zip: PizZip, timeEntries: TimeEntry[]): Promise<void> {
  const relevant = timeEntries.filter((entry) => !entry.isBreak && entry.startTime && entry.endTime);
  if (relevant.length === 0) return;

  const workbookFile = zip.file(EMBEDDED_WORKBOOK_PATH);
  if (!workbookFile) return; // sollte bei dieser Vorlage nie vorkommen, rein defensiv

  const cfb = (await import('cfb')).default;
  const container = cfb.parse(toUint8Array(workbookFile.asUint8Array()));
  const workbookEntry = container.FileIndex.find((entry) => entry.name === 'Workbook');
  if (!workbookEntry) return;

  const patchedStream = patchWorkbookStream(toUint8Array(workbookEntry.content), relevant.slice(0, MAX_TIME_ENTRIES));
  workbookEntry.content = patchedStream;

  const patchedWorkbookBytes = new Uint8Array(cfb.write(container, { type: 'array' }));
  zip.file(EMBEDDED_WORKBOOK_PATH, patchedWorkbookBytes, { binary: true });
}
