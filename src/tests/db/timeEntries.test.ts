import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDB } from '../testUtils';
import { createReport, getReport } from '../../lib/db/reports';
import {
  addTimeEntry,
  deleteTimeEntry,
  findOverlappingTimeEntries,
  getActiveTimeEntry,
  getGloballyActiveTimeEntry,
  listTimeEntries,
  listTimeEntriesForDate,
  trimOverlappingTimeEntries,
  updateTimeEntry
} from '../../lib/db/timeEntries';

beforeEach(async () => {
  await resetTestDB();
});

describe('timeEntries repository', () => {
  it('berechnet die Dauer automatisch aus Start-/Endzeit', async () => {
    const report = await createReport({ projectNumber: '1' });
    const entry = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '12:30' });

    expect(entry.durationMinutes).toBe(270);
  });

  it('übernimmt eine manuell gesetzte Dauer ohne Start/Ende', async () => {
    const report = await createReport({ projectNumber: '1' });
    const entry = await addTimeEntry(report.id, { date: '2026-08-10', durationMinutes: 90 });

    expect(entry.durationMinutes).toBe(90);
  });

  it('berechnet eine über Mitternacht laufende Zeitspanne korrekt (Ende vor Start = nächster Tag)', async () => {
    const report = await createReport({ projectNumber: '1' });
    const entry = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '19:05', endTime: '12:16' });

    expect(entry.durationMinutes).toBe(17 * 60 + 11);
  });

  it('aktualisiert die Dauer neu, wenn Start/Ende geändert werden', async () => {
    const report = await createReport({ projectNumber: '1' });
    const entry = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '12:00' });
    expect(entry.durationMinutes).toBe(240);

    const updated = await updateTimeEntry(entry.id, { endTime: '13:15' });
    expect(updated?.durationMinutes).toBe(315);
  });

  it('aktualisiert Summary-Felder des Reports nach Hinzufügen/Löschen', async () => {
    const report = await createReport({ projectNumber: '1' });
    const first = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '12:00' });
    await addTimeEntry(report.id, { date: '2026-08-11', startTime: '08:00', endTime: '10:00' });

    let updatedReport = await getReport(report.id);
    expect(updatedReport?.timeEntryCount).toBe(2);
    expect(updatedReport?.totalDurationMinutes).toBe(240 + 120);

    await deleteTimeEntry(first.id);
    updatedReport = await getReport(report.id);
    expect(updatedReport?.timeEntryCount).toBe(1);
    expect(updatedReport?.totalDurationMinutes).toBe(120);
  });

  it('timeEntryCount zählt unterschiedliche Kalendertage, nicht die Anzahl der Zeiteintrags-Datensätze (mehrfaches Ein-/Ausstempeln am selben Tag erhöht die "Tage"-Anzeige nicht mehrfach)', async () => {
    const report = await createReport({ projectNumber: '1' });
    // Zwei getrennte Einträge am selben Tag (z.B. vormittags/nachmittags).
    await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '12:00' });
    await addTimeEntry(report.id, { date: '2026-08-10', startTime: '13:00', endTime: '17:00' });

    let updatedReport = await getReport(report.id);
    expect(updatedReport?.timeEntryCount).toBe(1);

    // Ein weiterer Eintrag an einem ANDEREN Tag erhöht die Anzahl korrekt.
    await addTimeEntry(report.id, { date: '2026-08-11', startTime: '08:00', endTime: '10:00' });
    updatedReport = await getReport(report.id);
    expect(updatedReport?.timeEntryCount).toBe(2);

    // Ein dritter Eintrag am ERSTEN Tag ändert die Anzahl weiterhin nicht.
    await addTimeEntry(report.id, { date: '2026-08-10', startTime: '18:00', endTime: '19:00' });
    updatedReport = await getReport(report.id);
    expect(updatedReport?.timeEntryCount).toBe(2);
  });

  it('listet Zeiteinträge sortiert nach Datum', async () => {
    const report = await createReport({ projectNumber: '1' });
    await addTimeEntry(report.id, { date: '2026-08-12', startTime: '08:00', endTime: '10:00' });
    await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '10:00' });
    await addTimeEntry(report.id, { date: '2026-08-11', startTime: '08:00', endTime: '10:00' });

    const entries = await listTimeEntries(report.id);
    expect(entries.map((e) => e.date)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
  });
});

describe('Leerlaufzeit-Einträge (reportId === undefined)', () => {
  it('addTimeEntry(undefined, …) rührt keine Report-Summary an und taucht in keiner Report-Liste auf', async () => {
    const report = await createReport({ projectNumber: '1' });
    await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '09:00' });

    const idle = await addTimeEntry(undefined, { date: '2026-08-10', startTime: '09:00', endTime: '09:30' });

    expect(idle.reportId).toBeUndefined();
    const updatedReport = await getReport(report.id);
    expect(updatedReport?.timeEntryCount).toBe(1);
    expect(updatedReport?.totalDurationMinutes).toBe(60);
    expect(await listTimeEntries(report.id)).toHaveLength(1);
  });

  it('updateTimeEntry mit reportId-Wechsel aktualisiert alten UND neuen Bericht korrekt', async () => {
    const reportA = await createReport({ projectNumber: 'A' });
    const reportB = await createReport({ projectNumber: 'B' });
    const entry = await addTimeEntry(reportA.id, { date: '2026-08-10', startTime: '08:00', endTime: '09:00' });

    await updateTimeEntry(entry.id, { reportId: reportB.id });

    const updatedA = await getReport(reportA.id);
    const updatedB = await getReport(reportB.id);
    expect(updatedA?.timeEntryCount).toBe(0);
    expect(updatedA?.totalDurationMinutes).toBe(0);
    expect(updatedB?.timeEntryCount).toBe(1);
    expect(updatedB?.totalDurationMinutes).toBe(60);
  });

  it('updateTimeEntry ordnet einen Leerlaufzeit-Eintrag einem Bericht zu und aktualisiert dessen Summary', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const idle = await addTimeEntry(undefined, { date: '2026-08-10', startTime: '08:00', endTime: '08:45' });

    const updated = await updateTimeEntry(idle.id, { reportId: report.id });

    expect(updated?.reportId).toBe(report.id);
    const updatedReport = await getReport(report.id);
    expect(updatedReport?.timeEntryCount).toBe(1);
    expect(updatedReport?.totalDurationMinutes).toBe(45);
  });

  it('deleteTimeEntry eines Leerlaufzeit-Eintrags rührt keine Report-Summary an', async () => {
    const report = await createReport({ projectNumber: '1' });
    await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '09:00' });
    const idle = await addTimeEntry(undefined, { date: '2026-08-10', startTime: '09:00', endTime: '09:30' });

    await deleteTimeEntry(idle.id);

    const updatedReport = await getReport(report.id);
    expect(updatedReport?.timeEntryCount).toBe(1);
    expect(updatedReport?.totalDurationMinutes).toBe(60);
  });
});

describe('getActiveTimeEntry (Ein-/Auschecken)', () => {
  it('liefert undefined ohne laufenden Eintrag', async () => {
    const report = await createReport({ projectNumber: '1' });
    expect(await getActiveTimeEntry(report.id)).toBeUndefined();
  });

  it('erkennt einen eingecheckten Eintrag ohne Endzeit als aktiv', async () => {
    const report = await createReport({ projectNumber: '1' });
    const entry = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00' });

    const active = await getActiveTimeEntry(report.id);
    expect(active?.id).toBe(entry.id);
  });

  it('ist nicht mehr aktiv, sobald ausgecheckt wurde', async () => {
    const report = await createReport({ projectNumber: '1' });
    const entry = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00' });
    await updateTimeEntry(entry.id, { endTime: '16:00' });

    expect(await getActiveTimeEntry(report.id)).toBeUndefined();
  });

  it('ignoriert bereits abgeschlossene Einträge anderer Tage', async () => {
    const report = await createReport({ projectNumber: '1' });
    await addTimeEntry(report.id, { date: '2026-08-09', startTime: '08:00', endTime: '16:00' });
    const active = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00' });

    expect((await getActiveTimeEntry(report.id))?.id).toBe(active.id);
  });
});

describe('getGloballyActiveTimeEntry (nur eine Stempel-Session gleichzeitig)', () => {
  it('liefert undefined, wenn nirgends eingestempelt ist', async () => {
    await createReport({ projectNumber: '1' });
    expect(await getGloballyActiveTimeEntry()).toBeUndefined();
  });

  it('findet einen laufenden Eintrag berichtsübergreifend', async () => {
    const reportA = await createReport({ projectNumber: 'A' });
    await createReport({ projectNumber: 'B' });
    const entry = await addTimeEntry(reportA.id, { date: '2026-08-11', startTime: '08:00' });

    const active = await getGloballyActiveTimeEntry();
    expect(active?.id).toBe(entry.id);
    expect(active?.reportId).toBe(reportA.id);
  });

  it('ist undefined, nachdem in allen Berichten ausgecheckt wurde', async () => {
    const report = await createReport({ projectNumber: '1' });
    const entry = await addTimeEntry(report.id, { date: '2026-08-11', startTime: '08:00' });
    await updateTimeEntry(entry.id, { endTime: '16:00' });

    expect(await getGloballyActiveTimeEntry()).toBeUndefined();
  });
});

describe('findOverlappingTimeEntries (Plausibilitätsprüfung)', () => {
  it('findet eine echte Überschneidung', async () => {
    const report = await createReport({ projectNumber: '1' });
    const existing = await addTimeEntry(report.id, { date: '2026-08-11', startTime: '08:00', endTime: '12:00' });

    const overlaps = await findOverlappingTimeEntries('2026-08-11', '10:00', '14:00');
    expect(overlaps.map((e) => e.id)).toEqual([existing.id]);
  });

  it('findet Überschneidungen berichtsübergreifend', async () => {
    const reportA = await createReport({ projectNumber: 'A' });
    const reportB = await createReport({ projectNumber: 'B' });
    const entryA = await addTimeEntry(reportA.id, { date: '2026-08-11', startTime: '08:00', endTime: '10:00' });
    const entryB = await addTimeEntry(reportB.id, { date: '2026-08-11', startTime: '09:00', endTime: '11:00' });

    const overlaps = await findOverlappingTimeEntries('2026-08-11', '08:30', '09:30');
    expect(overlaps.map((e) => e.id).sort()).toEqual([entryA.id, entryB.id].sort());
  });

  it('behandelt direkt aneinandergrenzende Zeiten NICHT als Überschneidung', async () => {
    const report = await createReport({ projectNumber: '1' });
    await addTimeEntry(report.id, { date: '2026-08-11', startTime: '08:00', endTime: '10:00' });

    const overlaps = await findOverlappingTimeEntries('2026-08-11', '10:00', '12:00');
    expect(overlaps).toEqual([]);
  });

  it('ignoriert Einträge an anderen Tagen', async () => {
    const report = await createReport({ projectNumber: '1' });
    await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '12:00' });

    const overlaps = await findOverlappingTimeEntries('2026-08-11', '08:00', '12:00');
    expect(overlaps).toEqual([]);
  });

  it('ignoriert Einträge ohne beide Zeiten (laufende Session, reiner Dauer-Eintrag)', async () => {
    const report = await createReport({ projectNumber: '1' });
    await addTimeEntry(report.id, { date: '2026-08-11', startTime: '08:00' }); // noch eingecheckt
    await addTimeEntry(report.id, { date: '2026-08-11', durationMinutes: 60 }); // nur manuelle Dauer

    const overlaps = await findOverlappingTimeEntries('2026-08-11', '08:00', '10:00');
    expect(overlaps).toEqual([]);
  });

  it('schließt den per excludeEntryId angegebenen Eintrag aus (Bearbeiten ohne Selbstüberschneidung)', async () => {
    const report = await createReport({ projectNumber: '1' });
    const entry = await addTimeEntry(report.id, { date: '2026-08-11', startTime: '08:00', endTime: '10:00' });

    const overlaps = await findOverlappingTimeEntries('2026-08-11', '08:00', '10:00', entry.id);
    expect(overlaps).toEqual([]);
  });
});

describe('trimOverlappingTimeEntries (Zeitfenster wegschneiden statt ganzen Eintrag löschen)', () => {
  it('kürzt einen Eintrag, dessen ENDE sich mit dem Ausschnitt überschneidet, statt ihn zu löschen', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const existing = await addTimeEntry(report.id, { date: '2026-08-11', startTime: '08:00', endTime: '12:00' });

    await trimOverlappingTimeEntries([existing], '10:00', '14:00');

    const remaining = await listTimeEntries(report.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].startTime).toBe('08:00');
    expect(remaining[0].endTime).toBe('10:00');
    expect(remaining[0].durationMinutes).toBe(120);
  });

  it('kürzt einen Eintrag, dessen ANFANG sich mit dem Ausschnitt überschneidet, statt ihn zu löschen', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const existing = await addTimeEntry(report.id, { date: '2026-08-11', startTime: '09:00', endTime: '11:00' });

    await trimOverlappingTimeEntries([existing], '08:00', '10:00');

    const remaining = await listTimeEntries(report.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].startTime).toBe('10:00');
    expect(remaining[0].endTime).toBe('11:00');
    expect(remaining[0].durationMinutes).toBe(60);
  });

  it('splittet einen Eintrag in zwei Teile, wenn der Ausschnitt komplett innerhalb liegt', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const existing = await addTimeEntry(report.id, {
      date: '2026-08-11',
      startTime: '08:00',
      endTime: '16:00',
      note: 'Ganztags'
    });

    await trimOverlappingTimeEntries([existing], '11:00', '12:00');

    const remaining = await listTimeEntries(report.id);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((e) => [e.startTime, e.endTime])).toEqual([
      ['08:00', '11:00'],
      ['12:00', '16:00']
    ]);
    expect(remaining.every((e) => e.note === 'Ganztags')).toBe(true);
    const updatedReport = await getReport(report.id);
    expect(updatedReport?.totalDurationMinutes).toBe(180 + 240);
  });

  it('löscht einen Eintrag vollständig, wenn er komplett innerhalb des Ausschnitts liegt', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const existing = await addTimeEntry(report.id, { date: '2026-08-11', startTime: '10:00', endTime: '11:00' });

    await trimOverlappingTimeEntries([existing], '09:00', '12:00');

    expect(await listTimeEntries(report.id)).toEqual([]);
  });

  it('behält workDayId und reportId=undefined (Leerlaufzeit) beim Splitten bei', async () => {
    const idle = await addTimeEntry(undefined, {
      date: '2026-08-11',
      startTime: '08:00',
      endTime: '10:00',
      workDayId: 'workday-1'
    });

    await trimOverlappingTimeEntries([idle], '08:30', '09:00');

    const entries = await listTimeEntriesForDate('2026-08-11');
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.reportId === undefined)).toBe(true);
    expect(entries.every((e) => e.workDayId === 'workday-1')).toBe(true);
    expect(entries.map((e) => [e.startTime, e.endTime])).toEqual([
      ['08:00', '08:30'],
      ['09:00', '10:00']
    ]);
  });

  it('verarbeitet mehrere überschneidende Einträge unabhängig voneinander', async () => {
    const reportA = await createReport({ projectNumber: 'A' });
    const reportB = await createReport({ projectNumber: 'B' });
    const entryA = await addTimeEntry(reportA.id, { date: '2026-08-11', startTime: '08:00', endTime: '10:00' });
    const entryB = await addTimeEntry(reportB.id, { date: '2026-08-11', startTime: '09:30', endTime: '13:00' });

    await trimOverlappingTimeEntries([entryA, entryB], '09:00', '10:30');

    const remainingA = await listTimeEntries(reportA.id);
    const remainingB = await listTimeEntries(reportB.id);
    expect(remainingA.map((e) => [e.startTime, e.endTime])).toEqual([['08:00', '09:00']]);
    expect(remainingB.map((e) => [e.startTime, e.endTime])).toEqual([['10:30', '13:00']]);
  });
});

describe('listTimeEntriesForDate (Tagesbilanz über mehrere Tagesstempel-Zyklen hinweg)', () => {
  it('liefert eine leere Liste ohne Einträge an dem Tag', async () => {
    expect(await listTimeEntriesForDate('2026-08-11')).toEqual([]);
  });

  it('fasst Einträge mit unterschiedlicher workDayId, aber gleichem Datum zusammen', async () => {
    const report = await createReport({ projectNumber: '1' });
    await addTimeEntry(undefined, {
      date: '2026-08-11',
      startTime: '08:00',
      endTime: '08:30',
      workDayId: 'workday-1'
    });
    await addTimeEntry(report.id, {
      date: '2026-08-11',
      startTime: '09:00',
      endTime: '09:45',
      workDayId: 'workday-2'
    });

    const entries = await listTimeEntriesForDate('2026-08-11');

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.workDayId).sort()).toEqual(['workday-1', 'workday-2']);
  });

  it('ignoriert manuelle Einträge ohne workDayId', async () => {
    const report = await createReport({ projectNumber: '1' });
    await addTimeEntry(report.id, { date: '2026-08-11', startTime: '08:00', endTime: '09:00' }); // manuell, keine workDayId

    expect(await listTimeEntriesForDate('2026-08-11')).toEqual([]);
  });

  it('ignoriert Einträge an anderen Tagen', async () => {
    await addTimeEntry(undefined, {
      date: '2026-08-10',
      startTime: '08:00',
      endTime: '09:00',
      workDayId: 'workday-1'
    });

    expect(await listTimeEntriesForDate('2026-08-11')).toEqual([]);
  });

  it('sortiert nach Startzeit', async () => {
    await addTimeEntry(undefined, { date: '2026-08-11', startTime: '14:00', endTime: '15:00', workDayId: 'w2' });
    await addTimeEntry(undefined, { date: '2026-08-11', startTime: '08:00', endTime: '09:00', workDayId: 'w1' });

    const entries = await listTimeEntriesForDate('2026-08-11');

    expect(entries.map((e) => e.startTime)).toEqual(['08:00', '14:00']);
  });
});
