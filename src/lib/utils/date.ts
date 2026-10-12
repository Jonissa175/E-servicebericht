/** Kleine, abhängigkeitsfreie Datums-/Zeit-Helfer für die App. */

/**
 * Heutiges Datum in der lokalen Zeitzone als "YYYY-MM-DD" (für
 * input[type=date]-Defaultwerte sowie fürs Tages-Ein-/Ausstempeln und
 * Projekt-Ein-/Auschecken). Bewusst NICHT über `toISOString()` (das liefert
 * UTC) - sonst würde z.B. für jemanden in Deutschland kurz nach lokaler
 * Mitternacht noch der Vortag zurückgegeben.
 */
export function todayISODate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Aktuelle Uhrzeit (lokale Zeitzone) als "HH:mm" - fürs Tages-Ein-/Ausstempeln und Projekt-Ein-/Auschecken. */
export function nowHHmm(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** Wandelt "HH:mm" in Minuten seit Mitternacht um, `undefined` bei ungültigem Format. */
export function parseTimeToMinutes(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

/**
 * Berechnet die Dauer in Minuten zwischen zwei "HH:mm"-Zeiten. Liefert
 * `undefined` bei ungültigem Format. Liegt die Endzeit VOR der Startzeit
 * (z.B. Start 19:05, Ende 12:16), wird das als Zeitspanne über Mitternacht
 * hinweg interpretiert und um 24h ergänzt (19:05–12:16 -> 17:11 Std.) - sowohl
 * die Tagesstempeluhr (Über-Nacht-Schicht, vergessenes Auschecken) als auch
 * manuell erfasste Zeiten können das brauchen. `TimeEntry` kennt kein eigenes
 * End-Datum, daher landet die volle Dauer auf dem Start-Datum des Eintrags -
 * für Statistiken bewusst in Kauf genommen, statt das Datenmodell dafür zu
 * erweitern (seltener Fall).
 */
export function computeDurationMinutes(startTime: string, endTime: string): number | undefined {
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);
  if (start === undefined || end === undefined) return undefined;
  const diff = end - start;
  return diff >= 0 ? diff : diff + 24 * 60;
}

/**
 * Addiert `minutes` Minuten zu einer "HH:mm"-Zeit, mit Wraparound über
 * Mitternacht (Modulo 24h) - z.B. für eine automatisch gekappte Auscheck-Zeit
 * (siehe clockActions.autoCheckOutIfExceeded()). Läuft das Ergebnis über
 * Mitternacht, entsteht dieselbe "kleiner als die Startzeit"-Situation, die
 * computeDurationMinutes() bereits als Überschneidung über Mitternacht hinweg
 * interpretiert - beide Funktionen bleiben so konsistent zueinander. Liefert
 * die unveränderte Eingabe zurück, wenn `time` kein gültiges "HH:mm" ist.
 */
export function addMinutesToTime(time: string, minutes: number): string {
  const start = parseTimeToMinutes(time);
  if (start === undefined) return time;
  const dayMinutes = 24 * 60;
  const total = ((start + minutes) % dayMinutes + dayMinutes) % dayMinutes;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

export interface TimeRange {
  start: string;
  end: string;
}

/**
 * Berechnet, welche Teile von `a` NICHT von `b` abgedeckt werden ("a minus
 * b") - Grundlage für clockActions.updateManualTimeEntry(): wird ein
 * bestehender Zeiteintrag manuell verkleinert oder verschoben (z.B. weil im
 * Nachhinein auffällt, dass ein Teil der Zeit tatsächlich für ein anderes
 * Projekt draufging), soll die dadurch freiwerdende Zeit nicht spurlos
 * verschwinden, sondern als eigener Leerlaufzeit-Eintrag erhalten bleiben.
 * Nutzt dieselbe "Ende vor Start -> über Mitternacht"-Konvention wie
 * computeDurationMinutes(), setzt also voraus, dass `a` und `b` sich auf
 * denselben Kalendertag beziehen (kein eigenes End-Datum). Liefert bis zu
 * zwei Teilbereiche (Anfang und/oder Ende von `a`, je nachdem wo genau sich
 * `b` überschneidet); liegt `b` komplett außerhalb von `a`, wird `a`
 * unverändert als einziger Teilbereich zurückgegeben; deckt `b` `a`
 * vollständig ab, eine leere Liste. Liefert eine leere Liste auch bei
 * ungültigem Format.
 */
export function subtractTimeRange(a: TimeRange, b: TimeRange): TimeRange[] {
  const aStart = parseTimeToMinutes(a.start);
  let aEnd = parseTimeToMinutes(a.end);
  const bStart = parseTimeToMinutes(b.start);
  let bEnd = parseTimeToMinutes(b.end);
  if (aStart === undefined || aEnd === undefined || bStart === undefined || bEnd === undefined) return [];
  if (aEnd <= aStart) aEnd += 24 * 60;
  if (bEnd <= bStart) bEnd += 24 * 60;

  // `b` auf den Wertebereich von `a` einschränken - alles außerhalb von `a`
  // ist für die Lücken-Berechnung irrelevant.
  const clampedBStart = Math.min(Math.max(bStart, aStart), aEnd);
  const clampedBEnd = Math.min(Math.max(bEnd, aStart), aEnd);

  const ranges: TimeRange[] = [];
  if (clampedBStart > aStart) {
    ranges.push({ start: addMinutesToTime('00:00', aStart), end: addMinutesToTime('00:00', clampedBStart) });
  }
  if (clampedBEnd < aEnd) {
    ranges.push({ start: addMinutesToTime('00:00', clampedBEnd), end: addMinutesToTime('00:00', aEnd) });
  }
  return ranges;
}

/**
 * Legt eine Pause mit vorgegebener Dauer (statt genauer Uhrzeiten) mittig in
 * [startTime, endTime] - bei einer vorgegebenen Dauer ist die Tagesmitte der
 * plausibelste Standardort für eine Mittagspause. Genutzt von der
 * vereinfachten "Pause abziehen"-Eingabe (Zeiten-Tab eines Berichts,
 * Projekt-Zeit-Nacherfassung in der Auswertung). Liefert `undefined`, wenn
 * die Pause nicht in den Zeitraum passt (länger oder genauso lang) oder die
 * Zeiten ungültig sind.
 */
export function centeredBreakWindow(startTime: string, endTime: string, breakMinutes: number): TimeRange | undefined {
  const totalMinutes = computeDurationMinutes(startTime, endTime);
  if (totalMinutes === undefined || breakMinutes <= 0 || breakMinutes >= totalMinutes) return undefined;
  const offset = Math.floor((totalMinutes - breakMinutes) / 2);
  const breakStart = addMinutesToTime(startTime, offset);
  const breakEnd = addMinutesToTime(breakStart, breakMinutes);
  return { start: breakStart, end: breakEnd };
}

/** Formatiert Minuten als "H:MM Std." für die Anzeige (z.B. "7:30 Std."). */
export function formatDurationMinutes(totalMinutes: number | undefined | null): string {
  const minutesTotal = Math.max(0, totalMinutes ?? 0);
  const hours = Math.floor(minutesTotal / 60);
  const minutes = minutesTotal % 60;
  return `${hours}:${String(minutes).padStart(2, '0')} Std.`;
}

/**
 * Montag der Kalenderwoche, die `isoDate` enthält, als "YYYY-MM-DD"
 * (deutsche/ISO-8601-Konvention: Woche beginnt Montag, nicht Sonntag).
 * Rechnet bewusst über den lokalen `Date`-Konstruktor mit Jahr/Monat/Tag
 * statt über String-Parsing von `new Date(iso)` (das interpretiert als UTC
 * und würde nahe Mitternacht in manchen Zeitzonen einen falschen Tag
 * liefern) - gleiches Muster wie `shiftDate()` in Statistik.svelte.
 */
export function startOfWeekISO(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  // getDay(): 0=So, 1=Mo, ..., 6=Sa - auf Montag als Wochenstart umrechnen.
  const dayOfWeek = date.getDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  date.setDate(date.getDate() + diffToMonday);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Formatiert "YYYY-MM-DD" als deutsches Datum "TT.MM.JJJJ". */
export function formatDateDE(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  if (!year || !month || !day) return isoDate;
  return `${day}.${month}.${year}`;
}

/** Formatiert einen ISO-Zeitstempel als kurzes deutsches Datum+Uhrzeit. */
export function formatDateTimeDE(isoDateTime: string): string {
  const date = new Date(isoDateTime);
  if (Number.isNaN(date.getTime())) return isoDateTime;
  return date.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}
