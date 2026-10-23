import { describe, expect, it } from 'vitest';
import {
  appendPerformedWorkLine,
  formatTimeEntryPerformedWorkLine,
  shouldAppendPerformedWorkLine
} from '../../lib/utils/performedWorkNote';

describe('shouldAppendPerformedWorkLine', () => {
  it('hängt an, wenn eine bisher leere Notiz erstmalig ausgefüllt wird (neuer Eintrag)', () => {
    expect(shouldAppendPerformedWorkLine(undefined, 'Sicherung ersetzt')).toBe(true);
  });

  it('hängt an, wenn eine bestehende, bisher leere Notiz erstmalig ausgefüllt wird', () => {
    expect(shouldAppendPerformedWorkLine('', 'Sicherung ersetzt')).toBe(true);
  });

  it('hängt NICHT an, wenn eine bereits gesetzte Notiz lediglich geändert wird (z.B. Tippfehler-Korrektur)', () => {
    expect(shouldAppendPerformedWorkLine('Sicherung ersetzt', 'Sicherung ersetzt (korrigiert)')).toBe(false);
  });

  it('hängt NICHT an, wenn die Notiz unverändert bleibt', () => {
    expect(shouldAppendPerformedWorkLine('Sicherung ersetzt', 'Sicherung ersetzt')).toBe(false);
  });

  it('hängt NICHT an, wenn die neue Notiz leer ist (Notiz wird gelöscht statt ausgefüllt)', () => {
    expect(shouldAppendPerformedWorkLine('Sicherung ersetzt', '')).toBe(false);
    expect(shouldAppendPerformedWorkLine(undefined, '')).toBe(false);
    expect(shouldAppendPerformedWorkLine(undefined, '   ')).toBe(false);
  });
});

describe('formatTimeEntryPerformedWorkLine', () => {
  it('formatiert Datum, Zeitspanne und Notiz-Text', () => {
    const line = formatTimeEntryPerformedWorkLine({ date: '2026-08-10', startTime: '08:00', endTime: '12:00' }, 'Sicherung ersetzt');
    expect(line).toBe('10.08.2026, 08:00–12:00: Sicherung ersetzt');
  });

  it('lässt die Zeitspanne weg, wenn Start/Ende fehlen', () => {
    const line = formatTimeEntryPerformedWorkLine({ date: '2026-08-10' }, 'Sicherung ersetzt');
    expect(line).toBe('10.08.2026: Sicherung ersetzt');
  });
});

describe('appendPerformedWorkLine', () => {
  it('befüllt ein vorher leeres Feld einfach mit der einen Zeile', () => {
    expect(appendPerformedWorkLine(undefined, '10.08.2026, 08:00–12:00: Sicherung ersetzt')).toBe(
      '10.08.2026, 08:00–12:00: Sicherung ersetzt'
    );
  });

  it('hängt an einen bestehenden Text eine neue Zeile an, statt ihn zu ersetzen', () => {
    const result = appendPerformedWorkLine('Zählerschrank geprüft.', '10.08.2026, 08:00–12:00: Sicherung ersetzt');
    expect(result).toBe('Zählerschrank geprüft.\n10.08.2026, 08:00–12:00: Sicherung ersetzt');
  });

  it('mehrere Zeiteintrag-Notizen landen in der richtigen Reihenfolge untereinander', () => {
    let performedWork: string | undefined;
    performedWork = appendPerformedWorkLine(performedWork, '09.08.2026, 08:00–12:00: Erste Notiz');
    performedWork = appendPerformedWorkLine(performedWork, '10.08.2026, 08:00–12:00: Zweite Notiz');
    performedWork = appendPerformedWorkLine(performedWork, '11.08.2026, 08:00–12:00: Dritte Notiz');
    expect(performedWork).toBe(
      '09.08.2026, 08:00–12:00: Erste Notiz\n10.08.2026, 08:00–12:00: Zweite Notiz\n11.08.2026, 08:00–12:00: Dritte Notiz'
    );
  });
});
