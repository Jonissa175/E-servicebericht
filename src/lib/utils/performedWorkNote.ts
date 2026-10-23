import { formatDateDE } from './date';

/**
 * Entscheidet, ob eine Zeiteintrag-Notiz ("Durchgeführte Arbeiten" im
 * Zeiteintrag-Formular, s. TimeEntrySection.svelte) automatisch als neue
 * Zeile ans Ende von `ServiceReport.performedWork` angehängt werden soll.
 *
 * NUR beim ERSTMALIGEN Ausfüllen einer bisher LEEREN Notiz (neuer Eintrag
 * mit Notiz, oder nachträgliches erstmaliges Ausfüllen eines bestehenden,
 * bis dahin notizlosen Eintrags) - ausdrücklich akzeptierter Kompromiss,
 * um bei wiederholtem Speichern desselben Eintrags (z.B. Tippfehler-
 * Korrektur) NICHT jedes Mal eine weitere Zeile anzuhängen. War die Notiz
 * bereits gesetzt, wird NICHT erneut angehängt, unabhängig davon, ob sich
 * der Text geändert hat.
 */
export function shouldAppendPerformedWorkLine(previousNote: string | undefined, newNote: string | undefined): boolean {
  return !previousNote?.trim() && !!newNote?.trim();
}

/** "10.08.2026, 08:00–12:00: Sicherung ersetzt" - ohne Start/Ende nur "10.08.2026: ...". */
export function formatTimeEntryPerformedWorkLine(
  entry: { date: string; startTime?: string; endTime?: string },
  note: string
): string {
  const timeRange = entry.startTime && entry.endTime ? `, ${entry.startTime}–${entry.endTime}` : '';
  return `${formatDateDE(entry.date)}${timeRange}: ${note.trim()}`;
}

/** Hängt `line` ans Ende von `performedWork` an (neue Zeile) - ein vorher leeres Feld wird einfach mit dieser einen Zeile befüllt. */
export function appendPerformedWorkLine(performedWork: string | undefined, line: string): string {
  const existing = performedWork?.trim();
  return existing ? `${existing}\n${line}` : line;
}
