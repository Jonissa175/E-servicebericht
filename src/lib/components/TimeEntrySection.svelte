<script lang="ts">
  import {
    addTimeEntry,
    deleteTimeEntry,
    findOverlappingTimeEntries,
    listTimeEntries,
    trimOverlappingTimeEntries
  } from '../db/timeEntries';
  import { getReport, updateReport } from '../db/reports';
  import { addManualBreak, updateManualTimeEntry } from '../clockActions';
  import type { TimeEntry } from '../db/types';
  import { centeredBreakWindow, computeDurationMinutes, formatDateDE, formatDurationMinutes, todayISODate } from '../utils/date';
  import { exceedsMaxDailyWork } from '../utils/arbzg';
  import { appendPerformedWorkLine, formatTimeEntryPerformedWorkLine, shouldAppendPerformedWorkLine } from '../utils/performedWorkNote';
  import Icon from './Icon.svelte';

  let { reportId, locked = false, onChanged }: { reportId: string; locked?: boolean; onChanged: () => void } = $props();

  let entries = $state<TimeEntry[]>([]);
  let loading = $state(true);
  let showForm = $state(false);
  let editingId = $state<string | undefined>();
  // Voller Original-Eintrag beim Bearbeiten (nicht nur die ID) - wird von
  // persistEntry() an clockActions.updateManualTimeEntry() durchgereicht,
  // damit eine manuelle Verkürzung/Verschiebung die freiwerdende Zeit als
  // Leerlaufzeit-Eintrag erhält, statt sie ersatzlos zu überschreiben.
  let editingOriginal = $state<TimeEntry | undefined>();

  let formDate = $state(todayISODate());
  let formStart = $state('');
  let formEnd = $state('');
  let formNote = $state('');
  // "Pause abziehen"-Zusatz beim manuellen Nachtragen (s.u., applyPauseIfNeeded()) -
  // bewusst nur eine Dauer statt eines eigenen Von/Bis-Felderpaars: die genaue
  // Lage interessiert hier meist nicht, es reicht ein grober Vorgabewert
  // (0,5 Std., bei Bedarf änderbar), die Pause wird automatisch mittig in den
  // eingegebenen Zeitraum gelegt.
  let formPauseEnabled = $state(false);
  let formPauseHours = $state(0.5);

  async function load(): Promise<void> {
    loading = true;
    entries = await listTimeEntries(reportId);
    loading = false;
  }

  $effect(() => {
    reportId;
    load();
  });

  const previewDuration = $derived(formStart && formEnd ? computeDurationMinutes(formStart, formEnd) : undefined);

  function resetForm(): void {
    formDate = todayISODate();
    // Vorbelegt mit einem typischen Arbeitstag (8-17 Uhr) statt leer - erspart
    // bei den meisten nachträglichen Buchungen das Eintippen, bleibt aber
    // natürlich frei änderbar.
    formStart = '08:00';
    formEnd = '17:00';
    formNote = '';
    formPauseEnabled = false;
    formPauseHours = 0.5;
    editingId = undefined;
    editingOriginal = undefined;
    showForm = false;
  }

  function startAdd(): void {
    resetForm();
    showForm = true;
  }

  function startEdit(entry: TimeEntry): void {
    editingId = entry.id;
    editingOriginal = entry;
    formDate = entry.date;
    formStart = entry.startTime ?? '';
    formEnd = entry.endTime ?? '';
    formNote = entry.note ?? '';
    // Die "Pause abziehen"-Vorgabe gilt nur fürs Anlegen - beim Bearbeiten
    // unabhängig vom vorherigen Formularzustand immer deaktiviert, damit nicht
    // versehentlich erneut eine Pause aus dem bereits gespeicherten Eintrag
    // herausgeschnitten wird.
    formPauseEnabled = false;
    formPauseHours = 0.5;
    showForm = true;
  }

  /**
   * Eine Zeile pro überschneidendem Eintrag, mit Projektnummer statt
   * Berichts-ID. Ein Eintrag ohne reportId ist entweder Leerlaufzeit oder
   * eine beim Tagesausstempeln erfasste Pause (siehe TimeEntry.isBreak,
   * src/lib/clockActions.ts) - für beide gibt es keinen Bericht zu laden.
   */
  async function describeOverlaps(overlaps: TimeEntry[]): Promise<string> {
    const lines = await Promise.all(
      overlaps.map(async (entry) => {
        const label = entry.isBreak
          ? 'Pause'
          : entry.reportId
            ? ((await getReport(entry.reportId))?.projectNumber ?? 'unbekannter Bericht')
            : 'Leerlaufzeit';
        return `• "${label}" ${entry.startTime}–${entry.endTime} Uhr`;
      })
    );
    return lines.join('\n');
  }

  async function persistEntry(payload: { date: string; startTime?: string; endTime?: string; note: string }): Promise<void> {
    if (editingId && editingOriginal) {
      await updateManualTimeEntry(editingOriginal, payload);
    } else {
      await addTimeEntry(reportId, payload);
    }
  }

  /**
   * Schneidet bei Bedarf die per Checkbox aktivierte Pause aus dem gerade
   * gespeicherten Zeitraum heraus (siehe centeredBreakWindow() oben) - nutzt
   * addManualBreak() (clockActions.ts), das dafür ohnehin schon die
   * überschneidenden Einträge (hier: der eben gespeicherte Eintrag selbst)
   * kürzt/splittet und einen eigenen, als Pause markierten Eintrag anlegt.
   */
  async function applyPauseIfNeeded(startTime: string | undefined, endTime: string | undefined): Promise<void> {
    if (!formPauseEnabled || !startTime || !endTime) return;
    const breakMinutes = Math.round(formPauseHours * 60);
    const window = centeredBreakWindow(startTime, endTime, breakMinutes);
    if (!window) return;
    await addManualBreak(formDate, window.start, window.end);
  }

  async function save(): Promise<void> {
    if (!formDate) return;
    const startTime = formStart || undefined;
    const endTime = formEnd || undefined;
    const payload = { date: formDate, startTime, endTime, note: formNote };

    // Nur beim ERSTMALIGEN Ausfüllen einer bisher leeren Notiz (neuer
    // Eintrag, oder nachträgliches erstmaliges Ausfüllen) hängt diese
    // Funktion unten eine neue Zeile ans Ende von "Durchgeführte Arbeiten"
    // (ServiceReport.performedWork) an - siehe utils/performedWorkNote.ts
    // für die genaue Begründung (kein Nachziehen bei jeder Änderung).
    const previousNote = editingId ? editingOriginal?.note : undefined;
    async function appendPerformedWorkIfFirstTime(): Promise<void> {
      if (!shouldAppendPerformedWorkLine(previousNote, formNote)) return;
      const report = await getReport(reportId);
      if (!report) return;
      const line = formatTimeEntryPerformedWorkLine({ date: formDate, startTime, endTime }, formNote);
      await updateReport(reportId, { performedWork: appendPerformedWorkLine(report.performedWork, line) });
    }

    // Plausibilitätsprüfung nur möglich, wenn Start UND Ende gesetzt sind -
    // sonst gibt es keine vergleichbare Zeitspanne. Prüft berichtsübergreifend
    // (man kann nicht gleichzeitig in zwei Berichten arbeiten), schließt den
    // gerade bearbeiteten Eintrag selbst aus.
    if (startTime && endTime) {
      const overlaps = await findOverlappingTimeEntries(formDate, startTime, endTime, editingId);
      if (overlaps.length > 0) {
        const list = await describeOverlaps(overlaps);
        // Bewusst NUR EINE Rückfrage statt vormals zwei nacheinander (Speichern
        // trotz Überschneidung? / danach separat: automatisch kürzen?) - zwei
        // Dialoge hintereinander luden dazu ein, den zweiten unbedacht
        // wegzutippen ("einfach beide OK/weiter") und damit den überschneidenden
        // Alt-Eintrag versehentlich UNGEKÜRZT stehen zu lassen - mit der Folge,
        // dass dieselbe Zeitspanne doppelt gezählt wird (Gesamtzeit zu hoch,
        // ohne dass es beim Speichern selbst auffällt). Trimmen ist ohnehin
        // nicht-destruktiv (nur das überschneidende Fenster wird entfernt, der
        // übrige Zeitraum bleibt erhalten, ggf. gesplittet) - deshalb hier direkt
        // als Teil derselben Bestätigung statt als eigene, überspringbare Frage.
        if (
          !confirm(
            `Diese Zeit überschneidet sich mit:\n${list}\n\nBeim Speichern wird die überschneidende Zeit bei diesen Einträgen automatisch entfernt (der übrige Zeitraum bleibt erhalten). Trotzdem speichern?`
          )
        ) {
          return;
        }

        await persistEntry(payload);
        await trimOverlappingTimeEntries(overlaps, startTime, endTime);
        await applyPauseIfNeeded(startTime, endTime);
        await appendPerformedWorkIfFirstTime();
        resetForm();
        await load();
        onChanged();
        return;
      }
    }

    await persistEntry(payload);
    await applyPauseIfNeeded(startTime, endTime);
    await appendPerformedWorkIfFirstTime();
    resetForm();
    await load();
    onChanged();
  }

  async function remove(entry: TimeEntry): Promise<void> {
    if (!confirm('Diesen Zeiteintrag löschen?')) return;
    await deleteTimeEntry(entry.id);
    if (editingId === entry.id) resetForm();
    await load();
    onChanged();
  }
</script>

<div class="section">
  {#if loading}
    <p class="hint">Lade Zeiten…</p>
  {:else}
    {#if entries.length === 0 && !showForm}
      <p class="hint">Noch keine Zeiten erfasst.</p>
    {/if}
    {#if entries.length > 0}
      <ul class="list">
        {#each entries as entry (entry.id)}
          {@const exceedsMax = exceedsMaxDailyWork(entry.durationMinutes)}
          <li class="row" class:exceeds-max={exceedsMax}>
            {#if locked}
              <div class="row-main">
                <span class="date">{formatDateDE(entry.date)}</span>
                <span class="meta">
                  {#if entry.startTime && entry.endTime}{entry.startTime}–{entry.endTime} Uhr ·{/if}
                  {formatDurationMinutes(entry.durationMinutes)}
                  {#if exceedsMax}
                    <span class="max-hint" title="Überschreitet die gesetzliche Höchstarbeitszeit (10 Std./Tag) - bitte prüfen.">
                      <Icon name="alert-triangle" size={13} />
                    </span>
                  {/if}
                </span>
                {#if entry.note}<span class="note">{entry.note}</span>{/if}
              </div>
            {:else}
              <button type="button" class="row-main" onclick={() => startEdit(entry)}>
                <span class="date">{formatDateDE(entry.date)}</span>
                <span class="meta">
                  {#if entry.startTime && entry.endTime}{entry.startTime}–{entry.endTime} Uhr ·{/if}
                  {formatDurationMinutes(entry.durationMinutes)}
                  {#if exceedsMax}
                    <span class="max-hint" title="Überschreitet die gesetzliche Höchstarbeitszeit (10 Std./Tag) - bitte prüfen.">
                      <Icon name="alert-triangle" size={13} />
                    </span>
                  {/if}
                </span>
                {#if entry.note}<span class="note">{entry.note}</span>{/if}
              </button>
              <button type="button" class="delete" aria-label="Zeiteintrag löschen" onclick={() => remove(entry)}>
                <Icon name="trash" />
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#if locked}
    <p class="hint">Bericht ist gesperrt – Zeiten können nicht mehr geändert werden.</p>
  {:else if showForm}
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        Datum
        <input type="date" bind:value={formDate} required />
      </label>
      <div class="two-col">
        <label>
          Start
          <input type="time" bind:value={formStart} />
        </label>
        <label>
          Ende
          <input type="time" bind:value={formEnd} />
        </label>
      </div>
      {#if previewDuration !== undefined}
        <p class="duration-preview">
          Dauer: {formatDurationMinutes(previewDuration)}
          {#if formPauseEnabled && formPauseHours > 0 && formPauseHours * 60 < previewDuration}
            <span class="duration-net">
              (abzüglich {formPauseHours} Std. Pause: {formatDurationMinutes(previewDuration - Math.round(formPauseHours * 60))})
            </span>
          {/if}
        </p>
      {/if}
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={formPauseEnabled} />
        Pause abziehen
      </label>
      {#if formPauseEnabled}
        <label>
          Pause (Std.)
          <input type="number" inputmode="decimal" step="0.25" min="0.25" bind:value={formPauseHours} />
        </label>
      {/if}
      <label>
        Durchgeführte Arbeiten (optional)
        <textarea rows="2" bind:value={formNote} placeholder="z.B. Fehlersuche, Inbetriebnahme…"></textarea>
      </label>
      <div class="form-actions">
        <button type="button" class="ghost" onclick={resetForm}>Abbrechen</button>
        <button type="submit" class="primary">Speichern</button>
      </div>
    </form>
  {:else}
    <button type="button" class="add" onclick={startAdd}>+ Tag hinzufügen</button>
  {/if}
</div>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .hint {
    color: var(--color-text-muted);
    text-align: center;
    margin: var(--space-4) 0;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .row {
    display: flex;
    align-items: stretch;
    gap: var(--space-2);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .row.exceeds-max {
    background: var(--color-danger-bg);
    border-color: var(--color-danger);
  }

  .row-main {
    flex: 1;
    text-align: left;
    background: transparent;
    border: none;
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: auto;
  }

  .date {
    font-weight: 600;
  }

  .meta {
    font-size: 0.85rem;
    color: var(--color-text-muted);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .max-hint {
    display: inline-flex;
    color: var(--color-danger);
  }

  .note {
    font-size: 0.85rem;
    color: var(--color-text-muted);
  }

  .delete {
    background: transparent;
    border: none;
    color: var(--color-danger);
    padding: 0 var(--space-3);
    min-height: auto;
    font-size: 1.1rem;
  }

  .add {
    background: var(--color-surface);
    border: 1px dashed var(--color-primary);
    color: var(--color-primary);
    border-radius: var(--radius-md);
    font-weight: 600;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-4);
  }

  .form label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: 0.85rem;
    color: var(--color-text-muted);
  }

  .two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .duration-preview {
    margin: 0;
    font-size: 0.85rem;
    color: var(--color-primary);
    font-weight: 600;
  }

  .duration-net {
    color: var(--color-text-muted);
    font-weight: 400;
  }

  .form label.checkbox-label {
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    font-size: 0.95rem;
    color: var(--color-text);
  }

  .checkbox-label input[type='checkbox'] {
    width: auto;
    min-height: auto;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .ghost {
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    min-height: auto;
  }

  .primary {
    background: var(--color-primary);
    color: var(--color-primary-contrast);
    border: none;
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    min-height: auto;
    font-weight: 600;
  }
</style>
