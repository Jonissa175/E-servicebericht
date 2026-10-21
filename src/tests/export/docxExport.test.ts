import { describe, expect, it } from 'vitest';
import { buildReportDocx, suggestedFileName } from '../../lib/export/docxExport';
import type { FullReport } from '../../lib/export/getFullReport';
import type { MaterialItem, Photo, ServiceReport, TimeEntry } from '../../lib/db/types';

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

describe('buildReportDocx', () => {
  it('erzeugt einen nicht-leeren Blob mit docx-Mimetype', async () => {
    const blob = await buildReportDocx(fakeFullReport());
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe(DOCX_MIME_TYPE);
  });

  it('funktioniert ohne Zeiten/Material/Fotos (leerer Bericht)', async () => {
    const blob = await buildReportDocx(
      fakeFullReport({ timeEntries: [], materialItems: [], photos: [], report: fakeReport({ notes: undefined }) })
    );
    expect(blob.size).toBeGreaterThan(0);
  });

  it('zeigt bei Material mit geplanter Menge (Serviceauftrag-Import) die zusätzliche "Geplant"-Spalte, ohne zu werfen', async () => {
    const blob = await buildReportDocx(
      fakeFullReport({
        materialItems: [
          fakeMaterialItem({ plannedQuantity: 4, quantity: 3 }),
          fakeMaterialItem({ id: 'material-2', description: 'Manuell ergänzt', plannedQuantity: undefined })
        ]
      })
    );
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe(DOCX_MIME_TYPE);
  });

  it('funktioniert ohne Kurzbeschreibung/Ansprechpartner', async () => {
    const blob = await buildReportDocx(
      fakeFullReport({ report: fakeReport({ projectDescription: undefined, contactPerson: undefined }) })
    );
    expect(blob.size).toBeGreaterThan(0);
  });

  it('bettet mehrere Fotos ein, ohne zu werfen', async () => {
    const blob = await buildReportDocx(
      fakeFullReport({ photos: [fakePhoto({ id: 'photo-1' }), fakePhoto({ id: 'photo-2', width: undefined, height: undefined })] })
    );
    expect(blob.size).toBeGreaterThan(0);
  });

  it('bettet eine vorhandene Kunden-Unterschrift ein', async () => {
    const blob = await buildReportDocx(
      fakeFullReport({
        report: fakeReport({
          signatureBlob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
          signatureWidth: 400,
          signatureHeight: 150,
          signedByName: 'Herr Kunde',
          signedAt: '2026-08-11T12:00:00.000Z'
        })
      })
    );
    expect(blob.size).toBeGreaterThan(0);
  });

  it('funktioniert ohne Unterschrift (kein Abschnitt, kein Fehler)', async () => {
    const blob = await buildReportDocx(fakeFullReport({ report: fakeReport({ signatureBlob: undefined }) }));
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
