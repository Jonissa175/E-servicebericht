<script lang="ts">
  import {
    getDayProjectBreakdown,
    getDayStats,
    getDayTimeline,
    type DayProjectBreakdown,
    type DayStats,
    type DayTimelineEntry
  } from '../lib/db/stats';
  import { deleteTimeEntry, restoreBreak } from '../lib/db/timeEntries';
  import {
    addManualBreak,
    addManualIdleTime,
    addManualProjectTime,
    assignIdleTime,
    startProjectByNumber,
    updateManualIdleTime
  } from '../lib/clockActions';
  import { listAbsencesInRange, removeAbsence, setAbsence } from '../lib/db/absences';
  import { listReports } from '../lib/db/reports';
  import type { Absence, AbsenceType, ID, ServiceReport } from '../lib/db/types';
  import { navigate } from '../lib/router.svelte';
  import { formatDurationMinutes, startOfWeekISO, todayISODate } from '../lib/utils/date';
  import { getMonthTarget, type MonthTarget } from '../lib/utils/targetHours';
  import { exceedsMaxDailyWork } from '../lib/utils/arbzg';
  import { SvelteSet } from 'svelte/reactivity';
  import { computeDayStatus, type DayStatus } from '../lib/utils/calendarDay';
  import { getGermanHolidays } from '../lib/utils/holidays';
  import { getBundesland, getTechnicianName } from '../lib/settings';
  import Icon, { type IconName } from '../lib/components/Icon.svelte';

  type View = 'tag' | 'monat' | 'jahr' | 'kalender';
  type CalendarMode = 'monat' | 'woche';

  interface CalendarCell {
    date: string;
    dayOfMonth: number;
    status: DayStatus;
  }

  const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

  // Reihenfolge bestimmt auch die Legenden-Reihenfolge in der Kalender-Ansicht.
  const LEGEND_STATUSES: DayStatus[] = ['open', 'booked', 'holiday', 'vacation', 'sick', 'timeoff', 'weekend'];

  const STATUS_BG: Record<DayStatus, string> = {
    vacation: 'var(--color-vacation-bg)',
    sick: 'var(--color-sick-bg)',
    timeoff: 'var(--color-timeoff-bg)',
    holiday: 'var(--color-holiday-bg)',
    booked: 'var(--color-completed-bg)',
    weekend: 'var(--color-surface-muted)',
    open: 'var(--color-open-bg)'
  };

  const STATUS_FG: Record<DayStatus, string> = {
    vacation: 'var(--color-vacation)',
    sick: 'var(--color-sick)',
    timeoff: 'var(--color-timeoff)',
    holiday: 'var(--color-holiday)',
    booked: 'var(--color-completed)',
    weekend: 'var(--color-text-muted)',
    open: 'var(--color-open)'
  };

  const STATUS_LABELS: Record<DayStatus, string> = {
    vacation: 'Urlaub',
    sick: 'Krank',
    timeoff: 'Zeitausgleich',
    holiday: 'Feiertag',
    booked: 'Gebucht',
    weekend: 'Wochenende',
    open: 'Offen'
  };

  // Für das Quick-Entry-Panel unter dem Kalendertag: dieselbe Auswahl wie im
  // Abwesenheiten-Screen (Urlaub/Krank/Zeitausgleich), hier aber direkt im
  // Kalender antippbar statt über einen eigenen Screen.
  const ABSENCE_TYPES: AbsenceType[] = ['vacation', 'sick', 'timeoff'];
  const ABSENCE_ICONS: Record<AbsenceType, IconName> = {
    vacation: 'umbrella',
    sick: 'thermometer',
    timeoff: 'refresh-cw'
  };
  // Nur für diese Status ergibt eine Abwesenheits-Schnellerfassung Sinn: ein
  // offener Werktag (kann als Urlaub/Krank/ZA markiert werden) oder ein Tag,
  // der bereits eine Abwesenheit trägt (kann geändert/entfernt werden). Bei
  // Feiertag/Wochenende/bereits gebuchter Zeit gibt's bewusst keine
  // Schnellerfassung - dort würde eine Abwesenheit echte Daten überlagern.
  const QUICK_ABSENCE_STATUSES: DayStatus[] = ['open', 'vacation', 'sick', 'timeoff'];

  let dayStats = $state<DayStats[]>([]);
  let loading = $state(true);
  let view = $state<View>('monat');
  // Chronologischer Zeitverlauf des in der Tag-Ansicht gewählten Tages -
  // Projekt-, Leerlaufzeit- und Pausen-Abschnitte gemeinsam nach Startzeit
  // sortiert (siehe getDayTimeline() in db/stats.ts), statt nach Kategorie
  // gruppiert. Farblich nach `kind` unterschieden (s. Markup/CSS unten).
  let dayTimeline = $state<DayTimelineEntry[]>([]);
  // Formular zum nachträglichen Eintragen einer Pause für den in der
  // Tag-Ansicht gewählten Tag (unabhängig vom Tagesausstempeln - z.B. für
  // eine vergessene Pause oder einen zurückliegenden Tag).
  let addBreakFormOpen = $state(false);
  let addBreakStart = $state('');
  let addBreakEnd = $state('');
  let addingBreak = $state(false);
  // Formular zum nachträglichen Eintragen von Leerlaufzeit für den in der
  // Tag-Ansicht gewählten Tag - z.B. wenn vergessen wurde, ein- oder
  // auszustempeln, und deshalb für einen Teil des Tages gar keine Zeit
  // erfasst ist. Analog zum Pausen-Formular oben.
  let addIdleFormOpen = $state(false);
  let addIdleStart = $state('');
  let addIdleEnd = $state('');
  let addingIdle = $state(false);
  // Gesetzt, während das Formular oben einen BESTEHENDEN Leerlaufzeit-
  // Eintrag im Zeitverlauf bearbeitet statt einen neuen anzulegen (Klick auf
  // einen Leerlaufzeit-Eintrag) - submitAddIdle() unterscheidet danach. Nur
  // die tatsächlich benötigten Felder (wie bei updateManualTimeEntry() in
  // clockActions.ts), ein DayTimelineEntry erfüllt das strukturell mit.
  let editingIdleEntry = $state<{ id: ID; startTime?: string; endTime?: string } | undefined>(undefined);
  // Leerlaufzeit-Eintrag, für den gerade das "Projekt zuordnen"-Panel offen
  // ist (siehe openAssignIdlePanel() unten) - zweistufig: erst ein Bericht
  // (assignIdleSelectedReport), danach entweder die komplette Zeit oder ein
  // per Hand gewähltes Zeitfenster daraus (assignIdleUseFullRange).
  let assignIdleEntry = $state<DayTimelineEntry | undefined>(undefined);
  let assignIdleQuery = $state('');
  let assignIdleReports = $state<ServiceReport[]>([]);
  let assignIdleSelectedReport = $state<ServiceReport | undefined>(undefined);
  let assignIdleUseFullRange = $state(true);
  let assignIdleWindowStart = $state('');
  let assignIdleWindowEnd = $state('');
  let assigningIdle = $state(false);
  // Formular zum direkten Nachtragen einer PROJEKT-Zeit aus der Auswertung
  // heraus (siehe openAddProjectTimeForm() unten) - z.B. wenn für mehrere
  // Tage am Stück vergessen wurde, Zeiten einzutragen: Bericht per Suche
  // wählen oder per Projektnummer neu anlegen, Zeit direkt hier eintragen,
  // ohne den Bericht öffnen zu müssen (Alternative: "→ Projekt öffnen",
  // falls die volle Bericht-Ansicht doch gebraucht wird).
  let addProjectTimeFormOpen = $state(false);
  let addProjectTimeQuery = $state('');
  let addProjectTimeOpenReports = $state<ServiceReport[]>([]);
  let addProjectTimeLoadingReports = $state(false);
  let addProjectTimeSelectedReport = $state<ServiceReport | undefined>(undefined);
  let addProjectTimeStart = $state('');
  let addProjectTimeEnd = $state('');
  let addProjectTimePauseEnabled = $state(false);
  let addProjectTimePauseHours = $state(0.5);
  let addingProjectTime = $state(false);
  let monthTarget = $state<MonthTarget>({
    targetMinutes: 0,
    workingDays: 0,
    creditedAbsenceDays: 0,
    creditedAbsenceMinutes: 0
  });
  let calendarMode = $state<CalendarMode>('monat');
  let calendarAbsences = $state<Absence[]>([]);
  // Im Kalender-Tab angetippter Tag: statt (wie früher) sofort in den
  // Tag-Reiter zu springen, bleibt man im Kalender und die Tages-Infos
  // klappen direkt darunter auf. Erneutes Antippen desselben Tages klappt
  // wieder zu.
  let selectedCalendarDate = $state<string | undefined>(undefined);
  let calendarDayBreakdown = $state<DayProjectBreakdown[]>([]);
  // Welche Projekt-Zeilen der Projekt-Aufschlüsselung im Kalender-Tagespanel
  // gerade aufgeklappt sind (zeigt dann die einzelnen gestempelten
  // Zeitabschnitte statt nur der Summe) - die Tag-Ansicht selbst braucht das
  // nicht mehr, dort steht ohnehin schon jeder einzelne Abschnitt chronologisch
  // im Zeitverlauf (siehe dayTimeline oben).
  const expandedCalendarProjects = new SvelteSet<ID>();

  const today = todayISODate();
  let selectedDate = $state(today);
  let selectedMonth = $state(today.slice(0, 7)); // "YYYY-MM"
  let selectedYear = $state(Number(today.slice(0, 4)));
  let selectedWeekStart = $state(startOfWeekISO(today));

  async function load(): Promise<void> {
    loading = true;
    dayStats = await getDayStats();
    loading = false;
  }

  $effect(() => {
    load();
  });

  /** Lädt den Zeitverlauf (siehe dayTimeline oben) für den gewählten Tag neu. */
  async function reloadDayTimeline(): Promise<void> {
    dayTimeline = await getDayTimeline(selectedDate);
  }

  // Lädt den Zeitverlauf neu, sobald die Tag-Ansicht aktiv ist oder sich das
  // gewählte Datum ändert - unabhängig davon, ob man über den "Tag"-Reiter
  // direkt oder per Antippen einer Tages-Zeile aus der Monatsansicht
  // (openDay) dorthin gelangt ist.
  $effect(() => {
    if (view !== 'tag') return;
    void reloadDayTimeline();
  });

  async function removeBreak(breakId: string): Promise<void> {
    // restoreBreak() macht die beim Anlegen der Pause gekürzten/gesplitteten/
    // gelöschten Nachbar-Einträge automatisch wieder rückgängig (siehe
    // TimeEntry.trimRecords) - die weggeschnittene Zeit wird also wieder
    // dem Projekt bzw. der Leerlaufzeit gutgeschrieben, bei dem sie
    // ursprünglich abgezogen wurde.
    if (!confirm('Pause löschen? Die dadurch abgezogene Zeit wird dem Projekt/der Leerlaufzeit wieder gutgeschrieben.')) return;
    await restoreBreak(breakId);
    await reloadDayTimeline();
    await load();
  }

  function openAddBreakForm(): void {
    addBreakStart = '';
    addBreakEnd = '';
    addBreakFormOpen = true;
  }

  function closeAddBreakForm(): void {
    addBreakFormOpen = false;
  }

  /**
   * Trägt eine Pause manuell nach - unabhängig vom Tagesausstempeln, für
   * einen beliebigen (auch zurückliegenden) Tag. Nutzt dieselbe Carve-out-
   * Logik wie beim Auschecken (addManualBreak() in clockActions.ts): die
   * Pausenzeit wird aus überschneidenden Projekt-/Leerlaufzeit-Einträgen
   * dieses Tages herausgeschnitten.
   */
  async function submitAddBreak(): Promise<void> {
    if (!addBreakStart || !addBreakEnd || addingBreak) return;
    addingBreak = true;
    try {
      await addManualBreak(selectedDate, addBreakStart, addBreakEnd);
      addBreakFormOpen = false;
      await reloadDayTimeline();
      await load();
    } finally {
      addingBreak = false;
    }
  }

  async function removeIdleEntry(entryId: string): Promise<void> {
    if (!confirm('Leerlaufzeit löschen?')) return;
    await deleteTimeEntry(entryId);
    await reloadDayTimeline();
    await load();
  }

  function openAddIdleForm(): void {
    closeAssignIdlePanel();
    closeAddProjectTimeForm();
    editingIdleEntry = undefined;
    addIdleStart = '';
    addIdleEnd = '';
    addIdleFormOpen = true;
  }

  /** Öffnet dasselbe Formular im Bearbeiten-Modus, vorausgefüllt mit den bisherigen Zeiten des angetippten Eintrags. */
  function startEditIdle(entry: DayTimelineEntry): void {
    closeAssignIdlePanel();
    closeAddProjectTimeForm();
    editingIdleEntry = entry;
    addIdleStart = entry.startTime ?? '';
    addIdleEnd = entry.endTime ?? '';
    addIdleFormOpen = true;
  }

  function closeAddIdleForm(): void {
    addIdleFormOpen = false;
    editingIdleEntry = undefined;
  }

  /**
   * Legt Leerlaufzeit manuell an oder bearbeitet einen bestehenden Eintrag -
   * unabhängig von der Tagesstempeluhr, für einen beliebigen (auch
   * zurückliegenden) Tag. Neuanlage für den Fall, dass vergessen wurde,
   * ein- oder auszustempeln, und deshalb für einen Teil des Tages gar keine
   * Zeit erfasst wurde (siehe addManualIdleTime()); Bearbeiten z.B. um eine
   * falsch eingetragene Uhrzeit zu korrigieren (siehe updateManualIdleTime()
   * in clockActions.ts - verkleinert sich der Zeitraum dabei, bleibt die
   * freiwerdende Zeit als eigener Leerlaufzeit-Eintrag erhalten, statt
   * spurlos zu verschwinden).
   */
  async function submitAddIdle(): Promise<void> {
    if (!addIdleStart || !addIdleEnd || addingIdle) return;
    addingIdle = true;
    try {
      if (editingIdleEntry) {
        await updateManualIdleTime(
          { id: editingIdleEntry.id, date: selectedDate, startTime: editingIdleEntry.startTime, endTime: editingIdleEntry.endTime },
          selectedDate,
          addIdleStart,
          addIdleEnd
        );
      } else {
        await addManualIdleTime(selectedDate, addIdleStart, addIdleEnd);
      }
      addIdleFormOpen = false;
      editingIdleEntry = undefined;
      await reloadDayTimeline();
      await load();
    } finally {
      addingIdle = false;
    }
  }

  const filteredAssignIdleReports = $derived.by(() => {
    const query = assignIdleQuery.trim().toLowerCase();
    if (!query) return assignIdleReports;
    return assignIdleReports.filter(
      (report) =>
        report.projectNumber.toLowerCase().includes(query) || (report.customer ?? '').toLowerCase().includes(query)
    );
  });

  /**
   * Öffnet das "Projekt zuordnen"-Panel für einen Leerlaufzeit-Eintrag (siehe
   * assignIdleEntry oben) - schließt dafür das Zeiten-Bearbeiten-Formular,
   * falls gerade offen (beide Panels ergeben nebeneinander keinen Sinn).
   * Lädt bei jedem Öffnen frisch die Liste der zuordenbaren (nicht
   * gesperrten) Berichte - dieselbe Filterung wie in Leerlaufzeiten.svelte.
   */
  async function openAssignIdlePanel(entry: DayTimelineEntry): Promise<void> {
    closeAddIdleForm();
    closeAddProjectTimeForm();
    assignIdleEntry = entry;
    assignIdleQuery = '';
    assignIdleSelectedReport = undefined;
    assignIdleUseFullRange = true;
    assignIdleWindowStart = entry.startTime ?? '';
    assignIdleWindowEnd = entry.endTime ?? '';
    const all = await listReports('all');
    assignIdleReports = all.filter((report) => !report.finalizedAt);
  }

  function closeAssignIdlePanel(): void {
    assignIdleEntry = undefined;
    assignIdleSelectedReport = undefined;
  }

  /**
   * Ordnet den geöffneten Leerlaufzeit-Eintrag dem gewählten Bericht zu -
   * entweder komplett oder nur für das gewählte Zeitfenster (siehe
   * assignIdleTime() in clockActions.ts, die den Rest bei einer Teil-
   * Zuordnung automatisch als eigene Leerlaufzeit erhält).
   */
  async function confirmAssignIdle(): Promise<void> {
    if (!assignIdleEntry || !assignIdleSelectedReport || assigningIdle) return;
    const windowStart = assignIdleUseFullRange ? (assignIdleEntry.startTime ?? '') : assignIdleWindowStart;
    const windowEnd = assignIdleUseFullRange ? (assignIdleEntry.endTime ?? '') : assignIdleWindowEnd;
    if (!windowStart || !windowEnd || windowStart >= windowEnd) return;
    assigningIdle = true;
    try {
      await assignIdleTime(assignIdleEntry, assignIdleSelectedReport.id, windowStart, windowEnd);
      closeAssignIdlePanel();
      await reloadDayTimeline();
      await load();
    } finally {
      assigningIdle = false;
    }
  }

  const filteredAddProjectTimeReports = $derived.by(() => {
    const query = addProjectTimeQuery.trim().toLowerCase();
    if (!query) return addProjectTimeOpenReports;
    return addProjectTimeOpenReports.filter(
      (report) =>
        report.projectNumber.toLowerCase().includes(query) || (report.customer ?? '').toLowerCase().includes(query)
    );
  });

  /**
   * Öffnet das "Projekt-Zeit hinzufügen"-Panel für den gewählten Tag -
   * schließt dafür das Leerlaufzeit-Formular bzw. "Projekt zuordnen"-Panel,
   * falls offen (ergeben nebeneinander keinen Sinn). Lädt frisch die noch
   * offenen Berichte zur Auswahl (dieselbe Quelle/Filterung wie "Direkt
   * einchecken" in DayClock.svelte).
   */
  async function openAddProjectTimeForm(): Promise<void> {
    closeAddIdleForm();
    closeAssignIdlePanel();
    addProjectTimeFormOpen = true;
    addProjectTimeQuery = '';
    addProjectTimeSelectedReport = undefined;
    addProjectTimeStart = '08:00';
    addProjectTimeEnd = '17:00';
    addProjectTimePauseEnabled = false;
    addProjectTimePauseHours = 0.5;
    addProjectTimeLoadingReports = true;
    addProjectTimeOpenReports = await listReports('open');
    addProjectTimeLoadingReports = false;
  }

  function closeAddProjectTimeForm(): void {
    addProjectTimeFormOpen = false;
    addProjectTimeSelectedReport = undefined;
  }

  /**
   * Legt wie beim "Direkt einchecken"-Schnellzugriff (DayClock.svelte) per
   * Projektnummer-Eingabe einen neuen Bericht an oder verhindert ein
   * Duplikat, falls zu dieser Nummer bereits ein offener Bericht existiert
   * (dann wird der stattdessen ausgewählt) - derselbe
   * startProjectByNumber()-Ablauf, hier aber OHNE einzuchecken: es soll nur
   * eine Zeit nachgetragen werden, ohne den Tagesstempel oder den gerade
   * eingecheckten Bericht zu beeinflussen.
   */
  async function createAddProjectTimeViaPrompt(): Promise<void> {
    if (addingProjectTime) return;
    const projectNumber = prompt('Projektnummer für den neuen Bericht:');
    if (!projectNumber?.trim()) return;
    addingProjectTime = true;
    try {
      const result = await startProjectByNumber(projectNumber, getTechnicianName() || undefined);
      addProjectTimeSelectedReport = result.report;
      if (result.reused) {
        alert(
          `Für Projekt "${result.report.projectNumber}" ist bereits ein offener Bericht vorhanden - die Zeit wird dort nachgetragen.`
        );
      } else if (result.visitTotal > 1) {
        alert(
          `Neuer Bericht für Projekt "${result.report.projectNumber}" angelegt (${result.visitNumber}. Bericht zu diesem Projekt).`
        );
      }
    } finally {
      addingProjectTime = false;
    }
  }

  /** Alternative zum direkten Nachtragen hier: stattdessen in den vollen Bericht springen (z.B. für Notizen/Material/Fotos). */
  function openSelectedProjectReport(): void {
    if (!addProjectTimeSelectedReport) return;
    navigate(`/reports/${addProjectTimeSelectedReport.id}`);
  }

  /**
   * Trägt die Projekt-Zeit für den gewählten Bericht und Tag nach (siehe
   * addManualProjectTime() in clockActions.ts) - inkl. optionaler, mittig
   * platzierter Pause, genau wie im Zeiten-Tab eines Berichts.
   */
  async function submitAddProjectTime(): Promise<void> {
    if (!addProjectTimeSelectedReport || !addProjectTimeStart || !addProjectTimeEnd || addingProjectTime) return;
    addingProjectTime = true;
    try {
      const pauseMinutes = addProjectTimePauseEnabled ? Math.round(addProjectTimePauseHours * 60) : undefined;
      await addManualProjectTime(
        addProjectTimeSelectedReport.id,
        selectedDate,
        addProjectTimeStart,
        addProjectTimeEnd,
        pauseMinutes
      );
      closeAddProjectTimeForm();
      await reloadDayTimeline();
      await load();
    } finally {
      addingProjectTime = false;
    }
  }

  // Soll-Stunden nur nachladen, solange die Monatsansicht aktiv ist -
  // dieselbe view-Gate-Logik wie bei der Projekt-Aufschlüsselung oben.
  $effect(() => {
    if (view !== 'monat') return;
    getMonthTarget(selectedMonth).then((result) => {
      monthTarget = result;
    });
  });

  function calendarRange(): { start: string; end: string } {
    return calendarMode === 'monat'
      ? { start: `${selectedMonth}-01`, end: `${selectedMonth}-${String(daysInMonth(selectedMonth)).padStart(2, '0')}` }
      : { start: selectedWeekStart, end: shiftDate(selectedWeekStart, 6) };
  }

  async function reloadCalendarAbsences(): Promise<void> {
    const range = calendarRange();
    calendarAbsences = await listAbsencesInRange(range.start, range.end);
  }

  // Abwesenheiten für den sichtbaren Kalender-Zeitraum (Monat oder Woche)
  // nachladen - dieselbe view-Gate-Logik wie oben.
  $effect(() => {
    if (view !== 'kalender') return;
    void reloadCalendarAbsences();
  });

  // Wechselt sich der sichtbare Zeitraum (Monat-/Wochennavigation, Monat-
  // /Woche-Umschalter), schließt das Tages-Panel - sonst würde es einen Tag
  // zeigen, der gar nicht mehr im sichtbaren Raster ist.
  $effect(() => {
    calendarMode;
    selectedMonth;
    selectedWeekStart;
    selectedCalendarDate = undefined;
  });

  // Lädt die Projekt-Aufschlüsselung für den im Kalender aufgeklappten Tag -
  // dasselbe Muster wie oben für die Tag-Ansicht.
  $effect(() => {
    if (view !== 'kalender' || !selectedCalendarDate) {
      calendarDayBreakdown = [];
      return;
    }
    getDayProjectBreakdown(selectedCalendarDate).then((result) => {
      calendarDayBreakdown = result;
    });
  });

  function emptyStats(date: string): DayStats {
    return { date, productiveMinutes: 0, idleMinutes: 0, totalMinutes: 0 };
  }

  function sumStats(list: DayStats[]): DayStats {
    return list.reduce(
      (acc, d) => ({
        date: '',
        productiveMinutes: acc.productiveMinutes + d.productiveMinutes,
        idleMinutes: acc.idleMinutes + d.idleMinutes,
        totalMinutes: acc.totalMinutes + d.totalMinutes
      }),
      emptyStats('')
    );
  }

  function shiftDate(iso: string, deltaDays: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + deltaDays);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  function daysInMonth(ym: string): number {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }

  function shiftMonth(ym: string, deltaMonths: number): string {
    const [y, m] = ym.split('-').map(Number);
    const total = y * 12 + (m - 1) + deltaMonths;
    const yy = Math.floor(total / 12);
    const mm = (total % 12) + 1;
    return `${yy}-${String(mm).padStart(2, '0')}`;
  }

  function formatDateLongDE(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('de-DE', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  }

  function formatMonthDE(ym: string): string {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  }

  function formatMonthShortDE(ym: string): string {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('de-DE', { month: 'short' });
  }

  /** Formatiert eine Kalenderwoche als "10.–16. Aug 2026" (Montag bis Sonntag). */
  function formatWeekRangeDE(start: string): string {
    const end = shiftDate(start, 6);
    const [sy, sm, sd] = start.split('-').map(Number);
    const [ey, em, ed] = end.split('-').map(Number);
    const startLabel = new Date(sy, sm - 1, sd).toLocaleDateString('de-DE', { day: '2-digit' });
    const endLabel = new Date(ey, em - 1, ed).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
    return `${startLabel}.–${endLabel}`;
  }

  function productivePercent(stats: DayStats): number {
    if (stats.totalMinutes <= 0) return 0;
    return Math.round((stats.productiveMinutes / stats.totalMinutes) * 100);
  }

  /** Formatiert eine Minuten-Differenz mit vorangestelltem Vorzeichen, z.B. "+3:15 Std." oder "-1:30 Std.". */
  function formatDiffMinutes(diffMinutes: number): string {
    const sign = diffMinutes < 0 ? '-' : '+';
    return `${sign}${formatDurationMinutes(Math.abs(diffMinutes))}`;
  }

  const dayStat = $derived.by(() => dayStats.find((d) => d.date === selectedDate) ?? emptyStats(selectedDate));

  const monthDays = $derived.by(() =>
    dayStats.filter((d) => d.date.startsWith(selectedMonth)).sort((a, b) => a.date.localeCompare(b.date))
  );
  const monthTotal = $derived.by(() => sumStats(monthDays));

  const yearMonths = $derived.by(() => {
    const map = new Map<string, DayStats>();
    for (const d of dayStats) {
      if (!d.date.startsWith(String(selectedYear))) continue;
      const ym = d.date.slice(0, 7);
      let stats = map.get(ym);
      if (!stats) {
        stats = emptyStats(ym);
        map.set(ym, stats);
      }
      stats.productiveMinutes += d.productiveMinutes;
      stats.idleMinutes += d.idleMinutes;
      stats.totalMinutes += d.totalMinutes;
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  });
  const yearTotal = $derived.by(() => sumStats(yearMonths));

  // Monatsraster für die Kalender-Ansicht: führende `null`-Zellen füllen die
  // erste Woche auf Montag-Start auf (typisches Kalenderlayout), danach ein
  // Eintrag pro Tag des Monats. Keine trainierenden Blindzellen am Ende -
  // die letzte Reihe darf im CSS-Grid einfach kürzer enden.
  const calendarMonthCells = $derived.by((): (CalendarCell | null)[] => {
    if (view !== 'kalender' || calendarMode !== 'monat') return [];
    const [year, month] = selectedMonth.split('-').map(Number);
    const totalDays = daysInMonth(selectedMonth);
    const firstWeekday = new Date(year, month - 1, 1).getDay(); // 0=So, 1=Mo, ...
    const leadingBlanks = firstWeekday === 0 ? 6 : firstWeekday - 1;

    const absenceByDate = new Map(calendarAbsences.map((a) => [a.date, a.type]));
    const statsByDate = new Map(dayStats.map((d) => [d.date, d]));
    const holidays = getGermanHolidays(year, getBundesland());

    const cells: (CalendarCell | null)[] = Array.from({ length: leadingBlanks }, () => null);
    for (let day = 1; day <= totalDays; day++) {
      const date = `${selectedMonth}-${String(day).padStart(2, '0')}`;
      cells.push({
        date,
        dayOfMonth: day,
        status: computeDayStatus({
          date,
          isHoliday: holidays.has(date),
          absenceType: absenceByDate.get(date),
          hasBookedTime: (statsByDate.get(date)?.totalMinutes ?? 0) > 0
        })
      });
    }
    return cells;
  });

  // Wochenraster: immer genau 7 Tage ab selectedWeekStart (Montag). Kann über
  // einen Jahreswechsel laufen (z.B. 29.12.-04.01.) - Feiertage für beide
  // betroffenen Jahre laden und zusammenführen.
  const calendarWeekCells = $derived.by((): CalendarCell[] => {
    if (view !== 'kalender' || calendarMode !== 'woche') return [];
    const absenceByDate = new Map(calendarAbsences.map((a) => [a.date, a.type]));
    const statsByDate = new Map(dayStats.map((d) => [d.date, d]));

    const bundesland = getBundesland();
    const startYear = Number(selectedWeekStart.slice(0, 4));
    const endYear = Number(shiftDate(selectedWeekStart, 6).slice(0, 4));
    const holidays = getGermanHolidays(startYear, bundesland);
    if (endYear !== startYear) {
      for (const [date, name] of getGermanHolidays(endYear, bundesland)) holidays.set(date, name);
    }

    const cells: CalendarCell[] = [];
    for (let i = 0; i < 7; i++) {
      const date = shiftDate(selectedWeekStart, i);
      cells.push({
        date,
        dayOfMonth: Number(date.slice(8, 10)),
        status: computeDayStatus({
          date,
          isHoliday: holidays.has(date),
          absenceType: absenceByDate.get(date),
          hasBookedTime: (statsByDate.get(date)?.totalMinutes ?? 0) > 0
        })
      });
    }
    return cells;
  });

  const selectedCalendarDayStat = $derived.by(() =>
    selectedCalendarDate
      ? (dayStats.find((d) => d.date === selectedCalendarDate) ?? emptyStats(selectedCalendarDate))
      : emptyStats('')
  );

  const selectedCalendarCell = $derived.by((): CalendarCell | undefined => {
    if (!selectedCalendarDate) return undefined;
    const cells = calendarMode === 'monat' ? calendarMonthCells : calendarWeekCells;
    return cells.find((cell) => cell?.date === selectedCalendarDate) ?? undefined;
  });

  /** Klappt die gestempelten Einzelzeiten eines Projekts in einer Projekt-Aufschlüsselung auf/zu. */
  function toggleProjectExpanded(set: Set<ID>, reportId: ID): void {
    if (set.has(reportId)) {
      set.delete(reportId);
    } else {
      set.add(reportId);
    }
  }

  function openDay(date: string): void {
    selectedDate = date;
    view = 'tag';
  }

  function openMonth(ym: string): void {
    selectedMonth = ym;
    view = 'monat';
  }

  /** Klappt die Tages-Infos im Kalender-Tab auf/zu (erneutes Antippen desselben Tages klappt wieder zu). */
  function selectCalendarDay(date: string): void {
    selectedCalendarDate = selectedCalendarDate === date ? undefined : date;
  }

  /**
   * Setzt/wechselt/entfernt die Abwesenheit für einen Tag direkt aus dem
   * Kalender heraus. Bewusst ohne die "schon Zeiten erfasst?"-Rückfrage aus
   * Abwesenheiten.svelte: die Schnellerfassung ist nur für Tage mit Status
   * 'open' oder bereits vorhandener Abwesenheit sichtbar (s. QUICK_ABSENCE_
   * STATUSES) - beides schließt bereits gebuchte Zeit aus (siehe
   * computeDayStatus()-Priorität), die Rückfrage kann also nie greifen.
   */
  async function quickToggleAbsence(date: string, type: AbsenceType): Promise<void> {
    const existing = calendarAbsences.find((a) => a.date === date);
    if (existing?.type === type) {
      await removeAbsence(date);
    } else {
      await setAbsence(date, type);
    }
    await reloadCalendarAbsences();
  }
</script>

<div class="screen">
  <header class="header">
    <button type="button" class="back" onclick={() => navigate('/')} aria-label="Zurück zur Übersicht"><Icon name="back" /></button>
    <h1>Auswertung</h1>
  </header>

  <div class="tabs" role="tablist" aria-label="Zeitraum wählen">
    <button type="button" class:active={view === 'tag'} onclick={() => (view = 'tag')}>Tag</button>
    <button type="button" class:active={view === 'monat'} onclick={() => (view = 'monat')}>Monat</button>
    <button type="button" class:active={view === 'jahr'} onclick={() => (view = 'jahr')}>Jahr</button>
    <button type="button" class:active={view === 'kalender'} onclick={() => (view = 'kalender')}>Kalender</button>
  </div>

  <div class="content">
    {#if loading}
      <p class="hint">Lade Statistik…</p>
    {:else if view === 'tag'}
      <div class="nav">
        <button type="button" onclick={() => (selectedDate = shiftDate(selectedDate, -1))} aria-label="Vorheriger Tag">
          <Icon name="chevron-left" />
        </button>
        <button type="button" class="nav-label" onclick={() => (selectedDate = today)}>
          {formatDateLongDE(selectedDate)}
        </button>
        <button type="button" onclick={() => (selectedDate = shiftDate(selectedDate, 1))} aria-label="Nächster Tag">
          <Icon name="chevron-right" />
        </button>
      </div>

      {#if dayStat.totalMinutes === 0}
        <p class="empty">Keine Zeiten erfasst für diesen Tag.</p>
      {:else}
        {@render statsCardSnippet(dayStat)}
      {/if}

      <div class="projects">
        <p class="section-title">Zeitverlauf</p>
        {#if dayTimeline.length > 0}
          <ul class="breakdown">
            {#each dayTimeline as entry (entry.id)}
              {@const exceedsMax = exceedsMaxDailyWork(entry.minutes)}
              <li class="timeline-row kind-{entry.kind}" class:exceeds-max={exceedsMax}>
                {#if entry.kind === 'project'}
                  <button type="button" class="entry-main" onclick={() => navigate(`/reports/${entry.reportId}`)}>
                    {@render timelineRowContentSnippet(entry, exceedsMax)}
                  </button>
                {:else if entry.kind === 'idle'}
                  <button type="button" class="entry-main" onclick={() => startEditIdle(entry)}>
                    {@render timelineRowContentSnippet(entry, exceedsMax)}
                  </button>
                {:else}
                  <div class="entry-main static">
                    {@render timelineRowContentSnippet(entry, exceedsMax)}
                  </div>
                {/if}
                {#if entry.kind === 'idle'}
                  <button
                    type="button"
                    class="assign-entry"
                    onclick={() => openAssignIdlePanel(entry)}
                    aria-label="Leerlaufzeit einem Projekt zuordnen"
                  >
                    <Icon name="corner-down-right" size={16} />
                  </button>
                  <button type="button" class="remove-entry" onclick={() => removeIdleEntry(entry.id)} aria-label="Leerlaufzeit löschen">
                    <Icon name="trash" size={16} />
                  </button>
                {:else if entry.kind === 'break'}
                  <button type="button" class="remove-entry" onclick={() => removeBreak(entry.id)} aria-label="Pause löschen">
                    <Icon name="trash" size={16} />
                  </button>
                {/if}
              </li>
              {#if assignIdleEntry?.id === entry.id}
                <li class="add-entry-form assign-idle-panel">
                  {#if !assignIdleSelectedReport}
                    <input
                      type="search"
                      bind:value={assignIdleQuery}
                      placeholder="Projekt suchen (Projektnummer, Kunde)…"
                      aria-label="Projekt suchen"
                    />
                    {#if filteredAssignIdleReports.length === 0}
                      <p class="hint small">Keine passenden Berichte gefunden.</p>
                    {:else}
                      <ul class="picker-list">
                        {#each filteredAssignIdleReports as report (report.id)}
                          <li>
                            <button type="button" onclick={() => (assignIdleSelectedReport = report)}>
                              <strong>{report.projectNumber}</strong>
                              {#if report.customer}<span> · {report.customer}</span>{/if}
                            </button>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                    <div class="add-entry-actions">
                      <button type="button" class="cancel" onclick={closeAssignIdlePanel}>Abbrechen</button>
                    </div>
                  {:else}
                    <p class="assign-target">
                      Zuordnen zu <strong>{assignIdleSelectedReport.projectNumber}</strong>{#if assignIdleSelectedReport.customer}
                        · {assignIdleSelectedReport.customer}{/if}
                    </p>
                    <div class="assign-range-toggle" role="tablist" aria-label="Zeitraum wählen">
                      <button type="button" class:active={assignIdleUseFullRange} onclick={() => (assignIdleUseFullRange = true)}>
                        Komplette Zeit ({entry.startTime}–{entry.endTime})
                      </button>
                      <button type="button" class:active={!assignIdleUseFullRange} onclick={() => (assignIdleUseFullRange = false)}>
                        Zeitfenster wählen
                      </button>
                    </div>
                    {#if !assignIdleUseFullRange}
                      <div class="entry-time-row">
                        <input
                          type="time"
                          bind:value={assignIdleWindowStart}
                          min={entry.startTime}
                          max={entry.endTime}
                          aria-label="Zuordnung von"
                        />
                        <span>–</span>
                        <input
                          type="time"
                          bind:value={assignIdleWindowEnd}
                          min={entry.startTime}
                          max={entry.endTime}
                          aria-label="Zuordnung bis"
                        />
                      </div>
                    {/if}
                    <div class="add-entry-actions">
                      <button type="button" class="cancel" onclick={() => (assignIdleSelectedReport = undefined)}>
                        Anderes Projekt
                      </button>
                      <button type="button" class="primary" onclick={confirmAssignIdle} disabled={assigningIdle}>Zuordnen</button>
                    </div>
                  {/if}
                </li>
              {/if}
            {/each}
          </ul>
        {/if}

        <div class="timeline-add-actions">
          {#if addProjectTimeFormOpen}
            <div class="add-entry-form project-time-panel">
              {#if !addProjectTimeSelectedReport}
                <input
                  type="search"
                  bind:value={addProjectTimeQuery}
                  placeholder="Offenen Bericht suchen (Projektnummer, Kunde)…"
                  aria-label="Offenen Bericht suchen"
                />
                {#if addProjectTimeLoadingReports}
                  <p class="hint small">Lade offene Berichte…</p>
                {:else if filteredAddProjectTimeReports.length === 0}
                  <p class="hint small">
                    {addProjectTimeOpenReports.length === 0
                      ? 'Keine offenen Berichte vorhanden.'
                      : 'Keine passenden Berichte gefunden.'}
                  </p>
                {:else}
                  <ul class="picker-list">
                    {#each filteredAddProjectTimeReports as report (report.id)}
                      <li>
                        <button type="button" onclick={() => (addProjectTimeSelectedReport = report)}>
                          <strong>{report.projectNumber}</strong>
                          {#if report.customer}<span> · {report.customer}</span>{/if}
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
                <div class="add-entry-actions">
                  <button type="button" class="new-report" onclick={createAddProjectTimeViaPrompt} disabled={addingProjectTime}>
                    + Neuen Bericht anlegen
                  </button>
                  <button type="button" class="cancel" onclick={closeAddProjectTimeForm}>Abbrechen</button>
                </div>
              {:else}
                <div class="project-time-header">
                  <p class="assign-target">
                    Zeit für <strong>{addProjectTimeSelectedReport.projectNumber}</strong>{#if addProjectTimeSelectedReport.customer}
                      · {addProjectTimeSelectedReport.customer}{/if}
                  </p>
                  <button type="button" class="open-report-link" onclick={openSelectedProjectReport}>→ Projekt öffnen</button>
                </div>
                <div class="entry-time-row">
                  <input type="time" bind:value={addProjectTimeStart} aria-label="Projekt-Zeit von" />
                  <span>–</span>
                  <input type="time" bind:value={addProjectTimeEnd} aria-label="Projekt-Zeit bis" />
                </div>
                <label class="pause-toggle">
                  <input type="checkbox" bind:checked={addProjectTimePauseEnabled} />
                  Pause abziehen
                </label>
                {#if addProjectTimePauseEnabled}
                  <div class="pause-hours-row">
                    <span>Pause (Std.)</span>
                    <input type="number" inputmode="decimal" step="0.25" min="0.25" bind:value={addProjectTimePauseHours} />
                  </div>
                {/if}
                <div class="add-entry-actions">
                  <button type="button" class="cancel" onclick={() => (addProjectTimeSelectedReport = undefined)}>
                    Anderes Projekt
                  </button>
                  <button type="button" class="primary" onclick={submitAddProjectTime} disabled={addingProjectTime}>
                    Speichern
                  </button>
                </div>
              {/if}
            </div>
          {:else}
            <button type="button" class="add-entry-toggle" onclick={openAddProjectTimeForm}>+ Projekt-Zeit hinzufügen</button>
          {/if}

          {#if addIdleFormOpen}
            <div class="add-entry-form">
              <div class="entry-time-row">
                <input type="time" bind:value={addIdleStart} aria-label="Leerlaufzeit von" />
                <span>–</span>
                <input type="time" bind:value={addIdleEnd} aria-label="Leerlaufzeit bis" />
              </div>
              <div class="add-entry-actions">
                <button type="button" class="cancel" onclick={closeAddIdleForm}>Abbrechen</button>
                <button type="button" class="primary" onclick={submitAddIdle} disabled={addingIdle}>Speichern</button>
              </div>
            </div>
          {:else}
            <button type="button" class="add-entry-toggle" onclick={openAddIdleForm}>+ Leerlaufzeit hinzufügen</button>
          {/if}

          {#if addBreakFormOpen}
            <div class="add-entry-form">
              <div class="entry-time-row">
                <input type="time" bind:value={addBreakStart} aria-label="Pause von" />
                <span>–</span>
                <input type="time" bind:value={addBreakEnd} aria-label="Pause bis" />
              </div>
              <div class="add-entry-actions">
                <button type="button" class="cancel" onclick={closeAddBreakForm}>Abbrechen</button>
                <button type="button" class="primary" onclick={submitAddBreak} disabled={addingBreak}>Speichern</button>
              </div>
            </div>
          {:else}
            <button type="button" class="add-entry-toggle" onclick={openAddBreakForm}>+ Pause hinzufügen</button>
          {/if}
        </div>
      </div>
    {:else if view === 'monat'}
      <div class="nav">
        <button
          type="button"
          onclick={() => (selectedMonth = shiftMonth(selectedMonth, -1))}
          aria-label="Vorheriger Monat"
        >
          <Icon name="chevron-left" />
        </button>
        <button type="button" class="nav-label" onclick={() => (selectedMonth = today.slice(0, 7))}>
          {formatMonthDE(selectedMonth)}
        </button>
        <button type="button" onclick={() => (selectedMonth = shiftMonth(selectedMonth, 1))} aria-label="Nächster Monat">
          <Icon name="chevron-right" />
        </button>
      </div>

      {#if monthTarget.workingDays > 0}
        {@render targetCardSnippet(monthTarget, monthTotal)}
      {/if}

      {#if monthTotal.totalMinutes === 0}
        <p class="empty">Keine Zeiten erfasst für diesen Monat.</p>
      {:else}
        {@render statsCardSnippet(monthTotal)}
        <ul class="breakdown">
          {#each monthDays as day (day.date)}
            <li>
              <button type="button" class="breakdown-row" onclick={() => openDay(day.date)}>
                <span class="breakdown-label">{formatDateLongDE(day.date)}</span>
                <span class="breakdown-values">
                  <span class="productive">{formatDurationMinutes(day.productiveMinutes)}</span>
                  <span class="idle">{formatDurationMinutes(day.idleMinutes)}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if view === 'jahr'}
      <div class="nav">
        <button type="button" onclick={() => (selectedYear -= 1)} aria-label="Vorheriges Jahr"><Icon name="chevron-left" /></button>
        <button type="button" class="nav-label" onclick={() => (selectedYear = Number(today.slice(0, 4)))}>
          {selectedYear}
        </button>
        <button type="button" onclick={() => (selectedYear += 1)} aria-label="Nächstes Jahr"><Icon name="chevron-right" /></button>
      </div>

      {#if yearTotal.totalMinutes === 0}
        <p class="empty">Keine Zeiten erfasst für dieses Jahr.</p>
      {:else}
        {@render statsCardSnippet(yearTotal)}
        <ul class="breakdown">
          {#each yearMonths as month (month.date)}
            <li>
              <button type="button" class="breakdown-row" onclick={() => openMonth(month.date)}>
                <span class="breakdown-label">{formatMonthShortDE(month.date)}</span>
                <span class="breakdown-values">
                  <span class="productive">{formatDurationMinutes(month.productiveMinutes)}</span>
                  <span class="idle">{formatDurationMinutes(month.idleMinutes)}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {:else}
      <div class="calendar-toggle" role="tablist" aria-label="Kalender-Ansicht wählen">
        <button type="button" class:active={calendarMode === 'monat'} onclick={() => (calendarMode = 'monat')}>
          Monat
        </button>
        <button type="button" class:active={calendarMode === 'woche'} onclick={() => (calendarMode = 'woche')}>
          Woche
        </button>
      </div>

      {#if calendarMode === 'monat'}
        <div class="nav">
          <button
            type="button"
            onclick={() => (selectedMonth = shiftMonth(selectedMonth, -1))}
            aria-label="Vorheriger Monat"
          >
            <Icon name="chevron-left" />
          </button>
          <button type="button" class="nav-label" onclick={() => (selectedMonth = today.slice(0, 7))}>
            {formatMonthDE(selectedMonth)}
          </button>
          <button
            type="button"
            onclick={() => (selectedMonth = shiftMonth(selectedMonth, 1))}
            aria-label="Nächster Monat"
          >
            <Icon name="chevron-right" />
          </button>
        </div>

        <div class="calendar-grid">
          {#each WEEKDAY_LABELS as label (label)}
            <div class="calendar-weekday">{label}</div>
          {/each}
          {#each calendarMonthCells as cell, i (cell?.date ?? `blank-${i}`)}
            {#if cell}
              <button
                type="button"
                class="calendar-cell"
                class:today={cell.date === today}
                class:selected={cell.date === selectedCalendarDate}
                style:background={STATUS_BG[cell.status]}
                style:color={STATUS_FG[cell.status]}
                onclick={() => selectCalendarDay(cell.date)}
                aria-label="{formatDateLongDE(cell.date)}: {STATUS_LABELS[cell.status]}"
              >
                {cell.dayOfMonth}
              </button>
            {:else}
              <div class="calendar-cell blank" aria-hidden="true"></div>
            {/if}
          {/each}
        </div>
      {:else}
        <div class="nav">
          <button
            type="button"
            onclick={() => (selectedWeekStart = shiftDate(selectedWeekStart, -7))}
            aria-label="Vorherige Woche"
          >
            <Icon name="chevron-left" />
          </button>
          <button type="button" class="nav-label" onclick={() => (selectedWeekStart = startOfWeekISO(today))}>
            {formatWeekRangeDE(selectedWeekStart)}
          </button>
          <button
            type="button"
            onclick={() => (selectedWeekStart = shiftDate(selectedWeekStart, 7))}
            aria-label="Nächste Woche"
          >
            <Icon name="chevron-right" />
          </button>
        </div>

        <div class="calendar-grid">
          {#each WEEKDAY_LABELS as label (label)}
            <div class="calendar-weekday">{label}</div>
          {/each}
          {#each calendarWeekCells as cell (cell.date)}
            <button
              type="button"
              class="calendar-cell"
              class:today={cell.date === today}
              class:selected={cell.date === selectedCalendarDate}
              style:background={STATUS_BG[cell.status]}
              style:color={STATUS_FG[cell.status]}
              onclick={() => selectCalendarDay(cell.date)}
              aria-label="{formatDateLongDE(cell.date)}: {STATUS_LABELS[cell.status]}"
            >
              {cell.dayOfMonth}
            </button>
          {/each}
        </div>
      {/if}

      {#if selectedCalendarDate}
        {@const date = selectedCalendarDate}
        {@const cell = selectedCalendarCell}
        <div class="day-panel">
          <div class="day-panel-header">
            <p class="day-panel-title">{formatDateLongDE(date)}</p>
            <button
              type="button"
              class="day-panel-close"
              onclick={() => (selectedCalendarDate = undefined)}
              aria-label="Tages-Infos schließen"
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          {#if selectedCalendarDayStat.totalMinutes > 0}
            {@render statsCardSnippet(selectedCalendarDayStat)}
            {#if calendarDayBreakdown.length > 0}
              {@render projectBreakdownSnippet(calendarDayBreakdown, expandedCalendarProjects)}
            {/if}
            <button type="button" class="day-panel-link" onclick={() => openDay(date)}>Vollständige Tagesansicht öffnen</button>
          {:else if cell?.status === 'holiday'}
            <p class="hint small">Feiertag, keine Zeiten erfasst.</p>
          {:else if cell?.status === 'weekend'}
            <p class="hint small">Wochenende, keine Zeiten erfasst.</p>
          {:else}
            <p class="hint small">Keine Zeiten erfasst.</p>
          {/if}

          {#if cell && QUICK_ABSENCE_STATUSES.includes(cell.status)}
            <div class="type-select" role="radiogroup" aria-label="Abwesenheit für diesen Tag">
              {#each ABSENCE_TYPES as type (type)}
                <button
                  type="button"
                  role="radio"
                  aria-checked={cell.status === type}
                  class:active={cell.status === type}
                  onclick={() => quickToggleAbsence(date, type)}
                >
                  <Icon name={ABSENCE_ICONS[type]} />
                  <span>{STATUS_LABELS[type]}</span>
                </button>
              {/each}
            </div>
            <p class="hint small">Antippen zum Eintragen, erneutes Antippen des aktiven Eintrags entfernt ihn wieder.</p>
          {/if}
        </div>
      {/if}

      <ul class="legend">
        {#each LEGEND_STATUSES as status (status)}
          <li>
            <span class="legend-dot" style:background={STATUS_FG[status]}></span>
            {STATUS_LABELS[status]}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

{#snippet targetCardSnippet(target: MonthTarget, actual: DayStats)}
  {@const effectiveIstMinutes = actual.totalMinutes + target.creditedAbsenceMinutes}
  <div class="stats-card">
    <div class="stats">
      <div class="stat"><strong>{formatDurationMinutes(target.targetMinutes)}</strong><span>Soll</span></div>
      <div class="stat"><strong>{formatDurationMinutes(effectiveIstMinutes)}</strong><span>Ist</span></div>
      <div
        class="stat"
        class:diff-positive={effectiveIstMinutes >= target.targetMinutes}
        class:diff-negative={effectiveIstMinutes < target.targetMinutes}
      >
        <strong>{formatDiffMinutes(effectiveIstMinutes - target.targetMinutes)}</strong><span>Differenz</span>
      </div>
    </div>
    {#if target.creditedAbsenceDays > 0}
      <p class="credit-caption">
        davon {target.creditedAbsenceDays}
        {target.creditedAbsenceDays === 1 ? 'Urlaubs-/Kranktag' : 'Urlaubs-/Kranktage'} angerechnet ({formatDurationMinutes(
          target.creditedAbsenceMinutes
        )})
      </p>
    {/if}
  </div>
{/snippet}

{#snippet statsCardSnippet(stats: DayStats)}
  <div class="stats-card">
    <div class="stats">
      <div class="stat"><strong>{formatDurationMinutes(stats.totalMinutes)}</strong><span>Gesamt</span></div>
      <div class="stat productive-stat">
        <strong>{formatDurationMinutes(stats.productiveMinutes)}</strong><span>Produktiv</span>
      </div>
      <div class="stat idle-stat">
        <strong>{formatDurationMinutes(stats.idleMinutes)}</strong><span>Leerlaufzeit</span>
      </div>
    </div>
    <div class="split-bar" role="img" aria-label="{productivePercent(stats)}% produktiv">
      <span class="split-productive" style:width="{productivePercent(stats)}%"></span>
      <span class="split-idle" style:width="{100 - productivePercent(stats)}%"></span>
    </div>
    <p class="split-caption">{productivePercent(stats)}% produktiv</p>
  </div>
{/snippet}

{#snippet timelineRowContentSnippet(entry: DayTimelineEntry, exceedsMax: boolean)}
  <span class="timeline-info">
    <span class="timeline-time">
      {entry.startTime}–{entry.endTime} Uhr
      {#if exceedsMax}
        <span class="max-hint" title="Überschreitet die gesetzliche Höchstarbeitszeit (10 Std./Tag) - bitte prüfen.">
          <Icon name="alert-triangle" size={13} />
        </span>
      {/if}
    </span>
    <span class="timeline-label">
      {#if entry.kind === 'project'}
        {entry.projectNumber}{#if entry.customer} · {entry.customer}{/if}
      {:else if entry.kind === 'idle'}
        Leerlaufzeit
      {:else}
        Pause
      {/if}
    </span>
  </span>
  <span class="timeline-duration kind-{entry.kind}">{formatDurationMinutes(entry.minutes)}</span>
{/snippet}

{#snippet projectBreakdownSnippet(breakdown: DayProjectBreakdown[], expanded: Set<ID>)}
  <ul class="breakdown">
    {#each breakdown as project (project.reportId)}
      {@const isExpanded = expanded.has(project.reportId)}
      <li>
        <div class="breakdown-item">
          <button type="button" class="breakdown-row" onclick={() => navigate(`/reports/${project.reportId}`)}>
            <span class="breakdown-label plain">
              {project.projectNumber}{#if project.customer} · {project.customer}{/if}
            </span>
            <span class="breakdown-values">
              <span class="productive">{formatDurationMinutes(project.minutes)}</span>
            </span>
          </button>
          <button
            type="button"
            class="breakdown-expand"
            class:expanded={isExpanded}
            onclick={() => toggleProjectExpanded(expanded, project.reportId)}
            aria-expanded={isExpanded}
            aria-label="{isExpanded ? 'Gestempelte Zeiten einklappen' : 'Gestempelte Zeiten anzeigen'} für {project.projectNumber}"
          >
            <Icon name="chevron-down" size={16} />
          </button>
        </div>
        {#if isExpanded}
          <ul class="entry-list">
            {#each project.entries as entry (entry.id)}
              {@const exceedsMax = exceedsMaxDailyWork(entry.minutes)}
              <li class="entry-row" class:exceeds-max={exceedsMax}>
                <span>
                  {entry.startTime ?? '?'}–{entry.endTime ?? '?'} Uhr
                  {#if exceedsMax}
                    <span class="max-hint" title="Überschreitet die gesetzliche Höchstarbeitszeit (10 Std./Tag) - bitte prüfen.">
                      <Icon name="alert-triangle" size={13} />
                    </span>
                  {/if}
                </span>
                <span class="productive">{formatDurationMinutes(entry.minutes)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<style>
  .screen {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: calc(var(--space-3) + var(--safe-top)) var(--space-3) var(--space-3);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
  }

  .header h1 {
    flex: 1;
    margin: 0;
    font-size: 1.1rem;
  }

  .back {
    background: transparent;
    border: none;
    font-size: 1.2rem;
    padding: var(--space-2);
    min-height: auto;
  }

  .tabs {
    display: flex;
    border-bottom: 1px solid var(--color-border);
    padding: 0 var(--space-2);
    background: var(--color-surface);
  }

  .tabs button {
    flex: 1;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    padding: var(--space-3);
    color: var(--color-text-muted);
    font-weight: 600;
    min-height: auto;
  }

  .tabs button.active {
    color: var(--color-primary);
    border-bottom-color: var(--color-primary);
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-4);
    padding-bottom: calc(var(--space-6) + var(--safe-bottom));
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .nav {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .nav > button:first-child,
  .nav > button:last-child {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    min-height: 40px;
    width: 40px;
    font-size: 1.1rem;
  }

  .nav-label {
    flex: 1;
    background: transparent;
    border: none;
    font-weight: 700;
    font-size: 1.05rem;
    text-align: center;
    text-transform: capitalize;
    min-height: auto;
  }

  .hint,
  .empty {
    color: var(--color-text-muted);
    text-align: center;
    margin-top: var(--space-6);
  }

  .stats-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-2);
  }

  .stat {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .stat strong {
    font-size: 1.05rem;
  }

  .stat span {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .productive-stat strong {
    color: var(--color-completed);
  }

  .idle-stat strong {
    color: var(--color-open);
  }

  .diff-positive strong {
    color: var(--color-completed);
  }

  .diff-negative strong {
    color: var(--color-danger);
  }

  .split-bar {
    display: flex;
    height: 10px;
    border-radius: 999px;
    overflow: hidden;
    background: var(--color-surface-muted);
  }

  .split-productive {
    background: var(--color-completed);
  }

  .split-idle {
    background: var(--color-open);
  }

  .split-caption {
    margin: 0;
    text-align: center;
    font-size: 0.8rem;
    color: var(--color-text-muted);
  }

  .credit-caption {
    margin: 0;
    text-align: center;
    font-size: 0.78rem;
    color: var(--color-vacation);
  }

  .projects {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .section-title {
    margin: 0;
    font-weight: 700;
    font-size: 0.9rem;
    color: var(--color-text-muted);
  }

  .breakdown {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .breakdown > li {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .breakdown-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    text-align: left;
    min-height: auto;
  }

  .breakdown-item {
    display: flex;
    align-items: stretch;
    gap: var(--space-2);
  }

  .breakdown-item .breakdown-row {
    flex: 1;
  }

  .breakdown-expand {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text-muted);
    min-height: auto;
    transition: transform 0.15s ease;
  }

  .breakdown-expand.expanded {
    transform: rotate(180deg);
  }

  .entry-list {
    list-style: none;
    margin: 0;
    padding: var(--space-2) var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    background: var(--color-surface-muted);
    border-radius: var(--radius-md);
  }

  .entry-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    font-size: 0.82rem;
    color: var(--color-text-muted);
  }

  .entry-row .productive {
    color: var(--color-completed);
    font-weight: 600;
  }

  .entry-row.exceeds-max {
    background: var(--color-danger-bg);
    color: var(--color-danger);
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-2);
    margin: 0 calc(var(--space-2) * -1);
  }

  .entry-row .max-hint {
    display: inline-flex;
    color: var(--color-danger);
    vertical-align: -2px;
  }

  /* Ein Zeitverlauf-Eintrag (Projekt/Leerlaufzeit/Pause chronologisch
     gemischt) - Karte im gewohnten Look (Fläche/Rahmen/Radius/Padding), plus
     ein farbiger linker Rahmen je nach Art (kind), damit sich die drei Arten auf einen
     Blick unterscheiden lassen, ohne die Zeile extra lesen zu müssen.
     Selektor bewusst "li.timeline-row" (Element + Klasse) statt nur der
     Klasse: ".breakdown > li" weiter oben setzt flex-direction:column mit
     dann höherer bzw. gleicher Spezifität - erst durch denselben
     Spezifitäts-Level ("li" + Klasse) gewinnt hier die spätere Regel
     (flex-direction: row) zuverlässig über die Kaskaden-Reihenfolge. */
  li.timeline-row {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-left: 4px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
  }

  .timeline-row.kind-project {
    border-left-color: var(--color-completed);
  }

  .timeline-row.kind-idle {
    border-left-color: var(--color-open);
  }

  .timeline-row.kind-break {
    border-left-color: var(--color-timeoff);
  }

  .timeline-row.exceeds-max {
    background: var(--color-danger-bg);
    border-left-color: var(--color-danger);
  }

  .timeline-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
  }

  .timeline-time {
    font-weight: 600;
  }

  .timeline-label {
    font-size: 0.8rem;
    color: var(--color-text-muted);
  }

  .timeline-duration {
    font-weight: 600;
    white-space: nowrap;
  }

  .timeline-duration.kind-project {
    color: var(--color-completed);
  }

  .timeline-duration.kind-idle {
    color: var(--color-open);
  }

  .timeline-duration.kind-break {
    color: var(--color-timeoff);
  }

  .timeline-add-actions {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .entry-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex: 1;
    background: transparent;
    border: none;
    padding: 0;
    min-height: auto;
    text-align: left;
    color: inherit;
    font: inherit;
  }

  .remove-entry {
    background: transparent;
    border: none;
    color: var(--color-danger);
    padding: 0 0 0 var(--space-2);
    min-height: auto;
  }

  .assign-entry {
    background: transparent;
    border: none;
    color: var(--color-primary);
    padding: 0 0 0 var(--space-2);
    min-height: auto;
  }

  /* Panel zum Zuordnen einer Leerlaufzeit zu einem Projekt (siehe
     openAssignIdlePanel() oben) - wiederverwendet ".add-entry-form" für den
     Karten-Look, ergänzt hier nur den zweistufigen Inhalt (Projekt-Suche,
     danach Zeitraum-Wahl). */
  .assign-target {
    margin: 0;
  }

  .picker-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-height: 200px;
    overflow-y: auto;
  }

  .picker-list button {
    width: 100%;
    text-align: left;
    background: var(--color-surface-muted);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    min-height: auto;
    font-size: 0.9rem;
  }

  .picker-list button span {
    color: var(--color-text-muted);
  }

  .assign-range-toggle {
    display: flex;
    gap: var(--space-2);
    background: var(--color-surface-muted);
    border-radius: var(--radius-sm);
    padding: 4px;
  }

  .assign-range-toggle button {
    flex: 1;
    background: transparent;
    border: none;
    border-radius: calc(var(--radius-sm) - 2px);
    padding: var(--space-2);
    min-height: auto;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--color-text-muted);
  }

  .assign-range-toggle button.active {
    background: var(--color-surface);
    color: var(--color-text);
    box-shadow: 0 1px 2px var(--color-shadow);
  }

  .add-entry-toggle {
    align-self: flex-start;
    background: transparent;
    border: 1px dashed var(--color-primary);
    color: var(--color-primary);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    min-height: auto;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .add-entry-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
  }

  .entry-time-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .entry-time-row input {
    flex: 1;
  }

  .entry-time-row span {
    color: var(--color-text-muted);
  }

  .add-entry-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .add-entry-actions .cancel {
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    min-height: auto;
  }

  .add-entry-actions .primary {
    background: var(--color-primary);
    color: var(--color-primary-contrast);
    border: none;
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    min-height: auto;
    font-weight: 600;
  }

  .add-entry-actions .new-report {
    background: transparent;
    border: 1px dashed var(--color-primary);
    color: var(--color-primary);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    min-height: auto;
    font-weight: 600;
  }

  .project-time-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .open-report-link {
    background: transparent;
    border: none;
    color: var(--color-primary);
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0;
    min-height: auto;
    white-space: nowrap;
  }

  .pause-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 0.9rem;
  }

  .pause-toggle input[type='checkbox'] {
    width: auto;
    min-height: auto;
  }

  .pause-hours-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 0.85rem;
    color: var(--color-text-muted);
  }

  .pause-hours-row input {
    flex: 1;
  }

  .breakdown-label {
    font-weight: 600;
    text-transform: capitalize;
  }

  .breakdown-label.plain {
    text-transform: none;
  }

  .breakdown-values {
    display: flex;
    gap: var(--space-3);
    font-size: 0.85rem;
    white-space: nowrap;
  }

  .breakdown-values .productive {
    color: var(--color-completed);
  }

  .breakdown-values .idle {
    color: var(--color-open);
  }

  .calendar-toggle {
    display: flex;
    gap: var(--space-2);
    background: var(--color-surface-muted);
    border-radius: var(--radius-sm);
    padding: 4px;
  }

  .calendar-toggle button {
    flex: 1;
    background: transparent;
    border: none;
    border-radius: calc(var(--radius-sm) - 2px);
    padding: var(--space-2);
    min-height: auto;
    font-weight: 600;
    color: var(--color-text-muted);
  }

  .calendar-toggle button.active {
    background: var(--color-surface);
    color: var(--color-text);
    box-shadow: 0 1px 2px var(--color-shadow);
  }

  .calendar-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
  }

  .calendar-weekday {
    text-align: center;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--color-text-muted);
    padding-bottom: 2px;
  }

  .calendar-cell {
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    font-weight: 600;
    min-height: auto;
    padding: 0;
  }

  .calendar-cell.blank {
    background: transparent;
  }

  .calendar-cell.today {
    box-shadow: inset 0 0 0 2px var(--color-primary);
  }

  .calendar-cell.selected {
    box-shadow: inset 0 0 0 2px var(--color-text);
  }

  .calendar-cell.today.selected {
    box-shadow:
      inset 0 0 0 2px var(--color-primary),
      inset 0 0 0 4px var(--color-text);
  }

  .day-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    background: var(--color-surface-muted);
    border-radius: var(--radius-md);
    padding: var(--space-3);
  }

  .day-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .day-panel-title {
    margin: 0;
    font-weight: 700;
  }

  .day-panel-close {
    background: transparent;
    border: none;
    padding: var(--space-1);
    min-height: auto;
    color: var(--color-text-muted);
  }

  .day-panel-link {
    background: transparent;
    border: none;
    padding: 0;
    min-height: auto;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--color-primary);
    text-align: left;
  }

  .hint.small {
    margin: 0;
    font-size: 0.82rem;
  }

  .type-select {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-2);
  }

  .type-select button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-2);
    font-size: 0.78rem;
    color: var(--color-text-muted);
    min-height: auto;
  }

  .type-select button.active {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-primary-contrast);
  }

  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: 0.78rem;
    color: var(--color-text-muted);
  }

  .legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    flex-shrink: 0;
  }
</style>
