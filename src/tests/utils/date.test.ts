import { describe, expect, it } from 'vitest';
import {
  addMinutesToTime,
  centeredBreakWindow,
  computeDurationMinutes,
  formatDateDE,
  formatDurationMinutes,
  nowHHmm,
  startOfWeekISO,
  subtractTimeRange,
  todayISODate
} from '../../lib/utils/date';

describe('computeDurationMinutes', () => {
  it('berechnet die Differenz in Minuten', () => {
    expect(computeDurationMinutes('08:00', '16:30')).toBe(510);
  });

  it('interpretiert eine Endzeit vor der Startzeit als Zeitspanne über Mitternacht', () => {
    // 19:05 bis 12:16 (nächster Tag) - z.B. vergessenes Auschecken über Nacht
    expect(computeDurationMinutes('19:05', '12:16')).toBe(17 * 60 + 11);
    expect(computeDurationMinutes('16:00', '08:00')).toBe(16 * 60);
  });

  it('liefert 0 bei identischer Start-/Endzeit', () => {
    expect(computeDurationMinutes('08:00', '08:00')).toBe(0);
  });

  it('liefert undefined bei ungültigem Format', () => {
    expect(computeDurationMinutes('8h', '10:00')).toBeUndefined();
  });
});

describe('formatDurationMinutes', () => {
  it('formatiert Stunden und Minuten mit führender Null', () => {
    expect(formatDurationMinutes(90)).toBe('1:30 Std.');
    expect(formatDurationMinutes(5)).toBe('0:05 Std.');
  });

  it('behandelt fehlende/negative Werte als 0', () => {
    expect(formatDurationMinutes(undefined)).toBe('0:00 Std.');
    expect(formatDurationMinutes(-10)).toBe('0:00 Std.');
  });
});

describe('formatDateDE', () => {
  it('wandelt ISO-Datum in deutsches Format um', () => {
    expect(formatDateDE('2026-08-10')).toBe('10.08.2026');
  });
});

describe('todayISODate', () => {
  it('liefert das heutige Datum im lokalen "YYYY-MM-DD"-Format', () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(todayISODate()).toBe(expected);
  });
});

describe('nowHHmm', () => {
  it('liefert die aktuelle Uhrzeit im Format "HH:mm"', () => {
    expect(nowHHmm()).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('addMinutesToTime', () => {
  it('addiert Minuten innerhalb desselben Tages', () => {
    expect(addMinutesToTime('08:00', 90)).toBe('09:30');
    expect(addMinutesToTime('06:00', 600)).toBe('16:00');
  });

  it('wraps über Mitternacht (Modulo 24h)', () => {
    expect(addMinutesToTime('22:00', 600)).toBe('08:00');
    expect(addMinutesToTime('23:30', 60)).toBe('00:30');
  });

  it('liefert die Eingabe unverändert bei ungültigem Format', () => {
    expect(addMinutesToTime('nicht-valide', 60)).toBe('nicht-valide');
  });
});

describe('startOfWeekISO', () => {
  it('liefert für einen Mittwoch den Montag derselben Woche', () => {
    // 2026-08-12 ist ein Mittwoch.
    expect(startOfWeekISO('2026-08-12')).toBe('2026-08-10');
  });

  it('liefert für einen Montag denselben Tag', () => {
    expect(startOfWeekISO('2026-08-10')).toBe('2026-08-10');
  });

  it('liefert für einen Sonntag den Montag DAVOR (nicht denselben Tag)', () => {
    // 2026-08-16 ist ein Sonntag - gehört noch zur Woche, die am 2026-08-10 (Montag) begann.
    expect(startOfWeekISO('2026-08-16')).toBe('2026-08-10');
  });

  it('rechnet über einen Monatswechsel hinweg korrekt', () => {
    // 2026-09-01 ist ein Dienstag, die Woche begann am 2026-08-31 (Montag).
    expect(startOfWeekISO('2026-09-01')).toBe('2026-08-31');
  });
});

describe('subtractTimeRange', () => {
  it('liefert einen Bereich am Ende, wenn der neue Zeitraum von vorne verkürzt wurde', () => {
    // alt: 08:00-16:00, neu: 10:00-16:00 -> freigeworden: 08:00-10:00
    expect(subtractTimeRange({ start: '08:00', end: '16:00' }, { start: '10:00', end: '16:00' })).toEqual([
      { start: '08:00', end: '10:00' }
    ]);
  });

  it('liefert einen Bereich am Anfang, wenn der neue Zeitraum von hinten verkürzt wurde', () => {
    // alt: 08:00-16:00, neu: 08:00-14:00 -> freigeworden: 14:00-16:00
    expect(subtractTimeRange({ start: '08:00', end: '16:00' }, { start: '08:00', end: '14:00' })).toEqual([
      { start: '14:00', end: '16:00' }
    ]);
  });

  it('liefert zwei Bereiche, wenn von beiden Seiten verkürzt wurde', () => {
    // alt: 08:00-16:00, neu: 10:00-14:00 -> freigeworden: 08:00-10:00 und 14:00-16:00
    expect(subtractTimeRange({ start: '08:00', end: '16:00' }, { start: '10:00', end: '14:00' })).toEqual([
      { start: '08:00', end: '10:00' },
      { start: '14:00', end: '16:00' }
    ]);
  });

  it('liefert einen Bereich, wenn der Zeitraum verschoben statt nur verkleinert wurde', () => {
    // alt: 08:00-12:00, neu: 10:00-12:00 -> freigeworden: 08:00-10:00 (Überlappung 10:00-12:00 entfällt)
    expect(subtractTimeRange({ start: '08:00', end: '12:00' }, { start: '10:00', end: '13:00' })).toEqual([
      { start: '08:00', end: '10:00' }
    ]);
  });

  it('liefert eine leere Liste, wenn der neue Zeitraum den alten vollständig abdeckt (Erweiterung)', () => {
    expect(subtractTimeRange({ start: '08:00', end: '12:00' }, { start: '07:00', end: '13:00' })).toEqual([]);
    expect(subtractTimeRange({ start: '08:00', end: '12:00' }, { start: '08:00', end: '12:00' })).toEqual([]);
  });

  it('liefert den unveränderten alten Bereich, wenn der neue Bereich komplett außerhalb liegt', () => {
    expect(subtractTimeRange({ start: '08:00', end: '10:00' }, { start: '14:00', end: '16:00' })).toEqual([
      { start: '08:00', end: '10:00' }
    ]);
  });

  it('liefert eine leere Liste bei ungültigem Format', () => {
    expect(subtractTimeRange({ start: 'x', end: '16:00' }, { start: '10:00', end: '14:00' })).toEqual([]);
  });
});

describe('centeredBreakWindow', () => {
  it('legt die Pause mittig in den Zeitraum', () => {
    // 9 Std. Gesamtzeitraum, 30 Min. Pause -> 4:15 Std. Versatz von beiden Enden.
    expect(centeredBreakWindow('08:00', '17:00', 30)).toEqual({ start: '12:15', end: '12:45' });
  });

  it('rundet einen ungeraden Versatz ab (floor)', () => {
    // 9:01 Std. Gesamtzeitraum, 30 Min. Pause -> Versatz 4:15,5 -> abgerundet auf 4:15.
    expect(centeredBreakWindow('08:00', '17:01', 30)).toEqual({ start: '12:15', end: '12:45' });
  });

  it('liefert undefined, wenn die Pause genauso lang oder länger als der Zeitraum ist', () => {
    expect(centeredBreakWindow('08:00', '08:30', 30)).toBeUndefined();
    expect(centeredBreakWindow('08:00', '08:20', 30)).toBeUndefined();
  });

  it('liefert undefined bei einer Dauer von 0 oder weniger', () => {
    expect(centeredBreakWindow('08:00', '17:00', 0)).toBeUndefined();
    expect(centeredBreakWindow('08:00', '17:00', -10)).toBeUndefined();
  });

  it('liefert undefined bei ungültigem Zeitformat', () => {
    expect(centeredBreakWindow('x', '17:00', 30)).toBeUndefined();
  });
});
