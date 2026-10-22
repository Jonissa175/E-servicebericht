import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import CFB from 'cfb';
import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildReportDocx, suggestedFileName } from '../../lib/export/docxExport';
import type { FullReport } from '../../lib/export/getFullReport';
import type { MaterialItem, Photo, ServiceReport, TimeEntry } from '../../lib/db/types';

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Vitest laeuft ohne Dev-Server in einer Node-Umgebung, wo `fetch()` die von
// Vite verarbeitete, relative Asset-URL der Vorlage nicht aufloesen kann -
// die Datei wird hier stattdessen direkt von der Festplatte gelesen und per
// optionalem Parameter eingespeist (siehe docxExport.ts), damit echte
// Render-Logik statt eines Mocks getestet wird.
const templatePath = fileURLToPath(
  new URL('../../assets/templates/servicebericht-vorlage.docx', import.meta.url)
);
let templateBytes: ArrayBuffer;

beforeAll(() => {
  const buffer = readFileSync(templatePath);
  templateBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
});

function fakeReport(overrides: Partial<ServiceReport> = {}): ServiceReport {
  return {
    id: 'report-1',
    projectNumber: '2026-001',
    projectDescription: 'Zählerschrank-Sanierung EG',
    customer: 'Musterfirma GmbH',
    contactPerson: 'Frau Beispiel',
    technicianName: 'Daniel Sander',
    status: 'open',
    notes: 'Zählerschrank geprüft.\nKunde vor Ort informiert.',
    timeEntryCount: 1,
    totalDurationMinutes: 120,
    materialItemCount: 1,
    photoCount: 1,
    createdAt: '2026-08-10T08:00:00.000Z',
    updatedAt: '2026-08-10T10:00:00.000Z',
    ...overrides
  };
}

function fakeTimeEntry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: 'time-1',
    reportId: 'report-1',
    date: '2026-08-10',
    startTime: '08:00',
    endTime: '10:00',
    durationMinutes: 120,
    createdAt: '2026-08-10T08:00:00.000Z',
    updatedAt: '2026-08-10T08:00:00.000Z',
    ...overrides
  };
}

function fakeMaterialItem(overrides: Partial<MaterialItem> = {}): MaterialItem {
  return {
    id: 'material-1',
    reportId: 'report-1',
    description: 'Kabel NYM-J 3x1,5mm²',
    quantity: 20,
    unit: 'm',
    createdAt: '2026-08-10T08:00:00.000Z',
    updatedAt: '2026-08-10T08:00:00.000Z',
    ...overrides
  };
}

function fakePhoto(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 'photo-1',
    reportId: 'report-1',
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }),
    thumbnailBlob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }),
    mimeType: 'image/jpeg',
    width: 800,
    height: 600,
    sizeBytes: 4,
    takenAt: '2026-08-10T09:00:00.000Z',
    ...overrides
  };
}

function fakeFullReport(overrides: Partial<FullReport> = {}): FullReport {
  return {
    report: fakeReport(),
    timeEntries: [fakeTimeEntry()],
    materialItems: [fakeMaterialItem()],
    photos: [fakePhoto()],
    ...overrides
  };
}

/** Entpackt das erzeugte Blob und liefert word/document.xml als Text - Grundlage fuer alle inhaltlichen Pruefungen unten. */
async function documentXmlOf(blob: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('word/document.xml fehlt im erzeugten docx');
  return file.async('text');
}

async function build(data: FullReport): Promise<Blob> {
  return buildReportDocx(data, templateBytes);
}

/**
 * Eigenständiger, von `timesheetEmbed.ts` UNABHÄNGIGER Mini-BIFF8-Leser nur
 * für diesen Test: liest aus der eingebetteten Excel-Arbeitsmappe die
 * Datenzeilen 2-16 (Spalten 0/1/4/5 - Datum/Techniker/von/bis) aus, um
 * tatsächlich zu beweisen, dass die Werte an der richtigen Stelle in der
 * richtigen Zelle stehen, statt nur die Produktionslogik erneut aufzurufen.
 */
function readEmbeddedTimesheetRows(
  xlsBytes: Uint8Array
): Map<number, { date?: string; technician?: string; start?: number; end?: number }> {
  // BOF/Zell-Records liegen NICHT direkt in den rohen OLE2-Containerbytes,
  // sondern im "Workbook"-Stream darin - deshalb zuerst per `cfb` entpacken.
  const container = CFB.parse(xlsBytes);
  const workbookEntry = container.FileIndex.find((entry) => entry.name === 'Workbook');
  if (!workbookEntry) throw new Error('"Workbook"-Stream nicht im OLE2-Container gefunden');
  const workbookBytes = Uint8Array.from(workbookEntry.content);

  const view = new DataView(workbookBytes.buffer, workbookBytes.byteOffset, workbookBytes.byteLength);
  let pos = 0;
  let bofSeen = 0;
  let worksheetStart = -1;
  while (pos + 4 <= workbookBytes.length) {
    const type = view.getUint16(pos, true);
    const len = view.getUint16(pos + 2, true);
    if (type === 0x0809) {
      bofSeen++;
      if (bofSeen === 2) {
        worksheetStart = pos;
        break;
      }
    }
    pos += 4 + len;
  }
  if (worksheetStart < 0) throw new Error('Worksheet-BOF nicht gefunden');

  const rows = new Map<number, { date?: string; technician?: string; start?: number; end?: number }>();
  pos = worksheetStart;
  while (pos + 4 <= workbookBytes.length) {
    const type = view.getUint16(pos, true);
    const len = view.getUint16(pos + 2, true);
    const bodyStart = pos + 4;
    if (type === 0x000a) break; // EOF
    if (type === 0x0204 /* LABEL */) {
      const row = view.getUint16(bodyStart, true);
      const col = view.getUint16(bodyStart + 2, true);
      const cch = view.getUint16(bodyStart + 6, true);
      const chars = new Uint8Array(workbookBytes.buffer, workbookBytes.byteOffset + bodyStart + 9, cch);
      const text = String.fromCharCode(...chars);
      if (col === 0) rows.set(row, { ...rows.get(row), date: text });
      if (col === 1) rows.set(row, { ...rows.get(row), technician: text });
    } else if (type === 0x0203 /* NUMBER */) {
      const row = view.getUint16(bodyStart, true);
      const col = view.getUint16(bodyStart + 2, true);
      const value = view.getFloat64(bodyStart + 6, true);
      if (col === 4) rows.set(row, { ...rows.get(row), start: value });
      if (col === 5) rows.set(row, { ...rows.get(row), end: value });
    }
    pos = bodyStart + len;
  }
  return rows;
}

function excelTimeFraction(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h * 3600 + m * 60) / 86400;
}

describe('buildReportDocx', () => {
  it('erzeugt einen nicht-leeren Blob mit docx-Mimetype', async () => {
    const blob = await build(fakeFullReport());
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe(DOCX_MIME_TYPE);
  });

  it('traegt die Kopfdaten in die dafuer vorgesehenen Felder der ELSA-Vorlage ein', async () => {
    const blob = await build(
      fakeFullReport({
        report: fakeReport({
          projectNumber: '2026-TEST-777',
          customer: 'Testkunde GmbH',
          technicianName: 'Erika Musterfrau',
          contactPerson: 'Herr Ansprechpartner',
          projectDescription: 'Testprojekt Beschreibung',
          performedWork: 'Testbeschreibung der Arbeiten'
        })
      })
    );
    const xml = await documentXmlOf(blob);
    expect(xml).toContain('2026-TEST-777');
    expect(xml).toContain('Testkunde GmbH');
    // Berichtersteller UND Techniker (Unterschriftenzeile) - derselbe Name an beiden Stellen.
    expect(xml.match(/Erika Musterfrau/g)?.length).toBe(2);
    expect(xml).toContain('Herr Ansprechpartner');
    expect(xml).toContain('Testprojekt Beschreibung');
    expect(xml).toContain('Testbeschreibung der Arbeiten');
  });

  it('traegt das Export-Datum (heutiges Datum, nicht report.createdAt) mit dem festen Firmenstandort in das Ort/Datum-Fußzeilenfeld ein', async () => {
    const blob = await build(fakeFullReport({ report: fakeReport({ createdAt: '2020-01-01T00:00:00.000Z' }) }));
    const xml = await documentXmlOf(blob);
    const today = new Date();
    const expectedDate = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;
    expect(xml).toContain(`Kirchheim bei München, ${expectedDate}`);
  });

  it('befuellt "Durchgefuehrte Arbeiten" ausschliesslich aus performedWork, nicht aus notes', async () => {
    const blob = await build(
      fakeFullReport({ report: fakeReport({ performedWork: 'Sicherung ersetzt', notes: 'Kunde war unzufrieden mit Wartezeit' }) })
    );
    const xml = await documentXmlOf(blob);
    expect(xml).toContain('Sicherung ersetzt');
    // "Kunde war unzufrieden..." landet NICHT bei "Durchgeführte Arbeiten",
    // sondern (separat geprüft unten) im versteckten "Interner Bericht"-Feld.
    const performedWorkRun = xml.match(/<w:r><w:rPr>[^]*?<\/w:rPr><w:t xml:space="preserve">Sicherung ersetzt<\/w:t><\/w:r>/)?.[0];
    expect(performedWorkRun, 'erwartet einen Run für performedWork').toBeDefined();
    expect(performedWorkRun).not.toContain('Kunde war unzufrieden mit Wartezeit');
  });

  it('trägt notes als versteckten Text (w:vanish) in das "Interner Bericht/Bemerkungen/Ersatzteilnummern:"-Feld ein, ohne die Formatierung/Sichtbarkeit zu verändern', async () => {
    const blob = await build(fakeFullReport({ report: fakeReport({ notes: 'Kunde war unzufrieden mit Wartezeit' }) }));
    const xml = await documentXmlOf(blob);
    expect(xml).toContain('Kunde war unzufrieden mit Wartezeit');
    const run = xml.match(/<w:r[^>]*><w:rPr>[^]*?<\/w:rPr><w:t xml:space="preserve">Kunde war unzufrieden mit Wartezeit<\/w:t><\/w:r>/)?.[0];
    expect(run, 'erwartet eine <w:rPr> unmittelbar vor dem Textlauf').toBeDefined();
    // Die Sichtbarkeits-/Formatierungseigenschaften der Vorlage bleiben exakt erhalten.
    expect(run).toContain('<w:vanish/>');
    expect(run).toContain('<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>');
    expect(run).toContain('<w:sz w:val="16"/>');
    expect(run).toContain('<w:szCs w:val="16"/>');
  });

  it('funktioniert ohne Notizen (verstecktes Feld bleibt leer, kein Fehler)', async () => {
    const blob = await build(fakeFullReport({ report: fakeReport({ notes: undefined }) }));
    expect(blob.size).toBeGreaterThan(0);
  });

  it('traegt Ansprechpartner-Name und Telefonnummer in die zwei getrennten Felder der Vorlage ein', async () => {
    const blob = await build(
      fakeFullReport({ report: fakeReport({ contactPerson: 'Sabine Hanslbauer', contactPhone: '0174 8425400' }) })
    );
    const xml = await documentXmlOf(blob);
    expect(xml).toContain('Sabine Hanslbauer');
    expect(xml).toContain('0174 8425400');
    // Die Telefonnummer darf NICHT (mehr) in den Namen gemischt sein.
    expect(xml).not.toContain('Sabine Hanslbauer (Tel.');
  });

  it('erkennt bei Altberichten ohne contactPhone das frühere Merge-Format "Name (Tel. ...)" in contactPerson und trennt es für den Export wieder auf', async () => {
    const blob = await build(
      fakeFullReport({
        report: fakeReport({ contactPerson: 'Sabine Hanslbauer (Tel. 01748425400)', contactPhone: undefined })
      })
    );
    const xml = await documentXmlOf(blob);
    expect(xml).toContain('Sabine Hanslbauer');
    expect(xml).toContain('01748425400');
    expect(xml).not.toContain('Sabine Hanslbauer (Tel.');
  });

  it('funktioniert ohne Ansprechpartner-Telefonnummer (Feld bleibt leer, kein Fehler)', async () => {
    const blob = await build(fakeFullReport({ report: fakeReport({ contactPerson: 'Sabine Hanslbauer', contactPhone: undefined }) }));
    expect(blob.size).toBeGreaterThan(0);
    const xml = await documentXmlOf(blob);
    expect(xml).toContain('Sabine Hanslbauer');
  });

  it('funktioniert ohne Zeiten/Material/Fotos (leerer Bericht) und laesst die Material-Vorlagenzeile komplett entfallen', async () => {
    const blob = await build(
      fakeFullReport({ timeEntries: [], materialItems: [], photos: [], report: fakeReport({ notes: undefined }) })
    );
    expect(blob.size).toBeGreaterThan(0);
    const xml = await documentXmlOf(blob);
    // Platzhalter-Lueckenfueller-Zeichen der (jetzt leeren) Material-Beispielzeile duerfen nicht mehr auftauchen.
    expect(xml).not.toContain('Kabel NYM-J');
  });

  it('dupliziert die Material-Zeile pro Position mit korrekter Artikelnummer/Bezeichnung/Menge', async () => {
    const blob = await build(
      fakeFullReport({
        materialItems: [
          fakeMaterialItem({ id: 'm1', articleNumber: 'ART-100', description: 'Kabel NYM-J 3x1,5', quantity: 10, unit: 'm' }),
          fakeMaterialItem({ id: 'm2', articleNumber: 'ART-200', description: 'Steckdose aws', quantity: 2, unit: 'Stk' }),
          fakeMaterialItem({ id: 'm3', description: 'Ohne Artikelnummer', quantity: 1, unit: 'Stk' })
        ]
      })
    );
    const xml = await documentXmlOf(blob);
    expect(xml).toContain('ART-100');
    expect(xml).toContain('Kabel NYM-J 3x1,5');
    expect(xml).toContain('10 m');
    expect(xml).toContain('ART-200');
    expect(xml).toContain('Steckdose aws');
    expect(xml).toContain('2 Stk');
    expect(xml).toContain('Ohne Artikelnummer');
    expect(xml).toContain('1 Stk');
  });

  it('funktioniert ohne Kurzbeschreibung/Ansprechpartner', async () => {
    const blob = await build(
      fakeFullReport({ report: fakeReport({ projectDescription: undefined, contactPerson: undefined }) })
    );
    expect(blob.size).toBeGreaterThan(0);
  });

  it('bettet bis zu 10 Fotos mit Zeitstempel-Beschreibung in die Dokumentations-Tabelle ein (eigene Relationship + Mediendatei je Foto)', async () => {
    const blob = await build(
      fakeFullReport({
        photos: [
          fakePhoto({ id: 'p1', takenAt: '2026-08-10T09:15:00.000Z' }),
          fakePhoto({ id: 'p2', takenAt: '2026-08-10T10:30:00.000Z', width: undefined, height: undefined })
        ]
      })
    );
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const mediaFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/media/photo'));
    expect(mediaFiles).toHaveLength(2);

    const relsXml = await zip.file('word/_rels/document.xml.rels')!.async('text');
    expect(relsXml).toContain('rIdPhoto0');
    expect(relsXml).toContain('rIdPhoto1');

    const xml = await zip.file('word/document.xml')!.async('text');
    expect(xml).toContain('r:embed="rIdPhoto0"');
    expect(xml).toContain('r:embed="rIdPhoto1"');
    // Fuer die restlichen 8 (unbefuellten) Dokumentations-Zeilen bleibt das
    // Platzhalterbild der Vorlage unveraendert bestehen.
    expect(xml.match(/r:embed="rId22"/g)?.length).toBe(8);
  });

  it('zeigt in der "Beschreibung"-Spalte die eigene Foto-Notiz statt des Zeitstempels', async () => {
    const blob = await build(
      fakeFullReport({
        photos: [fakePhoto({ id: 'p1', takenAt: '2026-08-10T09:15:00.000Z', note: 'Sicherung vor dem Austausch' })]
      })
    );
    const xml = await documentXmlOf(blob);
    expect(xml).toContain('Sicherung vor dem Austausch');
    expect(xml).not.toContain('10.08.2026');
  });

  it('lässt die "Beschreibung"-Spalte ohne eigene Foto-Notiz bewusst leer (kein Zeitstempel-Fallback)', async () => {
    const blob = await build(fakeFullReport({ photos: [fakePhoto({ id: 'p1', takenAt: '2026-08-10T09:15:00.000Z', note: undefined })] }));
    const xml = await documentXmlOf(blob);
    expect(xml).not.toContain('10.08.2026');
  });

  it('begrenzt eingebettete Fotos auf die 10 Zeilen der Vorlage, ohne zu werfen', async () => {
    const manyPhotos = Array.from({ length: 12 }, (_, i) => fakePhoto({ id: `p${i}`, takenAt: `2026-08-10T0${i % 9}:00:00.000Z` }));
    const blob = await build(fakeFullReport({ photos: manyPhotos }));
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const mediaFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/media/photo'));
    expect(mediaFiles).toHaveLength(10);
    const xml = await zip.file('word/document.xml')!.async('text');
    expect(xml.match(/r:embed="rId22"/g)).toBeNull();
  });

  it('traegt bei einer Kunden-Unterschrift nur den gedruckten Namen ein (kein Unterschriftsbild, da die Vorlage dafuer keinen Platz vorsieht)', async () => {
    const blob = await build(
      fakeFullReport({
        report: fakeReport({
          signatureBlob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
          signedByName: 'Herr Kunde Unterschrift',
          signedAt: '2026-08-11T12:00:00.000Z'
        })
      })
    );
    const xml = await documentXmlOf(blob);
    expect(xml).toContain('Herr Kunde Unterschrift');
  });

  it('funktioniert ohne Unterschrift (leeres Namensfeld, kein Fehler)', async () => {
    const blob = await build(fakeFullReport({ report: fakeReport({ signatureBlob: undefined, signedByName: undefined }) }));
    expect(blob.size).toBeGreaterThan(0);
  });

  describe('Schriftformatierung der eingetragenen Werte (Regressionstest für den doppelt verschachtelten <w:rPr>-Bug)', () => {
    it('enthält nirgends mehr ein doppelt verschachteltes <w:rPr><w:rPr> (Ursache des Formatierungsfehlers)', async () => {
      const blob = await build(fakeFullReport());
      const xml = await documentXmlOf(blob);
      expect(xml).not.toContain('<w:rPr><w:rPr>');
      expect(xml).not.toContain('</w:rPr></w:rPr>');
    });

    it('übernimmt für Projektnummer exakt die ursprüngliche Formatierung (Arial, fett, 16pt)', async () => {
      const blob = await build(fakeFullReport({ report: fakeReport({ projectNumber: '2026-TEST-777' }) }));
      const xml = await documentXmlOf(blob);
      const run = xml.match(/<w:r><w:rPr>[^]*?<\/w:rPr><w:t xml:space="preserve">2026-TEST-777<\/w:t><\/w:r>/)?.[0];
      expect(run, 'erwartet eine <w:rPr> unmittelbar vor dem Textlauf').toBeDefined();
      expect(run).toContain('<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>');
      expect(run).toContain('<w:b/>');
      expect(run).toContain('<w:sz w:val="32"/>');
    });

    it('übernimmt für Kundenname/Ansprechpartner/Techniker/Beschreibung/Durchgeführte-Arbeiten die ursprüngliche Formatierung (Arial, 8pt)', async () => {
      const blob = await build(
        fakeFullReport({
          report: fakeReport({
            customer: 'XTestkundeX',
            contactPerson: 'XAnsprechpartnerX',
            technicianName: 'XTechnikerX',
            projectDescription: 'XBeschreibungX',
            performedWork: 'XArbeitenX'
          })
        })
      );
      const xml = await documentXmlOf(blob);
      for (const value of ['XTestkundeX', 'XAnsprechpartnerX', 'XTechnikerX', 'XBeschreibungX', 'XArbeitenX']) {
        const run = xml.match(new RegExp(`<w:r><w:rPr>[^]*?</w:rPr><w:t xml:space="preserve">${value}</w:t></w:r>`))?.[0];
        expect(run, `erwartet eine <w:rPr> unmittelbar vor "${value}"`).toBeDefined();
        expect(run).toContain('<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>');
        expect(run).toContain('<w:sz w:val="16"/>');
        expect(run).toContain('<w:szCs w:val="16"/>');
      }
    });

    it('übernimmt für die Foto-Beschreibungen die ursprüngliche Formatierung (Arial, 10pt)', async () => {
      const blob = await build(fakeFullReport({ photos: [fakePhoto({ note: 'XFotoBeschreibungX' })] }));
      const xml = await documentXmlOf(blob);
      const run = xml.match(/<w:r><w:rPr>[^]*?<\/w:rPr><w:t xml:space="preserve">XFotoBeschreibungX<\/w:t><\/w:r>/)?.[0];
      expect(run, 'erwartet eine <w:rPr> unmittelbar vor der Foto-Beschreibung').toBeDefined();
      expect(run).toContain('<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>');
      expect(run).toContain('<w:sz w:val="20"/>');
      expect(run).toContain('<w:szCs w:val="20"/>');
    });

    it('übernimmt für die Kunden-Unterschrift die ursprüngliche Formatierung (Arial, fett, unterstrichen)', async () => {
      const blob = await build(fakeFullReport({ report: fakeReport({ signedByName: 'XUnterschriftX' }) }));
      const xml = await documentXmlOf(blob);
      const run = xml.match(/<w:r><w:rPr>[^]*?<\/w:rPr><w:t xml:space="preserve">XUnterschriftX<\/w:t><\/w:r>/)?.[0];
      expect(run, 'erwartet eine <w:rPr> unmittelbar vor der Unterschrift').toBeDefined();
      expect(run).toContain('<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>');
      expect(run).toContain('<w:b/>');
      expect(run).toContain('<w:u w:val="single"/>');
    });
  });

  describe('eingebettete "Zeiten"-Excel-Tabelle (OLE-Objekt, kein Word-Tabellenfeld)', () => {
    it('trägt Datum/von/bis mehrerer Zeiteinträge in die richtigen Zeilen/Zellen der eingebetteten Arbeitsmappe ein', async () => {
      const blob = await build(
        fakeFullReport({
          timeEntries: [
            fakeTimeEntry({ id: 't1', date: '2026-10-19', startTime: '08:00', endTime: '16:30' }),
            fakeTimeEntry({ id: 't2', date: '2026-10-20', startTime: '07:30', endTime: '15:45' }),
            // Pausen-Einträge haben in der echten Zeiterfassung keine feste
            // Zeile in dieser Tabelle und müssen übersprungen werden.
            fakeTimeEntry({ id: 't3', date: '2026-10-20', startTime: '12:00', endTime: '12:30', isBreak: true })
          ]
        })
      );
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const xlsFile = zip.file('word/embeddings/Microsoft_Excel_97-2003_Worksheet.xls');
      expect(xlsFile).not.toBeNull();
      const xlsBytes = await xlsFile!.async('uint8array');

      // Äußerer OLE2-Container muss weiterhin gültig sein (CFB.parse wirft bei Strukturschäden).
      const container = CFB.parse(xlsBytes);
      expect(container.FileIndex.some((entry) => entry.name === 'Workbook')).toBe(true);

      const rows = readEmbeddedTimesheetRows(xlsBytes);
      expect(rows.get(2)?.date).toBe('19.10.2026');
      expect(rows.get(2)?.start).toBeCloseTo(excelTimeFraction('08:00'), 10);
      expect(rows.get(2)?.end).toBeCloseTo(excelTimeFraction('16:30'), 10);
      expect(rows.get(3)?.date).toBe('20.10.2026');
      expect(rows.get(3)?.start).toBeCloseTo(excelTimeFraction('07:30'), 10);
      expect(rows.get(3)?.end).toBeCloseTo(excelTimeFraction('15:45'), 10);
      // Der Pausen-Eintrag darf keine dritte Datenzeile belegt haben.
      expect(rows.has(4)).toBe(false);
    });

    it('trägt den Monteur-Namen (report.technicianName) in die eigene "Techniker"-Spalte jeder befüllten Zeile ein', async () => {
      const blob = await build(
        fakeFullReport({
          report: fakeReport({ technicianName: 'Daniel Sander' }),
          timeEntries: [
            fakeTimeEntry({ id: 't1', date: '2026-10-19', startTime: '08:00', endTime: '16:30' }),
            fakeTimeEntry({ id: 't2', date: '2026-10-20', startTime: '07:30', endTime: '15:45' })
          ]
        })
      );
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const xlsBytes = await zip.file('word/embeddings/Microsoft_Excel_97-2003_Worksheet.xls')!.async('uint8array');
      const rows = readEmbeddedTimesheetRows(xlsBytes);
      expect(rows.get(2)?.technician).toBe('Daniel Sander');
      expect(rows.get(3)?.technician).toBe('Daniel Sander');
    });

    it('lässt die "Techniker"-Spalte leer, wenn der Bericht keinen Techniker-Namen hat', async () => {
      const blob = await build(
        fakeFullReport({
          report: fakeReport({ technicianName: undefined }),
          timeEntries: [fakeTimeEntry({ id: 't1', date: '2026-10-19', startTime: '08:00', endTime: '16:30' })]
        })
      );
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const xlsBytes = await zip.file('word/embeddings/Microsoft_Excel_97-2003_Worksheet.xls')!.async('uint8array');
      const rows = readEmbeddedTimesheetRows(xlsBytes);
      expect(rows.get(2)?.technician).toBeUndefined();
    });

    it('lässt die eingebettete Arbeitsmappe unverändert, wenn keine (nutzbaren) Zeiteinträge vorhanden sind', async () => {
      const originalXls = (
        await (await JSZip.loadAsync(templateBytes)).file('word/embeddings/Microsoft_Excel_97-2003_Worksheet.xls')!.async('uint8array')
      ).slice();
      const blob = await build(
        fakeFullReport({
          timeEntries: [fakeTimeEntry({ startTime: undefined, endTime: undefined })]
        })
      );
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const xlsBytes = await zip.file('word/embeddings/Microsoft_Excel_97-2003_Worksheet.xls')!.async('uint8array');
      expect(xlsBytes).toEqual(originalXls);
    });

    it('begrenzt die eingebetteten Zeiteinträge auf die 15 vorformatierten Zeilen der Vorlage, ohne zu werfen', async () => {
      const manyEntries = Array.from({ length: 18 }, (_, i) =>
        fakeTimeEntry({ id: `t${i}`, date: `2026-10-${String(1 + i).padStart(2, '0')}`, startTime: '08:00', endTime: '16:00' })
      );
      const blob = await build(fakeFullReport({ timeEntries: manyEntries }));
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      const xlsBytes = await zip.file('word/embeddings/Microsoft_Excel_97-2003_Worksheet.xls')!.async('uint8array');
      const rows = readEmbeddedTimesheetRows(xlsBytes);
      // Zeilen 2-16 (0-indiziert) = die 15 vorhandenen Datenzeilen, nicht mehr.
      expect(rows.size).toBe(15);
      expect(rows.has(17)).toBe(false);
    });
  });
});

describe('suggestedFileName', () => {
  it('baut einen dateinamensicheren Namen aus der Projektnummer', () => {
    expect(suggestedFileName(fakeReport({ projectNumber: '2026/014 2' }))).toBe('Servicebericht-2026_014_2.docx');
  });

  it('fällt auf einen Platzhalter zurück, wenn die Projektnummer leer ist', () => {
    expect(suggestedFileName(fakeReport({ projectNumber: '  ' }))).toBe('Servicebericht-ohne-Projektnummer.docx');
  });
});
