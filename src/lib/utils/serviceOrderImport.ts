/**
 * Interpretiert den per PDF-Text-Extraktion (siehe
 * src/lib/import/serviceOrderPdf.ts) aus einem ELSA-eigenen
 * "Serviceauftrag"-PDF gelesenen Text - Servicetechniker bekommen diesen
 * Auftrag aktuell per E-Mail/Teams zugeschickt und tippen Projektnummer,
 * Kundendaten und erwartetes Material bisher von Hand ab. Dieser Parser
 * liest stattdessen die wichtigsten Felder automatisch heraus, damit sich
 * daraus in einem Schritt ein neuer Bericht samt vorausgefüllter
 * Materialliste (erwartete Menge je Position) anlegen lässt.
 *
 * Reine Heuristik auf GENAU dieses eine, feste Vorlagen-Format zugeschnitten
 * (ELSA's eigenes ERP-System, erkennbar an "Serviceauftrag"/
 * "Pos. Menge Ein. Text"/"-KUNDENDATEN -" etc.) - kein allgemeingültiger
 * Standard wie bei GS1-Codes (siehe materialScan.ts). Liefert deshalb
 * bewusst nur einen Vorschlag: alle erkannten Felder bleiben vor dem
 * Speichern frei editierbar, nichts wird automatisch final übernommen.
 *
 * Wichtige Eigenart der PDF-Text-Extraktion (pdfjs-dist): Text auf
 * derselben visuellen Zeile wird OHNE jedes Trennzeichen aneinander-
 * gereiht (aus der Tabellenzeile "1.010   4   m   Leitungsführungskanal
 * LF 15x15 vw" wird der String "1.0104mLeitungsführungskanal LF 15x15
 * vw") - Menge und Einheit lassen sich deshalb nicht über Leerzeichen
 * trennen, sondern nur über eine Liste bekannter Einheiten-Schreibweisen
 * (KNOWN_UNITS) erkennen.
 */
export interface ParsedServiceOrderMaterial {
  description: string;
  quantity: number;
  unit: string;
}

export interface ParsedServiceOrder {
  projectNumber?: string;
  /** Die Nummer des Serviceauftrags-Dokuments selbst (nicht die Projektnummer) - z.B. für Rückfragen beim Büro. */
  documentNumber?: string;
  customer?: string;
  contactPerson?: string;
  contactPhone?: string;
  /** Kurzbeschreibung des Auftrags, z.B. "Kabelkanal Markiese, Steckdose Terrasse". */
  projectDescription?: string;
  materials: ParsedServiceOrderMaterial[];
  /** Arbeitsaufwand-/Pauschal-Positionen (z.B. "8 Std. Leitender Monteur") - kein Material, nur zur Information. */
  laborLines: string[];
  /**
   * Summe aller Arbeitsaufwand-Positionen mit Einheit "Std" (Pauschalen/
   * Stückzahlen wie "An- und Abreisepauschale" zählen nicht als Zeit) -
   * Basis für den Mannstunden-Soll/Ist-Vergleich in der Übersicht (siehe
   * ServiceReport.plannedLaborHours). undefined, wenn keine
   * Stunden-Position gefunden wurde.
   */
  plannedLaborHours?: number;
  /** Der unveränderte, aus dem PDF extrahierte Text - immer gesetzt, auch wenn nichts erkannt wurde. */
  raw: string;
}

// Bekannte Mengeneinheiten aus dem Serviceauftrag - längere/spezifischere
// Schreibweisen zuerst in der Alternative, damit z.B. "Std." nicht schon
// durch "Std" ohne den Punkt "abgeschnitten" wird (der Punkt würde sonst in
// der Beschreibung hängen bleiben).
const KNOWN_UNITS = ['Stück', 'Pauschale', 'Std\\.', 'Stck', 'Std', 'lfm', 'Set', 'Pkg', 'kg', 'm'];
const UNIT_PATTERN = KNOWN_UNITS.join('|');

// z.B. "1.0104mLeitungsführungskanal LF 15x15 vw" -> Pos. "1.010", Menge "4", Einheit "m", Text "...".
// Die Unterposition bewusst auf GENAU 3 Ziffern festgelegt (010, 020, 030, ...,
// durchgängig im Vorlagen-Format so verwendet) statt greedy "\d+": sonst wäre
// z.B. bei "3.01020mNYY-J 3x2,5" (Pos. 3.010, Menge 20, Einheit m) nicht
// erkennbar, wo die Unterposition endet und die Menge beginnt - beide sind
// nur Ziffern, ohne jedes Trennzeichen direkt aneinandergereiht.
const ITEM_LINE = new RegExp(`^\\d+\\.\\d{3}(\\d+(?:[.,]\\d+)?)(${UNIT_PATTERN})(.+)$`);
// z.B. "1Kabelkanal Markiese 1.OG" -> Abschnitt "1", Titel "Kabelkanal Markiese 1.OG".
const SECTION_HEADER_LINE = /^\d+([A-Za-zÄÖÜäöüß].*)$/;

const TABLE_HEADER_LINE = /^Pos\.?\s*Menge\s*Ein\.?\s*Text/i;
const PAGE_FOOTER_LINE = /^Seite\s+\d+\s+von\s+\d+$/i;
// Wiederkehrende Brief-/Fußzeilen (Bankverbindung, Handelsregister, Kontakt) -
// werden sonst versehentlich als Fortsetzungszeile der letzten Position
// angehängt, da sie keinem der übrigen Muster entsprechen.
const BOILERPLATE_LINE = [
  /Kreissparkasse/i,
  /SWIFT-BIC/i,
  /^IBAN:/i,
  /HRB\s+\d/,
  /UID-Nr\./,
  /elsa-service\.de/i,
  /^Tel\.:/i,
  /^ELSA\b/i
];

function isBoilerplate(line: string): boolean {
  return BOILERPLATE_LINE.some((pattern) => pattern.test(line));
}

function toPositiveNumber(value: string): number | undefined {
  const num = Number(value.replace(',', '.'));
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

/** Normalisiert "Stck"/"Stück" auf die im Material-Tab übliche Schreibweise "Stk", "Std."/"Std" auf "Std". */
function normalizeUnit(unit: string): string {
  const lower = unit.toLowerCase();
  if (lower === 'stck' || lower === 'stück') return 'Stk';
  if (lower === 'std.' || lower === 'std') return 'Std';
  return unit;
}

function findValue(lines: string[], pattern: RegExp): string | undefined {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return match[1].trim();
  }
  return undefined;
}

/**
 * Sucht den Kundennamen über den Marker "-KUNDENDATEN -" (einziger Block im
 * Dokument, der garantiert NICHT mit der Info-Box oben rechts auf derselben
 * Zeile verschmilzt - siehe PDF-Extraktions-Eigenart oben) - die ersten paar
 * Zeilen danach sind Anrede (Frau/Herr/Firma, optional), Name, Straße, PLZ/Ort.
 */
function findCustomer(lines: string[]): string | undefined {
  const index = lines.findIndex((line) => /^-?\s*KUNDENDATEN\s*-?$/i.test(line));
  if (index === -1) return undefined;
  const candidates = lines.slice(index + 1, index + 4);
  const nameLine = candidates.find((line) => !/^(Frau|Herr|Firma|Familie)$/i.test(line));
  return nameLine;
}

export function parseServiceOrderText(rawText: string): ParsedServiceOrder {
  const raw = rawText.trim();
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const projectNumber = findValue(lines, /Projektnummer:\s*(\S+)/);
  const documentNumber = findValue(lines, /Dok-nr\.\s*:\s*(\S+)/);
  const projectDescription = findValue(lines, /Auftrag:\s*(.+)/);
  const contactPerson = findValue(lines, /Ansprechpartner vor Ort:\s*(.+)/);
  const contactPhone = findValue(lines, /Telefon:\s*(.+)/);
  const customer = findCustomer(lines);

  const materials: ParsedServiceOrderMaterial[] = [];
  const laborLines: string[] = [];
  let plannedLaborHoursSum = 0;

  // Erst ab der Tabellen-Kopfzeile ("Pos. Menge Ein. Text") wird überhaupt
  // nach Positionen gesucht - alles davor (Kopf-/Kundendaten) ist bereits
  // oben per findValue()/findCustomer() behandelt und soll hier nicht
  // versehentlich als Fortsetzungszeile einer Position misverstanden werden.
  let inTable = false;
  let section: 'material' | 'labor' = 'material';
  // Zeiger auf die zuletzt erkannte Position - Folgezeilen ohne eigenes
  // Positions-/Abschnitts-Muster (z.B. "Obermonteur für Energie- und
  // Gebäudetechnik") werden daran als Fortsetzung der Beschreibung angehängt.
  let currentMaterial: ParsedServiceOrderMaterial | undefined;
  let currentLaborIndex: number | undefined;

  for (const line of lines) {
    if (TABLE_HEADER_LINE.test(line)) {
      inTable = true;
      currentMaterial = undefined;
      currentLaborIndex = undefined;
      continue;
    }
    if (!inTable || PAGE_FOOTER_LINE.test(line) || isBoilerplate(line)) continue;

    const itemMatch = ITEM_LINE.exec(line);
    if (itemMatch) {
      const [, quantityText, unitText, description] = itemMatch;
      const quantity = toPositiveNumber(quantityText);
      const text = description.trim();
      if (quantity === undefined || !text) continue;
      const unit = normalizeUnit(unitText);
      if (section === 'labor') {
        laborLines.push(`${quantityText} ${unit} ${text}`.trim());
        currentLaborIndex = laborLines.length - 1;
        currentMaterial = undefined;
        if (unit === 'Std') plannedLaborHoursSum += quantity;
      } else {
        currentMaterial = { description: text, quantity, unit };
        materials.push(currentMaterial);
        currentLaborIndex = undefined;
      }
      continue;
    }

    const sectionMatch = SECTION_HEADER_LINE.exec(line);
    if (sectionMatch) {
      const title = sectionMatch[1].trim();
      section = /arbeitsaufwand/i.test(title) ? 'labor' : 'material';
      currentMaterial = undefined;
      currentLaborIndex = undefined;
      continue;
    }

    // Fortsetzungszeile der zuletzt erkannten Position (z.B. eine zweite
    // Beschreibungszeile) - andernfalls bleibt die Zeile ohne Effekt.
    if (currentMaterial) {
      currentMaterial.description = `${currentMaterial.description} ${line}`.trim();
    } else if (currentLaborIndex !== undefined) {
      laborLines[currentLaborIndex] = `${laborLines[currentLaborIndex]} ${line}`.trim();
    }
  }

  return {
    projectNumber,
    documentNumber,
    customer,
    contactPerson,
    contactPhone,
    projectDescription,
    materials,
    laborLines,
    plannedLaborHours: plannedLaborHoursSum > 0 ? plannedLaborHoursSum : undefined,
    raw
  };
}
