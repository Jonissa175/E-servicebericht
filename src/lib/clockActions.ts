import { createReport, getReport, listReportsByProjectNumber } from './db/reports';
import {
  addTimeEntry,
  findOverlappingTimeEntries,
  getGloballyActiveTimeEntry,
  listTimeEntriesForDate,
  trimOverlappingTimeEntries,
  updateTimeEntry
} from './db/timeEntries';
import { checkInWorkDay, checkOutWorkDay, getActiveWorkDay } from './db/workDays';
import type { ID, ServiceReport, TimeEntry, WorkDay } from './db/types';
import { addMinutesToTime, centeredBreakWindow, nowHHmm, subtractTimeRange, todayISODate } from './utils/date';
import { MAX_DAILY_CLOCKED_MINUTES } from './utils/arbzg';

export interface DaySummary {
  workDay: WorkDay;
  totalMinutes: number;
  projectMinutes: number;
  /** "Leerlaufzeit": eingestempelt, aber keinem Projekt zugeordnet. */
  idleMinutes: number;
  /** Summe der beim Auschecken erfassten Pausen (siehe checkOutDay()) - bereits NICHT in totalMinutes enthalten. */
  breakMinutes: number;
}

/** Ein beim Tagesauschecken erfasstes Pausenfenster, siehe checkOutDay(). */
export interface BreakInput {
  startTime: string;
  endTime: string;
}

/**
 * Startet den Tagesstempel, falls noch keiner läuft, und beginnt sofort
 * Leerlaufzeit-Tracking (ein Tag ist nie "eingestempelt, aber auf nichts" -
 * es läuft immer entweder Leerlaufzeit oder ein Projekt-Abschnitt). Läuft
 * bereits ein Tag, passiert nichts (idempotent).
 */
export async function checkInDay(): Promise<WorkDay> {
  const active = await getActiveWorkDay();
  if (active) return active;
  const day = await checkInWorkDay();
  await addTimeEntry(undefined, { date: todayISODate(), startTime: nowHHmm(), workDayId: day.id });
  return day;
}

/**
 * Trägt eine Pause für ein beliebiges Zeitfenster ein - Kernstück sowohl von
 * checkOutDay() (Pausen beim Tagesausstempeln) als auch der manuellen
 * Nachtragung eines vergessenen/nachträglichen Pausenfensters in der
 * Auswertung (Statistik.svelte, Tag-Ansicht). Schaut per
 * findOverlappingTimeEntries() nach, welche bereits bestehenden Projekt-/
 * Leerlaufzeit-Abschnitte an diesem Tag in diesem Fenster liegen, schneidet
 * sie per trimOverlappingTimeEntries() heraus (gekürzt/gesplittet/komplett
 * gelöscht - exakt dieselbe Logik wie bei manuell erfassten
 * Überschneidungen) und legt einen eigenen, isBreak-markierten Eintrag für
 * die Pause selbst an (Nachvollziehbarkeit/Lohnabrechnung, sichtbar in der
 * Tages-Statistik) - der zählt nirgends als Arbeitszeit (siehe
 * TimeEntry.isBreak). Die dabei anfallenden TimeEntryTrimRecords (Vorher-
 * Zustand der weggeschnittenen Nachbar-Einträge) werden direkt am
 * Pause-Eintrag gespeichert, damit timeEntries.restoreBreak() die Pause
 * später bei Bedarf wieder rückgängig machen und die weggeschnittene Zeit
 * automatisch gutschreiben kann.
 *
 * `workDayId` bewusst optional: beim Tagesausstempeln (checkOutDay()) wird
 * der gerade beendete Tagesstempel mitgegeben (die Pause zählt dann zur
 * Tagesbilanz dieses Stempels, siehe listTimeEntriesForDate()); beim
 * manuellen Nachtragen für einen beliebigen (auch zurückliegenden) Tag
 * über die Auswertung gibt es keinen zugehörigen Tagesstempel, dort bleibt
 * es undefined - getDayStats()/getDayBreaks() lesen ohnehin direkt über
 * das Datum, nicht über workDayId.
 *
 * Ohne Effekt, wenn `startTime`/`endTime` fehlen.
 */
export async function addManualBreak(date: string, startTime: string, endTime: string, workDayId?: ID): Promise<void> {
  if (!startTime || !endTime) return;
  const overlaps = await findOverlappingTimeEntries(date, startTime, endTime);
  const trimRecords = await trimOverlappingTimeEntries(overlaps, startTime, endTime);
  await addTimeEntry(undefined, {
    date,
    startTime,
    endTime,
    workDayId,
    isBreak: true,
    trimRecords
  });
}

/**
 * Trägt Leerlaufzeit manuell für einen beliebigen (auch zurückliegenden) Tag
 * nach - z.B. wenn vergessen wurde, ein- oder auszustempeln, und deshalb für
 * einen Teil des Tages gar keine Zeit erfasst ist. Legt einfach einen ganz
 * normalen Leerlaufzeit-Eintrag (reportId undefined) an, der sich danach wie
 * jeder andere über "Leerlaufzeiten zuordnen" einem Projekt zuweisen lässt.
 * Schneidet vorher wie beim manuellen Erfassen einer Zeit (siehe
 * TimeEntrySection.svelte) und bei addManualBreak() zunächst eventuell
 * überschneidende Projekt-/Leerlaufzeit-Einträge heraus, damit ein
 * versehentlich überlappender Zeitraum nicht doppelt gezählt wird - im
 * Normalfall (echte Erfassungslücke durch vergessenes Ein-/Ausstempeln) gibt
 * es dort aber ohnehin nichts zu überschneiden.
 */
export async function addManualIdleTime(date: string, startTime: string, endTime: string): Promise<void> {
  if (!startTime || !endTime) return;
  const overlaps = await findOverlappingTimeEntries(date, startTime, endTime);
  await trimOverlappingTimeEntries(overlaps, startTime, endTime);
  await addTimeEntry(undefined, { date, startTime, endTime });
}

/**
 * Trägt Projektzeit für einen beliebigen (auch zurückliegenden) Tag direkt
 * einem Bericht nach, ohne dass man dafür den Bericht öffnen muss - z.B. aus
 * der Auswertung heraus (Statistik.svelte, Tag-Ansicht), wenn für mehrere
 * Tage am Stück vergessen wurde, Zeiten einzutragen: Datum einfach per
 * Vor-/Zurück-Navigation wechseln, Projekt wählen/anlegen, Zeit eintragen,
 * wiederholen. Schneidet wie addManualIdleTime()/addManualBreak() zunächst
 * eventuell überschneidende Projekt-/Leerlaufzeit-Einträge automatisch heraus
 * (ohne Rückfrage - konsistent mit den anderen "+ ... hinzufügen"-Buttons in
 * der Auswertung Tag-Ansicht, anders als die Rückfrage im Zeiten-Tab eines
 * Berichts selbst), damit ein versehentlich überlappender Zeitraum nicht
 * doppelt gezählt wird.
 *
 * `pauseMinutes` legt optional eine Pause automatisch mittig in den Zeitraum
 * (siehe centeredBreakWindow(), utils/date.ts) - dieselbe vereinfachte
 * "Pause abziehen"-Eingabe (nur Dauer statt exakter Uhrzeiten) wie im
 * Zeiten-Tab eines Berichts.
 */
export async function addManualProjectTime(
  reportId: ID,
  date: string,
  startTime: string,
  endTime: string,
  pauseMinutes?: number
): Promise<void> {
  if (!startTime || !endTime) return;
  const overlaps = await findOverlappingTimeEntries(date, startTime, endTime);
  await trimOverlappingTimeEntries(overlaps, startTime, endTime);
  await addTimeEntry(reportId, { date, startTime, endTime });
  if (pauseMinutes && pauseMinutes > 0) {
    const window = centeredBreakWindow(startTime, endTime, pauseMinutes);
    if (window) await addManualBreak(date, window.start, window.end);
  }
}

/**
 * Schließt den aktuell offenen Abschnitt (Leerlaufzeit oder Projekt),
 * schneidet optional erfasste Pausen heraus (siehe addManualBreak()) und
 * beendet den Tagesstempel. Gibt die Tageszusammenfassung zurück, oder
 * `undefined`, wenn gerade gar kein Tag läuft.
 *
 * `breaks`: Während einer Pause bleibt man laut Anleitung eingestempelt
 * (Projekt oder Leerlaufzeit läuft einfach weiter) statt extra
 * auszuchecken - beim Tagesausstempeln werden die tatsächlichen
 * Pausenzeiten nachträglich angegeben (der gerade geschlossene Abschnitt
 * zählt für die Überschneidungssuche schon mit, da er oben bereits eine
 * endTime bekommen hat).
 *
 * Die Zusammenfassung umfasst bewusst den GANZEN Kalendertag (`active.date`),
 * nicht nur diesen einen WorkDay-Datensatz: wurde am selben Tag bereits
 * einmal aus- und wieder eingestempelt, entstehen dabei mehrere WorkDay-
 * Einträge mit demselben Datum - deren Zeiten sollen sich zur Tagesbilanz
 * addieren, statt bei jedem erneuten Einstempeln wieder bei 0 anzufangen
 * (siehe listTimeEntriesForDate()).
 */
export async function checkOutDay(breaks: BreakInput[] = []): Promise<DaySummary | undefined> {
  const active = await getActiveWorkDay();
  if (!active) return undefined;

  const openEntry = await getGloballyActiveTimeEntry();
  if (openEntry && openEntry.workDayId === active.id) {
    await updateTimeEntry(openEntry.id, { endTime: nowHHmm() });
  }

  for (const brk of breaks) {
    await addManualBreak(active.date, brk.startTime, brk.endTime, active.id);
  }

  const closedDay = await checkOutWorkDay(active.id);
  if (!closedDay) return undefined;

  const entries = await listTimeEntriesForDate(active.date);
  let projectMinutes = 0;
  let idleMinutes = 0;
  let breakMinutes = 0;
  for (const entry of entries) {
    const minutes = entry.durationMinutes ?? 0;
    if (entry.isBreak) {
      breakMinutes += minutes;
    } else if (entry.reportId) {
      projectMinutes += minutes;
    } else {
      idleMinutes += minutes;
    }
  }
  return {
    workDay: closedDay,
    totalMinutes: projectMinutes + idleMinutes,
    projectMinutes,
    idleMinutes,
    breakMinutes
  };
}

export interface AutoCheckOutResult {
  workDay: WorkDay;
  /** Die (gekappte) Auscheck-Zeit "HH:mm", auf die die verstrichene Zeit begrenzt wurde. */
  cappedAt: string;
}

/**
 * Stempelt automatisch aus, wenn seit dem Einstempeln bereits die
 * Höchstarbeitszeit PLUS die dabei gesetzlich vorgeschriebene Pause
 * verstrichen ist (siehe MAX_DAILY_CLOCKED_MINUTES, §3+§4 ArbZG) - typisches
 * Zeichen dafür, dass schlicht vergessen wurde, manuell auszustempeln (z.B.
 * über Nacht eingestempelt geblieben, oder Handy/App einfach liegen
 * gelassen), statt tatsächlich so lange gearbeitet worden zu sein. Bewusst
 * NICHT schon bei genau 10 Std. (der reinen Höchstarbeitszeit): wer laut
 * Anleitung während der Pause eingestempelt bleibt und sie erst beim
 * Ausstempeln nachträgt (checkOutDay()), ist bei einem vollen legalen
 * 10-Std.-Arbeitstag inkl. Pflichtpause 10 Std. 45 Min. am Stück
 * eingestempelt - das darf nicht schon vorher als "vergessen auszustempeln"
 * gewertet werden. Ohne Effekt (liefert `undefined`), solange kein Tag aktiv
 * ist oder diese Grenze noch nicht erreicht ist.
 *
 * Wird beim Öffnen der App und periodisch aufgerufen, solange sie geöffnet
 * ist (siehe DayClock.svelte) - eine tatsächliche Überschreitung kann sich
 * also erst mit Verzögerung bemerkbar machen, wenn die App zwischenzeitlich
 * geschlossen war. Die verstrichene Zeit wird bewusst über die echte
 * Kalender-Differenz (WorkDay.date + checkInTime bis jetzt) statt nur über
 * "HH:mm"-Arithmetik berechnet, damit auch ein über mehrere Tage
 * vergessenes Auschecken zuverlässig erkannt wird.
 *
 * Die Auscheck-Zeit wird bewusst NICHT auf "jetzt" gesetzt (das könnte, je
 * nachdem wann die App das nächste Mal geöffnet wird, viele Stunden oder
 * sogar Tage später sein und eine völlig unplausible Dauer ergeben),
 * sondern exakt auf Einstempelzeit + MAX_DAILY_CLOCKED_MINUTES gekappt - ein
 * klar erkennbarer, runder Platzhalterwert, den der Nutzer anschließend
 * bewusst prüfen und ggf. korrigieren soll (siehe Hinweis-Banner in
 * DayClock.svelte). War die Pause zu diesem Zeitpunkt noch nicht
 * nachgetragen, zeigt der resultierende (dann über 10 Std. lange) Zeiteintrag
 * selbst wieder die reguläre farbliche Hervorhebung (exceedsMaxDailyWork(),
 * Grenze weiterhin 10 Std.) - ein zusätzlicher Anstoß, die Pause nachzutragen.
 */
export async function autoCheckOutIfExceeded(): Promise<AutoCheckOutResult | undefined> {
  const active = await getActiveWorkDay();
  const checkInTime = active?.checkInTime;
  if (!active || !checkInTime) return undefined;

  const [y, m, d] = active.date.split('-').map(Number);
  const [hh, mm] = checkInTime.split(':').map(Number);
  const checkedInAt = new Date(y, m - 1, d, hh, mm);
  const elapsedMinutes = (Date.now() - checkedInAt.getTime()) / 60_000;
  if (elapsedMinutes < MAX_DAILY_CLOCKED_MINUTES) return undefined;

  const cappedAt = addMinutesToTime(checkInTime, MAX_DAILY_CLOCKED_MINUTES);

  const openEntry = await getGloballyActiveTimeEntry();
  if (openEntry && openEntry.workDayId === active.id) {
    await updateTimeEntry(openEntry.id, { endTime: cappedAt });
  }

  const closedDay = await checkOutWorkDay(active.id, cappedAt);
  if (!closedDay) return undefined;
  return { workDay: closedDay, cappedAt };
}

/**
 * Wechselt in ein Projekt: startet bei Bedarf transparent den Tagesstempel
 * (der bisherige "Direkt einchecken"-Schnellzugriff ohne explizites
 * Tages-Einstempeln funktioniert dadurch unverändert weiter), schließt den
 * aktuell offenen Abschnitt und öffnet einen neuen Projekt-Zeitabschnitt.
 * Bricht ab, wenn der Ziel-Bericht gesperrt ist. Fragt nur beim Wechsel
 * zwischen zwei VERSCHIEDENEN Projekten noch einmal nach (schützt vor
 * versehentlichem Wechsel) - Leerlaufzeit→Projekt oder Projekt→Leerlaufzeit
 * ist erwartetes, alltägliches Verhalten und braucht keine Rückfrage mehr.
 *
 * @returns true, wenn gewechselt wurde; false bei gesperrtem Ziel-Bericht
 * oder abgelehnter Rückfrage.
 */
export async function switchToProject(reportId: ID): Promise<boolean> {
  const targetReport = await getReport(reportId);
  if (!targetReport || targetReport.finalizedAt) return false;

  const day = await checkInDay();
  const current = await getGloballyActiveTimeEntry();

  if (current?.reportId && current.reportId !== reportId) {
    const currentReport = await getReport(current.reportId);
    const label = currentReport?.projectNumber ?? 'einem anderen Bericht';
    const confirmed = confirm(
      `Du bist noch in "${label}" eingecheckt (seit ${current.startTime}). Dort jetzt auschecken und hier neu einchecken?`
    );
    if (!confirmed) return false;
  }

  if (current) {
    await updateTimeEntry(current.id, { endTime: nowHHmm() });
  }
  await addTimeEntry(reportId, { date: todayISODate(), startTime: nowHHmm(), workDayId: day.id });
  return true;
}

/**
 * Checkt aus dem aktuellen Projekt aus - Leerlaufzeit läuft weiter, solange
 * der Tag noch läuft. Kein Effekt, wenn gerade kein Tag aktiv ist.
 */
export async function switchToIdle(): Promise<void> {
  const day = await getActiveWorkDay();
  if (!day) return;
  const current = await getGloballyActiveTimeEntry();
  if (current && current.workDayId === day.id) {
    await updateTimeEntry(current.id, { endTime: nowHHmm() });
  }
  await addTimeEntry(undefined, { date: todayISODate(), startTime: nowHHmm(), workDayId: day.id });
}

/** Ordnet einen bestehenden Leerlaufzeit-Eintrag nachträglich einem Bericht zu. */
export async function reassignIdleEntry(entryId: ID, reportId: ID): Promise<void> {
  await updateTimeEntry(entryId, { reportId });
}

/**
 * Ordnet Leerlaufzeit aus der Tag-Ansicht der Auswertung (Statistik.svelte)
 * nachträglich einem Projekt zu - entweder die KOMPLETTE Leerlaufzeit
 * (`windowStart`/`windowEnd` entsprechen exakt dem bisherigen Zeitraum des
 * Eintrags, dann reicht ein einfaches Umhängen der reportId, siehe
 * reassignIdleEntry()) oder nur ein AUSSCHNITT davon (z.B. "von den 3 Std.
 * Leerlaufzeit gehörte nur die erste knappe Stunde tatsächlich zu Projekt
 * X") - dann wird der bestehende Eintrag auf genau dieses Zeitfenster
 * verkleinert UND bekommt die reportId, die davor/danach verbleibende(n)
 * Lücke(n) bleiben als eigene(r) Leerlaufzeit-Eintrag/-Einträge erhalten
 * (`subtractTimeRange()` - dieselbe Lücken-Berechnung wie beim Verkleinern
 * eines Zeiteintrags in updateManualTimeEntry(); klemmt ein zu weit
 * gewähltes Zeitfenster automatisch auf den bisherigen Zeitraum). Die
 * Lücken-Einträge bekommen dieselbe workDayId wie der Ursprungseintrag, damit
 * sie weiter zur "Heute bisher"-Tagesbilanz zählen (listTimeEntriesForDate()),
 * falls der Tag noch läuft.
 *
 * Ohne Effekt, wenn der Ursprungseintrag oder das Zeitfenster unvollständig
 * ist.
 */
export async function assignIdleTime(
  entry: Pick<TimeEntry, 'id' | 'date' | 'startTime' | 'endTime' | 'workDayId'>,
  reportId: ID,
  windowStart: string,
  windowEnd: string
): Promise<void> {
  if (!entry.startTime || !entry.endTime || !windowStart || !windowEnd) return;

  if (windowStart === entry.startTime && windowEnd === entry.endTime) {
    await reassignIdleEntry(entry.id, reportId);
    return;
  }

  const gaps = subtractTimeRange({ start: entry.startTime, end: entry.endTime }, { start: windowStart, end: windowEnd });
  await updateTimeEntry(entry.id, { startTime: windowStart, endTime: windowEnd, reportId });
  for (const gap of gaps) {
    await addTimeEntry(undefined, { date: entry.date, startTime: gap.start, endTime: gap.end, workDayId: entry.workDayId });
  }
}

/**
 * Aktualisiert einen manuell im Zeiten-Tab bearbeiteten (bereits
 * bestehenden) Zeiteintrag. Wird der abgedeckte Zeitraum dabei gegenüber dem
 * bisherigen VERKLEINERT oder verschoben - z.B. weil im Nachhinein auffällt,
 * dass ein Teil der Zeit tatsächlich für ein anderes Projekt draufging -,
 * verschwindet die dadurch freiwerdende Zeit nicht einfach spurlos:
 * `subtractTimeRange()` berechnet die Lücke(n) zwischen altem und neuem
 * Zeitraum, für jede wird ein eigener Leerlaufzeit-Eintrag (reportId
 * undefined) angelegt. Der lässt sich anschließend wie jede andere
 * Leerlaufzeit einem Projekt zuordnen oder bleibt einfach Leerlaufzeit
 * (siehe reassignIdleEntry()/Leerlaufzeiten.svelte) - statt dass die
 * gesamte an diesem Tag gestempelte Zeit kommentarlos kürzer wird, sobald
 * ein Eintrag nachträglich korrigiert wird.
 *
 * `original` ist der VOR der Bearbeitung geladene Zeiteintrag (von der
 * aufrufenden Komponente übergeben, spart einen zusätzlichen DB-Read - beim
 * Bearbeiten in TimeEntrySection.svelte liegt er ohnehin schon im
 * geladenen `entries`-Array vor). Bewusst nur die tatsächlich benötigten
 * Felder (`Pick<...>` statt der vollen `TimeEntry`), damit auch Aufrufer, die
 * nur eine schlanke Projektion vorliegen haben (z.B. DayIdleEntry in
 * Statistik.svelte), keinen zusätzlichen vollen Zeiteintrag laden müssen. Die
 * Lücken-Berechnung greift nur, wenn sowohl der bisherige als auch der neue
 * Zeitraum vollständig sind (Start UND Ende gesetzt) und sich das Datum nicht
 * ändert - andernfalls (z.B. ein noch offener Eintrag bekommt erstmals eine
 * Endzeit, oder der Eintrag wird auf einen anderen Tag verschoben) gibt es
 * keine sinnvoll vergleichbare "alte" Zeitspanne, dann wird nur normal
 * aktualisiert, ohne Leerlaufzeit anzulegen.
 */
export async function updateManualTimeEntry(
  original: Pick<TimeEntry, 'id' | 'date' | 'startTime' | 'endTime'>,
  payload: { date: string; startTime?: string; endTime?: string; note?: string }
): Promise<void> {
  await updateTimeEntry(original.id, payload);

  if (!original.startTime || !original.endTime || !payload.startTime || !payload.endTime) return;
  if (original.date !== payload.date) return;

  const gaps = subtractTimeRange(
    { start: original.startTime, end: original.endTime },
    { start: payload.startTime, end: payload.endTime }
  );
  for (const gap of gaps) {
    await addTimeEntry(undefined, { date: original.date, startTime: gap.start, endTime: gap.end });
  }
}

/**
 * Aktualisiert einen in der Auswertung (Tag-Ansicht) bearbeiteten
 * Leerlaufzeit-Eintrag. Kombiniert zwei Verhaltensweisen:
 * - Überschneidet der NEUE Zeitraum einen ANDEREN bereits erfassten
 *   Projekt-/Leerlaufzeit-/Pausen-Abschnitt (z.B. weil sich beim Eintippen
 *   vertippt wurde), wird die überschneidende Zeit dort automatisch
 *   herausgeschnitten (wie bei addManualIdleTime()) - schützt vor doppelter
 *   Zählung. Der bearbeitete Eintrag selbst ist dabei bewusst von der
 *   Überschneidungssuche ausgeschlossen (er überschneidet sich sonst mit
 *   seinem eigenen alten Zeitraum).
 * - Wird der abgedeckte Zeitraum gegenüber dem BISHERIGEN Wert dieses
 *   Eintrags verkleinert oder verschoben, bleibt die dadurch freiwerdende
 *   Zeit als eigener Leerlaufzeit-Eintrag erhalten (siehe
 *   updateManualTimeEntry()) statt spurlos zu verschwinden.
 */
export async function updateManualIdleTime(
  original: Pick<TimeEntry, 'id' | 'date' | 'startTime' | 'endTime'>,
  date: string,
  startTime: string,
  endTime: string
): Promise<void> {
  if (!startTime || !endTime) return;
  const overlaps = await findOverlappingTimeEntries(date, startTime, endTime, original.id);
  await trimOverlappingTimeEntries(overlaps, startTime, endTime);
  await updateManualTimeEntry(original, { date, startTime, endTime });
}

export interface StartProjectResult {
  report: ServiceReport;
  /** true, wenn ein bereits offener Bericht mit dieser Projektnummer wiederverwendet wurde, statt einen neuen anzulegen. */
  reused: boolean;
  /** Position dieses Berichts unter allen Berichten mit dieser Projektnummer, chronologisch (1 = erster). */
  visitNumber: number;
  /** Gesamtzahl der Berichte mit dieser Projektnummer (inkl. diesem). */
  visitTotal: number;
}

/**
 * Löst eine per Hand eingegebene Projektnummer (Direkt-Einchecken-
 * Schnellzugriff) zu einem Bericht auf - für den Fall, dass es zu dieser
 * Nummer bereits Berichte gibt (wiederkehrender Kunde/Standort):
 *
 * - Existiert bereits ein NICHT gesperrter Bericht mit exakt dieser
 *   Projektnummer, wird DER wiederverwendet statt ein Duplikat anzulegen -
 *   man kann ja nicht zwei offene Berichte parallel zum selben Projekt
 *   führen wollen.
 * - Sonst wird ein neuer Bericht angelegt (auch wenn es zu dieser
 *   Projektnummer bereits abgeschlossene/gesperrte Berichte gibt - z.B. ein
 *   erneuter Einsatz beim selben Kunden). `visitNumber`/`visitTotal` geben
 *   an, der wievielte Bericht zu dieser Projektnummer das ist, damit die
 *   UI das sichtbar machen kann.
 *
 * Prüft bewusst `finalizedAt` (die kanonische Sperre, siehe switchToProject())
 * statt `status`, um das kurze Zeitfenster zwischen dem Setzen von
 * `finalizedAt` beim Unterschreiben und dem etwas später greifenden
 * Autosave-Update von `status` sicher abzudecken.
 */
export async function startProjectByNumber(
  projectNumber: string,
  technicianName?: string
): Promise<StartProjectResult> {
  const trimmed = projectNumber.trim();
  const existing = await listReportsByProjectNumber(trimmed);
  const openExisting = existing.find((report) => !report.finalizedAt);

  if (openExisting) {
    return {
      report: openExisting,
      reused: true,
      visitNumber: existing.indexOf(openExisting) + 1,
      visitTotal: existing.length
    };
  }

  const report = await createReport({ projectNumber: trimmed, technicianName });
  return { report, reused: false, visitNumber: existing.length + 1, visitTotal: existing.length + 1 };
}
