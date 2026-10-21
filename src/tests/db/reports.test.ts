import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestDB } from '../testUtils';
import {
  createReport,
  deleteReport,
  finalizeReport,
  getReport,
  listReports,
  listReportsByProjectNumber,
  markReportExported,
  setReportSignature,
  unlockReport,
  updateReport
} from '../../lib/db/reports';
import { addTimeEntry } from '../../lib/db/timeEntries';

beforeEach(async () => {
  await resetTestDB();
});

describe('reports repository', () => {
  it('erstellt einen Bericht mit initialen Summary-Werten auf 0', async () => {
    const report = await createReport({ projectNumber: '2026-001' });

    expect(report.id).toBeTruthy();
    expect(report.projectNumber).toBe('2026-001');
    expect(report.status).toBe('open');
    expect(report.timeEntryCount).toBe(0);
    expect(report.totalDurationMinutes).toBe(0);
    expect(report.materialItemCount).toBe(0);
    expect(report.photoCount).toBe(0);
  });

  it('speichert Kurzbeschreibung, Ansprechpartner und Notizen bereits beim Anlegen', async () => {
    const report = await createReport({
      projectNumber: '2026-002',
      projectDescription: 'Zählerschrank-Sanierung',
      customer: 'Musterfirma GmbH',
      contactPerson: 'Frau Beispiel',
      technicianName: 'Daniel',
      notes: 'Erstbegehung erfolgt'
    });

    expect(report.projectDescription).toBe('Zählerschrank-Sanierung');
    expect(report.contactPerson).toBe('Frau Beispiel');
    expect(report.notes).toBe('Erstbegehung erfolgt');
  });

  it('speichert geplante Mannstunden beim Anlegen und lässt sie nachträglich ändern (plannedLaborHours)', async () => {
    const report = await createReport({ projectNumber: '2026-003', plannedLaborHours: 16 });
    expect(report.plannedLaborHours).toBe(16);

    const updated = await updateReport(report.id, { plannedLaborHours: 20 });
    expect(updated?.plannedLaborHours).toBe(20);
  });

  it('ignoriert eine ungültige geplante Mannstunden-Angabe (0, negativ) beim Anlegen', async () => {
    const report = await createReport({ projectNumber: '2026-004', plannedLaborHours: 0 });
    expect(report.plannedLaborHours).toBeUndefined();
  });

  it('listet Berichte nach updatedAt absteigend', async () => {
    const first = await createReport({ projectNumber: 'A' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await createReport({ projectNumber: 'B' });

    const reports = await listReports();
    expect(reports.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it('filtert Berichte nach Status', async () => {
    const open = await createReport({ projectNumber: 'OPEN' });
    const completed = await createReport({ projectNumber: 'DONE' });
    await updateReport(completed.id, { status: 'completed' });

    const openReports = await listReports('open');
    const completedReports = await listReports('completed');

    expect(openReports.map((r) => r.id)).toEqual([open.id]);
    expect(completedReports.map((r) => r.id)).toEqual([completed.id]);
  });

  it('filtert Berichte nach "locked" (unterschriebene UND manuell final abgeschlossene)', async () => {
    const untouched = await createReport({ projectNumber: 'OPEN' });
    const signed = await createReport({ projectNumber: 'SIGNED' });
    await setReportSignature(signed.id, {
      blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      width: 10,
      height: 10
    });
    const finalized = await createReport({ projectNumber: 'FINALIZED' });
    await finalizeReport(finalized.id);

    const lockedReports = await listReports('locked');

    expect(lockedReports.map((r) => r.id).sort()).toEqual([finalized.id, signed.id].sort());
    expect(lockedReports.map((r) => r.id)).not.toContain(untouched.id);
  });

  it('filtert Berichte nach "not-exported"', async () => {
    const exported = await createReport({ projectNumber: 'EXPORTED' });
    await markReportExported(exported.id);
    const notExported = await createReport({ projectNumber: 'NOT-EXPORTED' });

    const notExportedReports = await listReports('not-exported');

    expect(notExportedReports.map((r) => r.id)).toEqual([notExported.id]);
    expect(notExportedReports.map((r) => r.id)).not.toContain(exported.id);
  });

  it('aktualisiert Felder eines Berichts', async () => {
    const report = await createReport({ projectNumber: '1' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = await updateReport(report.id, { customer: 'Musterfirma GmbH', notes: 'Zählerschrank getauscht' });

    expect(updated?.customer).toBe('Musterfirma GmbH');
    expect(updated?.notes).toBe('Zählerschrank getauscht');
    expect(updated?.updatedAt).not.toBe(report.updatedAt);
  });

  it('liefert undefined beim Update eines nicht existierenden Berichts', async () => {
    const result = await updateReport('does-not-exist', { customer: 'x' });
    expect(result).toBeUndefined();
  });

  it('löscht einen Bericht', async () => {
    const report = await createReport({ projectNumber: '1' });
    await deleteReport(report.id);
    expect(await getReport(report.id)).toBeUndefined();
  });

  it('verliert bei gleichzeitigem updateReport() und Zeiteintrag-Anlage keine der beiden Änderungen', async () => {
    // Regressionstest: updateReport() nutzte früher zwei getrennte
    // Transaktionen (db.get + db.put) statt einer gemeinsamen. Parallel dazu
    // schreibt addTimeEntry() (über recomputeReportSummary) ebenfalls den
    // reports-Datensatz. Ohne gemeinsame Transaktion konnte der zuletzt
    // abgeschlossene Schreibvorgang den anderen überschreiben - z.B. einen
    // Status-Wechsel zurück auf "completed" kippen, obwohl der Nutzer gerade
    // erst auf "open" umgeschaltet hatte.
    const report = await createReport({ projectNumber: '1', notes: 'x' });
    await updateReport(report.id, { status: 'completed' });

    await Promise.all([
      updateReport(report.id, { status: 'open' }),
      addTimeEntry(report.id, { date: '2026-08-11', startTime: '08:00', endTime: '10:00' })
    ]);

    const final = await getReport(report.id);
    expect(final?.status).toBe('open');
    expect(final?.timeEntryCount).toBe(1);
    expect(final?.totalDurationMinutes).toBe(120);
  });

  it('speichert eine Kunden-Unterschrift und sperrt den Bericht dabei (finalizedAt)', async () => {
    const report = await createReport({ projectNumber: '1' });
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });

    const updated = await setReportSignature(report.id, { blob, width: 300, height: 120, signedByName: 'Herr Kunde' });

    expect(updated?.signatureBlob).toBe(blob);
    expect(updated?.signatureWidth).toBe(300);
    expect(updated?.signatureHeight).toBe(120);
    expect(updated?.signedByName).toBe('Herr Kunde');
    expect(updated?.signedAt).toBeTruthy();
    expect(updated?.finalizedAt).toBeTruthy();

    // fake-indexeddb klont Blobs beim Schreiben/Lesen (structured clone) - nach
    // dem erneuten Laden ist es also eine neue Instanz mit gleichem Inhalt.
    const reloaded = await getReport(report.id);
    expect(reloaded?.signatureBlob).toStrictEqual(blob);
    expect(reloaded?.signedByName).toBe('Herr Kunde');
  });

  it('schließt einen Bericht ohne Unterschrift final ab (finalizeReport)', async () => {
    const report = await createReport({ projectNumber: '1' });

    const finalized = await finalizeReport(report.id);

    expect(finalized?.status).toBe('completed');
    expect(finalized?.finalizedAt).toBeTruthy();
    expect(finalized?.signedAt).toBeUndefined();
    expect(finalized?.signatureBlob).toBeUndefined();
  });

  it('hebt die Sperre wieder auf (unlockReport) - egal ob durch Unterschrift oder finalizeReport entstanden', async () => {
    const signedReport = await createReport({ projectNumber: '1' });
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    await setReportSignature(signedReport.id, { blob, width: 300, height: 120, signedByName: 'Herr Kunde' });

    const unlockedSigned = await unlockReport(signedReport.id);
    expect(unlockedSigned?.signatureBlob).toBeUndefined();
    expect(unlockedSigned?.signatureWidth).toBeUndefined();
    expect(unlockedSigned?.signatureHeight).toBeUndefined();
    expect(unlockedSigned?.signedByName).toBeUndefined();
    expect(unlockedSigned?.signedAt).toBeUndefined();
    expect(unlockedSigned?.finalizedAt).toBeUndefined();

    const finalizedReport = await createReport({ projectNumber: '2' });
    await finalizeReport(finalizedReport.id);
    const unlockedFinalized = await unlockReport(finalizedReport.id);
    expect(unlockedFinalized?.finalizedAt).toBeUndefined();

    const reloaded = await getReport(signedReport.id);
    expect(reloaded?.signatureBlob).toBeUndefined();
    expect(reloaded?.finalizedAt).toBeUndefined();
  });

  it('merkt den Export-Zeitpunkt vor (markReportExported)', async () => {
    const report = await createReport({ projectNumber: '1' });
    expect(report.exportedAt).toBeUndefined();

    const exported = await markReportExported(report.id);

    expect(exported?.exportedAt).toBeTruthy();
  });

  it('liefert undefined bei setReportSignature/finalizeReport/unlockReport/markReportExported für nicht existierenden Bericht', async () => {
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    expect(await setReportSignature('does-not-exist', { blob, width: 10, height: 10 })).toBeUndefined();
    expect(await finalizeReport('does-not-exist')).toBeUndefined();
    expect(await unlockReport('does-not-exist')).toBeUndefined();
    expect(await markReportExported('does-not-exist')).toBeUndefined();
  });
});

describe('listReportsByProjectNumber', () => {
  it('liefert eine leere Liste, wenn es keinen Bericht mit dieser Projektnummer gibt', async () => {
    expect(await listReportsByProjectNumber('999999')).toEqual([]);
  });

  it('liefert nur Berichte mit exakt dieser Projektnummer, älteste zuerst', async () => {
    // `createdAt` wird intern per `new Date().toISOString()` gesetzt - die
    // Systemzeit wird hier bewusst nur für `Date` gefaked (nicht Timer),
    // damit die beiden Berichte garantiert unterschiedliche, kontrollierte
    // Zeitstempel bekommen und die Sortierung deterministisch testbar ist -
    // ohne fake-indexeddbs eigene Timer-basierte Event-Verarbeitung zu stören.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-10T08:00:00.000Z'));
      const first = await createReport({ projectNumber: '555555' });
      await finalizeReport(first.id);

      vi.setSystemTime(new Date('2026-08-11T08:00:00.000Z'));
      const second = await createReport({ projectNumber: '555555' });

      await createReport({ projectNumber: 'ANDERE' });

      const related = await listReportsByProjectNumber('555555');
      expect(related.map((r) => r.id)).toEqual([first.id, second.id]);
    } finally {
      vi.useRealTimers();
    }
  });
});
