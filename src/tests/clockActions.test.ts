import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestDB } from './testUtils';
import {
  addManualBreak,
  addManualIdleTime,
  addManualProjectTime,
  assignIdleTime,
  autoCheckOutIfExceeded,
  checkInDay,
  checkOutDay,
  reassignIdleEntry,
  startProjectByNumber,
  switchToIdle,
  switchToProject,
  updateManualIdleTime,
  updateManualTimeEntry
} from '../lib/clockActions';
import { createReport, finalizeReport, getReport, listReports } from '../lib/db/reports';
import {
  addTimeEntry,
  deleteTimeEntry,
  getGloballyActiveTimeEntry,
  listTimeEntries,
  listTimeEntriesForWorkDay,
  listUnassignedIdleEntries,
  restoreBreak,
  updateTimeEntry
} from '../lib/db/timeEntries';
import { checkInWorkDay, checkOutWorkDay, getActiveWorkDay } from '../lib/db/workDays';
import { getDayBreaks, getDayIdleEntries } from '../lib/db/stats';
import { todayISODate } from '../lib/utils/date';

beforeEach(async () => {
  await resetTestDB();
});

describe('checkInDay', () => {
  it('startet den Tag und öffnet sofort einen Leerlaufzeit-Eintrag', async () => {
    const day = await checkInDay();

    expect(day.checkInTime).toBeTruthy();
    expect(day.checkOutTime).toBeUndefined();
    const active = await getGloballyActiveTimeEntry();
    expect(active?.workDayId).toBe(day.id);
    expect(active?.reportId).toBeUndefined();
  });

  it('ist idempotent, wenn bereits ein Tag läuft', async () => {
    const day1 = await checkInDay();
    const day2 = await checkInDay();

    expect(day2.id).toBe(day1.id);
    const entries = await listTimeEntriesForWorkDay(day1.id);
    expect(entries).toHaveLength(1);
  });
});

describe('switchToProject', () => {
  it('startet transparent den Tag, wenn noch keiner läuft ("Direkt einchecken")', async () => {
    const report = await createReport({ projectNumber: 'A' });

    const result = await switchToProject(report.id);

    expect(result).toBe(true);
    const day = await getActiveWorkDay();
    expect(day).toBeTruthy();
    const active = await getGloballyActiveTimeEntry();
    expect(active?.reportId).toBe(report.id);
    expect(active?.workDayId).toBe(day?.id);
  });

  it('verweigert den Wechsel in einen gesperrten Bericht', async () => {
    const report = await createReport({ projectNumber: 'A' });
    await finalizeReport(report.id);

    const result = await switchToProject(report.id);

    expect(result).toBe(false);
    expect(await getActiveWorkDay()).toBeUndefined();
  });

  it('fragt beim Wechsel von Leerlaufzeit in ein Projekt nicht nach', async () => {
    await checkInDay();
    const report = await createReport({ projectNumber: 'A' });
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);

    const result = await switchToProject(report.id);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(result).toBe(true);
    vi.unstubAllGlobals();
  });

  it('fragt beim Wechsel zwischen zwei verschiedenen Projekten nach und wechselt bei Bestätigung', async () => {
    const reportA = await createReport({ projectNumber: 'A' });
    const reportB = await createReport({ projectNumber: 'B' });
    await switchToProject(reportA.id);
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);

    const result = await switchToProject(reportB.id);

    expect(confirmSpy).toHaveBeenCalled();
    expect(result).toBe(true);
    const active = await getGloballyActiveTimeEntry();
    expect(active?.reportId).toBe(reportB.id);
    vi.unstubAllGlobals();
  });

  it('bricht bei Ablehnung der Rückfrage ab und bleibt im alten Projekt', async () => {
    const reportA = await createReport({ projectNumber: 'A' });
    const reportB = await createReport({ projectNumber: 'B' });
    await switchToProject(reportA.id);
    vi.stubGlobal('confirm', vi.fn(() => false));

    const result = await switchToProject(reportB.id);

    expect(result).toBe(false);
    const active = await getGloballyActiveTimeEntry();
    expect(active?.reportId).toBe(reportA.id);
    vi.unstubAllGlobals();
  });

  it('fragt nicht nach, wenn bereits im selben Bericht eingecheckt ist', async () => {
    const report = await createReport({ projectNumber: 'A' });
    await switchToProject(report.id);
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);

    await switchToProject(report.id);

    expect(confirmSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('switchToIdle', () => {
  it('hat keinen Effekt, wenn kein Tag läuft', async () => {
    await switchToIdle();

    expect(await getActiveWorkDay()).toBeUndefined();
  });

  it('schließt den Projekt-Eintrag und öffnet Leerlaufzeit', async () => {
    const report = await createReport({ projectNumber: 'A' });
    await switchToProject(report.id);
    const activeBefore = await getGloballyActiveTimeEntry();

    await switchToIdle();

    const activeAfter = await getGloballyActiveTimeEntry();
    expect(activeAfter?.reportId).toBeUndefined();
    expect(activeAfter?.id).not.toBe(activeBefore?.id);
    const [closed] = await listTimeEntries(report.id);
    expect(closed?.endTime).toBeTruthy();
  });
});

describe('checkOutDay', () => {
  it('liefert undefined ohne aktiven Tag', async () => {
    expect(await checkOutDay()).toBeUndefined();
  });

  it('schließt einen noch offenen Abschnitt beim Auschecken', async () => {
    const day = await checkInWorkDay();
    await addTimeEntry(undefined, { date: todayISODate(), startTime: '08:00', workDayId: day.id });

    const summary = await checkOutDay();

    expect(summary?.workDay.checkOutTime).toBeTruthy();
    const [entry] = await listTimeEntriesForWorkDay(day.id);
    expect(entry?.endTime).toBeTruthy();
  });

  it('berechnet Gesamt-/Projekt-/Leerlaufzeit korrekt bei gemischten Abschnitten', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const day = await checkInWorkDay();
    await addTimeEntry(undefined, {
      date: todayISODate(),
      startTime: '08:00',
      endTime: '08:30',
      workDayId: day.id
    });
    await addTimeEntry(report.id, {
      date: todayISODate(),
      startTime: '08:30',
      endTime: '10:00',
      workDayId: day.id
    });
    await addTimeEntry(undefined, {
      date: todayISODate(),
      startTime: '10:00',
      endTime: '10:15',
      workDayId: day.id
    });

    const summary = await checkOutDay();

    expect(summary?.idleMinutes).toBe(45);
    expect(summary?.projectMinutes).toBe(90);
    expect(summary?.totalMinutes).toBe(135);
  });

  it('kumuliert über mehrere Aus-/Wiedereinstempel-Zyklen am selben Kalendertag, statt bei 0 neu anzufangen', async () => {
    // Erster Zyklus: einstempeln, 30 Min Leerlaufzeit, wieder ausstempeln.
    await checkInDay();
    let entry = await getGloballyActiveTimeEntry();
    await updateTimeEntry(entry!.id, { startTime: '08:00', endTime: '08:30' });
    const firstSummary = await checkOutDay();
    expect(firstSummary?.totalMinutes).toBe(30);

    // Zweiter Zyklus, selber Tag: erneut einstempeln (neuer WorkDay-Datensatz,
    // aber gleiches Datum) und weitere 45 Min Leerlaufzeit.
    await checkInDay();
    entry = await getGloballyActiveTimeEntry();
    await updateTimeEntry(entry!.id, { startTime: '09:00', endTime: '09:45' });
    const secondSummary = await checkOutDay();

    // Die Tagesbilanz muss beide Zyklen zusammenzählen (30 + 45 = 75), nicht
    // nur den zweiten Zyklus isoliert (was auf 45 zurückfallen würde).
    expect(secondSummary?.totalMinutes).toBe(75);
    expect(secondSummary?.idleMinutes).toBe(75);
    expect(secondSummary?.workDay.id).not.toBe(firstSummary?.workDay.id);
  });

  it('zählt nur Einträge des jeweiligen Kalendertages, nicht anderer Tage', async () => {
    const yesterday = await checkInWorkDay();
    await addTimeEntry(undefined, {
      date: '2020-01-01',
      startTime: '08:00',
      endTime: '09:00',
      workDayId: yesterday.id
    });
    await checkOutWorkDay(yesterday.id);

    await checkInDay();
    const entry = await getGloballyActiveTimeEntry();
    await updateTimeEntry(entry!.id, { startTime: '08:00', endTime: '08:20' });

    const summary = await checkOutDay();

    expect(summary?.totalMinutes).toBe(20);
  });
});

describe('autoCheckOutIfExceeded (automatisches Ausstempeln bei Überschreitung der Höchstarbeitszeit)', () => {
  it('liefert undefined, wenn kein Tag aktiv ist', async () => {
    expect(await autoCheckOutIfExceeded()).toBeUndefined();
  });

  it('liefert undefined, solange die Höchstarbeitszeit noch nicht erreicht ist', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-10T06:00:00'));
      await checkInDay();

      vi.setSystemTime(new Date('2026-08-10T14:00:00')); // 8 Std. später - noch unter der Grenze
      const result = await autoCheckOutIfExceeded();

      expect(result).toBeUndefined();
      expect(await getActiveWorkDay()).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('liefert noch undefined bei genau 10 Std. verstrichener Zeit - die gesetzliche Pflichtpause (45 Min.) ist in der Grenze mit eingerechnet, nicht schon bei der reinen Höchstarbeitszeit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-10T06:00:00'));
      await checkInDay();

      vi.setSystemTime(new Date('2026-08-10T16:30:00')); // 10 Std. 30 Min. - über der reinen Höchstarbeitszeit, aber noch unter 10 Std. 45 Min.
      const result = await autoCheckOutIfExceeded();

      expect(result).toBeUndefined();
      expect(await getActiveWorkDay()).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stempelt automatisch aus, sobald Höchstarbeitszeit + Pflichtpause (10 Std. 45 Min.) erreicht ist, gekappt auf Einstempelzeit + 10 Std. 45 Min. statt auf "jetzt"', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-10T06:00:00'));
      const day = await checkInDay();

      vi.setSystemTime(new Date('2026-08-10T18:30:00')); // 12,5 Std. später - deutlich über der Grenze
      const result = await autoCheckOutIfExceeded();

      expect(result?.cappedAt).toBe('16:45'); // 06:00 + 10 Std. 45 Min., NICHT 18:30
      expect(result?.workDay.checkOutTime).toBe('16:45');
      expect(await getActiveWorkDay()).toBeUndefined();

      const entries = await listTimeEntriesForWorkDay(day.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].endTime).toBe('16:45');
      expect(entries[0].durationMinutes).toBe(645);
    } finally {
      vi.useRealTimers();
    }
  });

  it('erkennt auch ein über mehrere Kalendertage vergessenes Auschecken (echte Datums-Differenz statt nur "HH:mm"-Arithmetik)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-10T08:00:00'));
      await checkInDay();

      // App erst zwei Tage später wieder geöffnet.
      vi.setSystemTime(new Date('2026-08-12T09:00:00'));
      const result = await autoCheckOutIfExceeded();

      expect(result?.cappedAt).toBe('18:45'); // 08:00 + 10 Std. 45 Min., unabhängig davon, wie viele Tage seither vergangen sind
    } finally {
      vi.useRealTimers();
    }
  });

  it('schließt den gerade offenen Abschnitt (Projekt, nicht nur Leerlaufzeit) mit der gekappten Zeit ab', async () => {
    const report = await createReport({ projectNumber: 'A' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-10T07:00:00'));
      await checkInDay();
      await switchToProject(report.id);

      vi.setSystemTime(new Date('2026-08-10T20:00:00'));
      await autoCheckOutIfExceeded();

      const entries = await listTimeEntries(report.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].endTime).toBe('17:45'); // 07:00 + 10 Std. 45 Min.
      expect(await getGloballyActiveTimeEntry()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hat keinen Effekt, wenn der Tag bereits ausgestempelt ist', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-10T06:00:00'));
      await checkInDay();
      await checkOutDay();

      vi.setSystemTime(new Date('2026-08-10T20:00:00'));
      expect(await autoCheckOutIfExceeded()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('checkOutDay mit Pausen', () => {
  it('schneidet eine Pause aus einem Projekt-Eintrag heraus (Split) und zählt sie separat statt als Projektzeit', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const day = await checkInWorkDay();
    await addTimeEntry(report.id, { date: todayISODate(), startTime: '08:00', endTime: '16:00', workDayId: day.id }); // 480 Min.

    const summary = await checkOutDay([{ startTime: '12:00', endTime: '12:30' }]);

    expect(summary?.breakMinutes).toBe(30);
    expect(summary?.projectMinutes).toBe(450);
    expect(summary?.totalMinutes).toBe(450);

    const updatedReport = await getReport(report.id);
    expect(updatedReport?.totalDurationMinutes).toBe(450);

    // Ursprünglicher Eintrag wurde gesplittet: 08:00-12:00 und 12:30-16:00.
    const entries = await listTimeEntries(report.id);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => [e.startTime, e.endTime]).sort()).toEqual([
      ['08:00', '12:00'],
      ['12:30', '16:00']
    ]);
  });

  it('summiert mehrere Pausen an einem Tag', async () => {
    const day = await checkInWorkDay();
    await addTimeEntry(undefined, { date: todayISODate(), startTime: '08:00', endTime: '16:00', workDayId: day.id });

    const summary = await checkOutDay([
      { startTime: '10:00', endTime: '10:15' },
      { startTime: '12:00', endTime: '12:30' }
    ]);

    expect(summary?.breakMinutes).toBe(45);
    expect(summary?.idleMinutes).toBe(480 - 45);
    expect(summary?.totalMinutes).toBe(480 - 45);
  });

  it('ignoriert unvollständige Pausen-Zeilen (fehlende Start- oder Endzeit)', async () => {
    const day = await checkInWorkDay();
    await addTimeEntry(undefined, { date: todayISODate(), startTime: '08:00', endTime: '16:00', workDayId: day.id });

    const summary = await checkOutDay([{ startTime: '12:00', endTime: '' }]);

    expect(summary?.breakMinutes).toBe(0);
    expect(summary?.totalMinutes).toBe(480);
  });

  it('legt für jede Pause einen eigenen isBreak-Eintrag an, der nicht als Leerlaufzeit zur Zuordnung auftaucht', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const day = await checkInWorkDay();
    await addTimeEntry(report.id, { date: todayISODate(), startTime: '08:00', endTime: '16:00', workDayId: day.id });

    await checkOutDay([{ startTime: '12:00', endTime: '12:30' }]);

    const all = await listTimeEntriesForWorkDay(day.id);
    const breakEntry = all.find((e) => e.isBreak);
    expect(breakEntry).toBeTruthy();
    expect(breakEntry?.startTime).toBe('12:00');
    expect(breakEntry?.endTime).toBe('12:30');
    expect(breakEntry?.durationMinutes).toBe(30);
    expect(breakEntry?.reportId).toBeUndefined();

    // Der Pause-Eintrag selbst hat zwar keine reportId (wie Leerlaufzeit),
    // taucht aber trotzdem NICHT in der Zuordnungs-Liste auf.
    const unassigned = await listUnassignedIdleEntries();
    expect(unassigned.find((e) => e.id === breakEntry?.id)).toBeUndefined();
  });

  it('ohne Pausen-Angabe ändert sich am bisherigen Verhalten nichts (breakMinutes 0)', async () => {
    const day = await checkInWorkDay();
    await addTimeEntry(undefined, { date: todayISODate(), startTime: '08:00', endTime: '08:30', workDayId: day.id });

    const summary = await checkOutDay();

    expect(summary?.breakMinutes).toBe(0);
    expect(summary?.totalMinutes).toBe(30);
  });
});

describe('restoreBreak (Pause rückgängig machen)', () => {
  it('stellt einen gesplitteten Eintrag wieder als einen einzigen her', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const day = await checkInWorkDay();
    await addTimeEntry(report.id, { date: todayISODate(), startTime: '08:00', endTime: '16:00', workDayId: day.id });

    await checkOutDay([{ startTime: '12:00', endTime: '12:30' }]);
    const breakEntry = (await listTimeEntriesForWorkDay(day.id)).find((e) => e.isBreak)!;

    await restoreBreak(breakEntry.id);

    const entries = await listTimeEntries(report.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].startTime).toBe('08:00');
    expect(entries[0].endTime).toBe('16:00');
    expect(entries[0].durationMinutes).toBe(480);

    const updatedReport = await getReport(report.id);
    expect(updatedReport?.totalDurationMinutes).toBe(480);
    expect((await listTimeEntriesForWorkDay(day.id)).find((e) => e.isBreak)).toBeUndefined();
  });

  it('stellt einen am Anfang gekürzten Eintrag wieder her (Pause direkt am Start)', async () => {
    const day = await checkInWorkDay();
    await addTimeEntry(undefined, { date: todayISODate(), startTime: '08:00', endTime: '16:00', workDayId: day.id });

    await checkOutDay([{ startTime: '08:00', endTime: '08:30' }]);
    const breakEntry = (await listTimeEntriesForWorkDay(day.id)).find((e) => e.isBreak)!;

    await restoreBreak(breakEntry.id);

    const idleEntries = (await listTimeEntriesForWorkDay(day.id)).filter((e) => !e.isBreak);
    expect(idleEntries).toHaveLength(1);
    expect(idleEntries[0].startTime).toBe('08:00');
    expect(idleEntries[0].endTime).toBe('16:00');
  });

  it('legt einen komplett innerhalb der Pause liegenden (dabei gelöschten) Eintrag neu an', async () => {
    const day = await checkInWorkDay();
    await addTimeEntry(undefined, { date: todayISODate(), startTime: '12:00', endTime: '12:15', workDayId: day.id }); // ganz in der Pause

    await checkOutDay([{ startTime: '11:00', endTime: '13:00' }]);
    const all = await listTimeEntriesForWorkDay(day.id);
    const breakEntry = all.find((e) => e.isBreak)!;
    // Der ursprüngliche 12:00-12:15-Eintrag wurde beim Anlegen der Pause komplett gelöscht.
    expect(all.filter((e) => !e.isBreak)).toHaveLength(0);

    await restoreBreak(breakEntry.id);

    const remaining = (await listTimeEntriesForWorkDay(day.id)).filter((e) => !e.isBreak);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].startTime).toBe('12:00');
    expect(remaining[0].endTime).toBe('12:15');
  });

  it('betrifft nur die Nachbarn der gelöschten Pause, nicht andere Pausen am selben Tag', async () => {
    const day = await checkInWorkDay();
    await addTimeEntry(undefined, { date: todayISODate(), startTime: '08:00', endTime: '16:00', workDayId: day.id });

    await checkOutDay([
      { startTime: '10:00', endTime: '10:15' },
      { startTime: '12:00', endTime: '12:30' }
    ]);
    const breaks = (await listTimeEntriesForWorkDay(day.id)).filter((e) => e.isBreak);
    expect(breaks).toHaveLength(2);

    const firstBreak = breaks.find((b) => b.startTime === '10:00')!;
    await restoreBreak(firstBreak.id);

    const remainingBreaks = (await listTimeEntriesForWorkDay(day.id)).filter((e) => e.isBreak);
    expect(remainingBreaks).toHaveLength(1);
    expect(remainingBreaks[0].startTime).toBe('12:00');
  });

  it('überspringt Wiederherstellungsschritte für zwischenzeitlich anders gelöschte Nachbar-Einträge, statt abzubrechen', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const day = await checkInWorkDay();
    await addTimeEntry(report.id, { date: todayISODate(), startTime: '08:00', endTime: '16:00', workDayId: day.id });

    await checkOutDay([{ startTime: '12:00', endTime: '12:30' }]);
    const breakEntry = (await listTimeEntriesForWorkDay(day.id)).find((e) => e.isBreak)!;
    const [firstHalf] = await listTimeEntries(report.id); // 08:00-12:00, erster von zwei gesplitteten Teilen

    // Nutzer löscht manuell einen der beiden Trim-Nachbarn, bevor die Pause rückgängig gemacht wird.
    await deleteTimeEntry(firstHalf.id);

    await expect(restoreBreak(breakEntry.id)).resolves.not.toThrow();
    expect((await listTimeEntriesForWorkDay(day.id)).find((e) => e.isBreak)).toBeUndefined();
  });

  it('hat keinen Effekt auf einen Eintrag, der keine Pause ist', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const entry = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '09:00' });

    await restoreBreak(entry.id);

    expect(await listTimeEntries(report.id)).toHaveLength(1);
  });
});

describe('addManualBreak (manuelles Nachtragen einer Pause, z.B. in der Auswertung)', () => {
  it('schneidet eine Pause aus einem bestehenden Eintrag an einem beliebigen Tag heraus, ganz ohne aktiven Tagesstempel', async () => {
    const report = await createReport({ projectNumber: 'A' });
    await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '16:00' });

    await addManualBreak('2026-08-10', '12:00', '12:30');

    const entries = await listTimeEntries(report.id);
    expect(entries).toHaveLength(2);
    const total = entries.reduce((sum, e) => sum + (e.durationMinutes ?? 0), 0);
    expect(total).toBe(450); // 480 Minuten abzüglich 30 Minuten Pause

    const breaks = await getDayBreaks('2026-08-10');
    expect(breaks).toHaveLength(1);
    expect(breaks[0].minutes).toBe(30);
  });

  it('legt den Pause-Eintrag ohne workDayId an, wenn keins übergeben wird - trotzdem über das Datum auffindbar', async () => {
    await addTimeEntry(undefined, { date: '2026-08-10', startTime: '08:00', endTime: '16:00' });

    await addManualBreak('2026-08-10', '12:00', '12:30');

    const breaks = await getDayBreaks('2026-08-10');
    expect(breaks).toHaveLength(1);
  });

  it('kann per restoreBreak() wieder rückgängig gemacht werden - trimRecords werden auch beim manuellen Pfad korrekt gefüllt', async () => {
    const report = await createReport({ projectNumber: 'A' });
    await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '16:00' });

    await addManualBreak('2026-08-10', '12:00', '12:30');
    const breakEntry = (await getDayBreaks('2026-08-10'))[0];

    await restoreBreak(breakEntry.id);

    const entries = await listTimeEntries(report.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].startTime).toBe('08:00');
    expect(entries[0].endTime).toBe('16:00');
    expect(await getDayBreaks('2026-08-10')).toEqual([]);
  });

  it('hat keinen Effekt, wenn Start- oder Endzeit fehlt', async () => {
    const report = await createReport({ projectNumber: 'A' });
    await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '16:00' });

    await addManualBreak('2026-08-10', '', '12:30');
    await addManualBreak('2026-08-10', '12:00', '');

    expect(await listTimeEntries(report.id)).toHaveLength(1);
    expect(await getDayBreaks('2026-08-10')).toEqual([]);
  });
});

describe('addManualIdleTime (manuelles Nachtragen von Leerlaufzeit, z.B. bei vergessenem Ein-/Ausstempeln)', () => {
  it('legt für einen beliebigen Tag einen Leerlaufzeit-Eintrag an, ganz ohne aktiven Tagesstempel', async () => {
    await addManualIdleTime('2026-08-10', '08:00', '10:00');

    const entries = await getDayIdleEntries('2026-08-10');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ startTime: '08:00', endTime: '10:00', minutes: 120 });
  });

  it('taucht danach wie jede andere Leerlaufzeit in listUnassignedIdleEntries auf und lässt sich zuordnen', async () => {
    const report = await createReport({ projectNumber: 'A' });
    await addManualIdleTime('2026-08-10', '08:00', '10:00');

    const [unassigned] = await listUnassignedIdleEntries();
    expect(unassigned).toBeDefined();

    await reassignIdleEntry(unassigned.id, report.id);

    expect(await getDayIdleEntries('2026-08-10')).toEqual([]);
    const updated = await getReport(report.id);
    expect(updated?.totalDurationMinutes).toBe(120);
  });

  it('schneidet eine versehentlich überschneidende Projektzeit vorher heraus, statt sie doppelt zu zählen', async () => {
    const report = await createReport({ projectNumber: 'A' });
    await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '12:00' });

    await addManualIdleTime('2026-08-10', '10:00', '11:00');

    const reportEntries = await listTimeEntries(report.id);
    // Die 08:00-12:00 Projektzeit wurde um das überschneidende 10:00-11:00-Fenster gesplittet.
    expect(reportEntries.map((e) => [e.startTime, e.endTime]).sort()).toEqual([
      ['08:00', '10:00'],
      ['11:00', '12:00']
    ]);
    const idle = await getDayIdleEntries('2026-08-10');
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ startTime: '10:00', endTime: '11:00', minutes: 60 });
  });

  it('hat keinen Effekt, wenn Start- oder Endzeit fehlt', async () => {
    await addManualIdleTime('2026-08-10', '', '12:30');
    await addManualIdleTime('2026-08-10', '12:00', '');

    expect(await getDayIdleEntries('2026-08-10')).toEqual([]);
  });
});

describe('addManualProjectTime (Projektzeit direkt aus der Auswertung nachtragen, ohne den Bericht zu öffnen)', () => {
  it('legt für einen beliebigen Tag eine Projekt-Zeit an, ganz ohne aktiven Tagesstempel', async () => {
    const report = await createReport({ projectNumber: 'A' });

    await addManualProjectTime(report.id, '2026-08-10', '08:00', '17:00');

    const entries = await listTimeEntries(report.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ date: '2026-08-10', startTime: '08:00', endTime: '17:00' });
    const updated = await getReport(report.id);
    expect(updated?.totalDurationMinutes).toBe(540);
  });

  it('schneidet eine versehentlich überschneidende Leerlaufzeit vorher heraus, statt sie doppelt zu zählen', async () => {
    const report = await createReport({ projectNumber: 'A' });
    await addManualIdleTime('2026-08-10', '08:00', '12:00');

    await addManualProjectTime(report.id, '2026-08-10', '10:00', '17:00');

    const idle = await getDayIdleEntries('2026-08-10');
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ startTime: '08:00', endTime: '10:00' });
    const reportEntries = await listTimeEntries(report.id);
    expect(reportEntries).toHaveLength(1);
    expect(reportEntries[0]).toMatchObject({ startTime: '10:00', endTime: '17:00' });
  });

  it('schneidet bei angegebener Pausendauer eine mittig liegende Pause heraus', async () => {
    const report = await createReport({ projectNumber: 'A' });

    await addManualProjectTime(report.id, '2026-08-10', '08:00', '17:00', 30);

    const reportEntries = await listTimeEntries(report.id);
    // 9 Std. Gesamtzeitraum, 30 Min. Pause mittig -> gesplittet in zwei Teile.
    expect(reportEntries.map((e) => [e.startTime, e.endTime]).sort()).toEqual([
      ['08:00', '12:15'],
      ['12:45', '17:00']
    ]);
    const breaks = await getDayBreaks('2026-08-10');
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({ startTime: '12:15', endTime: '12:45', minutes: 30 });
  });

  it('hat keinen Effekt, wenn Start- oder Endzeit fehlt', async () => {
    const report = await createReport({ projectNumber: 'A' });

    await addManualProjectTime(report.id, '2026-08-10', '', '12:30');
    await addManualProjectTime(report.id, '2026-08-10', '12:00', '');

    expect(await listTimeEntries(report.id)).toEqual([]);
  });
});

describe('updateManualIdleTime (Bearbeiten eines Leerlaufzeit-Eintrags in der Auswertung)', () => {
  it('aktualisiert die Uhrzeiten eines bestehenden Leerlaufzeit-Eintrags, der neue Zeitraum überschneidet den alten vollständig -> keine zusätzliche Lücke', async () => {
    await addManualIdleTime('2026-08-10', '08:00', '10:00');
    const [entry] = await getDayIdleEntries('2026-08-10');

    await updateManualIdleTime(
      { id: entry.id, date: '2026-08-10', startTime: entry.startTime, endTime: entry.endTime },
      '2026-08-10',
      '07:00',
      '11:00'
    );

    const entries = await getDayIdleEntries('2026-08-10');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ startTime: '07:00', endTime: '11:00', minutes: 240 });
  });

  it('legt beim Verkleinern die freiwerdende Zeit als eigenen (zweiten) Leerlaufzeit-Eintrag an', async () => {
    await addManualIdleTime('2026-08-10', '08:00', '10:00');
    const [entry] = await getDayIdleEntries('2026-08-10');

    await updateManualIdleTime(
      { id: entry.id, date: '2026-08-10', startTime: entry.startTime, endTime: entry.endTime },
      '2026-08-10',
      '09:00',
      '10:00'
    );

    const entries = await getDayIdleEntries('2026-08-10');
    const ranges = entries.map((e) => `${e.startTime}-${e.endTime}`).sort();
    expect(ranges).toEqual(['08:00-09:00', '09:00-10:00']);
  });

  it('schneidet eine versehentlich überschneidende Projektzeit heraus, ohne sich selbst als Überschneidung zu zählen', async () => {
    const report = await createReport({ projectNumber: 'A' });
    await addTimeEntry(report.id, { date: '2026-08-10', startTime: '12:00', endTime: '13:00' });
    await addManualIdleTime('2026-08-10', '08:00', '10:00');
    const [entry] = await getDayIdleEntries('2026-08-10');

    // Verschiebt den Leerlaufzeit-Eintrag so, dass er die Projektzeit überschneidet -
    // der alte Zeitraum (08:00-10:00) überschneidet sich mit dem neuen (11:30-12:30)
    // gar nicht, bleibt also nach demselben Prinzip wie beim Verkleinern als eigener
    // Leerlaufzeit-Eintrag erhalten (siehe updateManualTimeEntry()/subtractTimeRange()).
    await updateManualIdleTime(
      { id: entry.id, date: '2026-08-10', startTime: entry.startTime, endTime: entry.endTime },
      '2026-08-10',
      '11:30',
      '12:30'
    );

    const reportEntries = await listTimeEntries(report.id);
    expect(reportEntries).toHaveLength(1);
    expect(reportEntries[0]).toMatchObject({ startTime: '12:30', endTime: '13:00' });
    const idle = await getDayIdleEntries('2026-08-10');
    expect(idle.map((e) => [e.startTime, e.endTime]).sort()).toEqual([
      ['08:00', '10:00'],
      ['11:30', '12:30']
    ]);
  });

  it('hat keinen Effekt, wenn Start- oder Endzeit fehlt', async () => {
    await addManualIdleTime('2026-08-10', '08:00', '10:00');
    const [entry] = await getDayIdleEntries('2026-08-10');

    await updateManualIdleTime({ id: entry.id, date: '2026-08-10', startTime: entry.startTime, endTime: entry.endTime }, '2026-08-10', '', '11:00');

    expect(await getDayIdleEntries('2026-08-10')).toEqual([{ id: entry.id, startTime: '08:00', endTime: '10:00', minutes: 120 }]);
  });
});

describe('reassignIdleEntry', () => {
  it('ordnet einen Leerlaufzeit-Eintrag einem Bericht zu und aktualisiert dessen Summary', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const day = await checkInWorkDay();
    const entry = await addTimeEntry(undefined, {
      date: todayISODate(),
      startTime: '08:00',
      endTime: '09:00',
      workDayId: day.id
    });

    await reassignIdleEntry(entry.id, report.id);

    const updated = await getReport(report.id);
    expect(updated?.timeEntryCount).toBe(1);
    expect(updated?.totalDurationMinutes).toBe(60);
    expect(await listUnassignedIdleEntries()).toEqual([]);
  });
});

describe('assignIdleTime (Leerlaufzeit in der Auswertung/Tag-Ansicht einem Projekt zuordnen)', () => {
  it('ordnet die KOMPLETTE Leerlaufzeit einem Bericht zu, wenn das Zeitfenster dem bisherigen Zeitraum entspricht (keine Lücke)', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const day = await checkInWorkDay();
    const entry = await addTimeEntry(undefined, { date: '2026-08-10', startTime: '08:00', endTime: '11:00', workDayId: day.id });

    await assignIdleTime(entry, report.id, '08:00', '11:00');

    const reportEntries = await listTimeEntries(report.id);
    expect(reportEntries).toHaveLength(1);
    expect(reportEntries[0]).toMatchObject({ id: entry.id, startTime: '08:00', endTime: '11:00' });
    const updated = await getReport(report.id);
    expect(updated?.totalDurationMinutes).toBe(180);
    expect(await getDayIdleEntries('2026-08-10')).toEqual([]);
  });

  it('ordnet nur ein Zeitfenster MITTEN in der Leerlaufzeit zu - davor und danach bleibt Leerlaufzeit erhalten', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const entry = await addTimeEntry(undefined, { date: '2026-08-10', startTime: '08:00', endTime: '11:00' });

    await assignIdleTime(entry, report.id, '09:00', '09:45');

    const reportEntries = await listTimeEntries(report.id);
    expect(reportEntries).toHaveLength(1);
    expect(reportEntries[0]).toMatchObject({ id: entry.id, startTime: '09:00', endTime: '09:45' });
    const updated = await getReport(report.id);
    expect(updated?.totalDurationMinutes).toBe(45);

    const idle = await getDayIdleEntries('2026-08-10');
    expect(idle.map((e) => [e.startTime, e.endTime]).sort()).toEqual([
      ['08:00', '09:00'],
      ['09:45', '11:00']
    ]);
  });

  it('ordnet ein Zeitfenster am ANFANG zu - nur eine Lücke danach bleibt als Leerlaufzeit', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const entry = await addTimeEntry(undefined, { date: '2026-08-10', startTime: '08:00', endTime: '11:00' });

    await assignIdleTime(entry, report.id, '08:00', '09:00');

    const idle = await getDayIdleEntries('2026-08-10');
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ startTime: '09:00', endTime: '11:00' });
  });

  it('ordnet ein Zeitfenster am ENDE zu - nur eine Lücke davor bleibt als Leerlaufzeit', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const entry = await addTimeEntry(undefined, { date: '2026-08-10', startTime: '08:00', endTime: '11:00' });

    await assignIdleTime(entry, report.id, '10:00', '11:00');

    const idle = await getDayIdleEntries('2026-08-10');
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ startTime: '08:00', endTime: '10:00' });
  });

  it('übernimmt die workDayId des Ursprungseintrags für die verbleibende(n) Lücke(n) - zählt weiter zur "Heute bisher"-Tagesbilanz', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const day = await checkInWorkDay();
    const entry = await addTimeEntry(undefined, { date: '2026-08-10', startTime: '08:00', endTime: '11:00', workDayId: day.id });

    await assignIdleTime(entry, report.id, '09:00', '09:45');

    const remaining = await listTimeEntriesForWorkDay(day.id);
    // Der zugeordnete Projekt-Abschnitt (09:00-09:45) plus die zwei Lücken (08:00-09:00, 09:45-11:00),
    // alle mit derselben workDayId - keine Lücke ist "vom Tagesstempel abgekoppelt".
    expect(remaining).toHaveLength(3);
  });

  it('hat keinen Effekt, wenn der Ursprungseintrag oder das Zeitfenster unvollständig ist', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const entry = await addTimeEntry(undefined, { date: '2026-08-10', startTime: '08:00', endTime: '11:00' });

    await assignIdleTime({ ...entry, startTime: undefined }, report.id, '08:00', '09:00');
    await assignIdleTime(entry, report.id, '', '09:00');

    expect(await listTimeEntries(report.id)).toEqual([]);
    expect(await getDayIdleEntries('2026-08-10')).toHaveLength(1);
  });
});

describe('updateManualTimeEntry (manuelles Bearbeiten eines Zeiteintrags im Zeiten-Tab)', () => {
  it('legt für die von vorne weggekürzte Zeit einen Leerlaufzeit-Eintrag an', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const original = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '16:00' });

    await updateManualTimeEntry(original, { date: '2026-08-10', startTime: '10:00', endTime: '16:00', note: '' });

    const reportEntries = await listTimeEntries(report.id);
    expect(reportEntries).toHaveLength(1);
    expect(reportEntries[0]).toMatchObject({ startTime: '10:00', endTime: '16:00' });

    const idle = await listUnassignedIdleEntries();
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ date: '2026-08-10', startTime: '08:00', endTime: '10:00', reportId: undefined });
  });

  it('legt für die von beiden Seiten weggekürzte Zeit zwei Leerlaufzeit-Einträge an', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const original = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '16:00' });

    await updateManualTimeEntry(original, { date: '2026-08-10', startTime: '10:00', endTime: '14:00', note: '' });

    const idle = await listUnassignedIdleEntries();
    expect(idle).toHaveLength(2);
    const ranges = idle.map((e) => `${e.startTime}-${e.endTime}`).sort();
    expect(ranges).toEqual(['08:00-10:00', '14:00-16:00']);
  });

  it('legt keinen Leerlaufzeit-Eintrag an, wenn die Zeit nur erweitert wird', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const original = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '12:00' });

    await updateManualTimeEntry(original, { date: '2026-08-10', startTime: '07:00', endTime: '13:00', note: '' });

    expect(await listUnassignedIdleEntries()).toEqual([]);
    const reportEntries = await listTimeEntries(report.id);
    expect(reportEntries[0]).toMatchObject({ startTime: '07:00', endTime: '13:00' });
  });

  it('legt keinen Leerlaufzeit-Eintrag an, wenn ein noch offener Eintrag erstmals eine Endzeit bekommt', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const original = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00' });

    await updateManualTimeEntry(original, { date: '2026-08-10', startTime: '08:00', endTime: '16:00', note: '' });

    expect(await listUnassignedIdleEntries()).toEqual([]);
  });

  it('legt keinen Leerlaufzeit-Eintrag an, wenn der Eintrag dabei auf einen anderen Tag verschoben wird', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const original = await addTimeEntry(report.id, { date: '2026-08-10', startTime: '08:00', endTime: '16:00' });

    await updateManualTimeEntry(original, { date: '2026-08-11', startTime: '08:00', endTime: '10:00', note: '' });

    expect(await listUnassignedIdleEntries()).toEqual([]);
    const reportEntries = await listTimeEntries(report.id);
    expect(reportEntries[0]).toMatchObject({ date: '2026-08-11', startTime: '08:00', endTime: '10:00' });
  });
});

describe('startProjectByNumber', () => {
  it('legt einen neuen Bericht an, wenn es diese Projektnummer noch nicht gibt', async () => {
    const result = await startProjectByNumber('555555');

    expect(result.reused).toBe(false);
    expect(result.visitNumber).toBe(1);
    expect(result.visitTotal).toBe(1);
    expect(result.report.projectNumber).toBe('555555');
  });

  it('verwendet einen bereits offenen Bericht mit derselben Projektnummer wieder, statt ein Duplikat anzulegen', async () => {
    const open = await createReport({ projectNumber: '555555' });

    const result = await startProjectByNumber('555555');

    expect(result.reused).toBe(true);
    expect(result.report.id).toBe(open.id);
    const all = await listReports('all');
    expect(all.filter((r) => r.projectNumber === '555555')).toHaveLength(1);
  });

  it('legt einen weiteren Bericht an (mit korrekter Besuchsnummer), wenn der bisherige Bericht zu dieser Projektnummer bereits gesperrt ist', async () => {
    const first = await createReport({ projectNumber: '555555' });
    await finalizeReport(first.id);

    const result = await startProjectByNumber('555555');

    expect(result.reused).toBe(false);
    expect(result.report.id).not.toBe(first.id);
    expect(result.visitNumber).toBe(2);
    expect(result.visitTotal).toBe(2);
  });

  it('trimmt die eingegebene Projektnummer', async () => {
    const result = await startProjectByNumber('  555555  ');

    expect(result.report.projectNumber).toBe('555555');
  });

  it('übernimmt den Techniker-Namen beim Neuanlegen', async () => {
    const result = await startProjectByNumber('555555', 'Daniel');

    expect(result.report.technicianName).toBe('Daniel');
  });
});
