import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
          notes: 'Testnotiz Zeile eins'
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
    expect(xml).toContain('Testnotiz Zeile eins');
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
});

describe('suggestedFileName', () => {
  it('baut einen dateinamensicheren Namen aus der Projektnummer', () => {
    expect(suggestedFileName(fakeReport({ projectNumber: '2026/014 2' }))).toBe('Servicebericht-2026_014_2.docx');
  });

  it('fällt auf einen Platzhalter zurück, wenn die Projektnummer leer ist', () => {
    expect(suggestedFileName(fakeReport({ projectNumber: '  ' }))).toBe('Servicebericht-ohne-Projektnummer.docx');
  });
});
