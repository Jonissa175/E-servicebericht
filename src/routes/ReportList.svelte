<script lang="ts">
  import { getGloballyActiveTimeEntry, listReports, type ReportFilter, type ServiceReport } from '../lib/db';
  import { buildBackupFile, parseBackupFile, restoreBackup, suggestedBackupFileName } from '../lib/backup/backupFile';
  import { importServiceOrderFromFile, ServiceOrderImportError } from '../lib/import/importServiceOrder';
  import { getTechnicianName } from '../lib/settings';
  import DayClock from '../lib/components/DayClock.svelte';
  import ReportCard from '../lib/components/ReportCard.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import BulkExportDialog from '../lib/components/BulkExportDialog.svelte';
  import { navigate } from '../lib/router.svelte';
  import logoUrl from '../assets/logo.svg';
  import { themeState, toggleTheme } from '../lib/theme.svelte';

  let reports = $state<ServiceReport[]>([]);
  let filter = $state<ReportFilter>('all');
  let searchQuery = $state('');
  let loading = $state(true);
  let backupBusy = $state(false);
  let backupError = $state('');
  let fileInput: HTMLInputElement | undefined;
  // Serviceauftrag-Import (siehe menuTriggerServiceOrderImport()/
  // handleServiceOrderFile() unten) - eigener Datei-Input (PDF statt JSON),
  // eigener Busy-/Fehler-State, damit ein laufender Import nicht mit einem
  // parallel laufenden Sicherung-Import verwechselt wird.
  let serviceOrderFileInput: HTMLInputElement | undefined;
  let importOrderBusy = $state(false);
  let importOrderError = $state('');
  // Rohe technische Fehlermeldung (z.B. aus der PDF-Extraktion) - wird NICHT
  // als Haupttext gezeigt (siehe handleServiceOrderFile, importOrderError
  // bleibt dafür bewusst generisch/verständlich), aber optional einblendbar
  // ("Technische Details"), damit sich ein Fehler auf einem Gerät ohne
  // eigene Entwicklerwerkzeuge (z.B. iPhone ohne angeschlossenen Mac)
  // trotzdem konkret zurückmelden lässt, statt nur "funktioniert nicht".
  let importOrderErrorDetail = $state('');
  let importOrderErrorDetailOpen = $state(false);
  let menuOpen = $state(false);
  let bulkExportOpen = $state(false);
  /** Der Bericht, in den aktuell eingecheckt ist (falls einer) - wird oben angepinnt und farblich hervorgehoben. */
  let activeReportId = $state<string | undefined>(undefined);

  // Reine Client-seitige Textsuche über die bereits geladene (nach Status
  // gefilterte) Liste - kein neuer DB-Index nötig, bei der zu erwartenden
  // Berichtsanzahl eines Solo-Handwerkers völlig ausreichend performant.
  // Der eingecheckte Bericht wird danach zusätzlich an die erste Stelle
  // gezogen (falls durch Filter/Suche überhaupt noch enthalten) - unabhängig
  // von der sonst nach `updatedAt` sortierten Reihenfolge soll er immer sofort
  // sichtbar sein.
  const filteredReports = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();
    const base = !query
      ? reports
      : reports.filter(
          (report) =>
            report.projectNumber.toLowerCase().includes(query) || (report.customer ?? '').toLowerCase().includes(query)
        );
    if (!activeReportId) return base;
    const activeIndex = base.findIndex((report) => report.id === activeReportId);
    if (activeIndex <= 0) return base;
    return [base[activeIndex], ...base.slice(0, activeIndex), ...base.slice(activeIndex + 1)];
  });

  async function loadReports(): Promise<void> {
    loading = true;
    reports = await listReports(filter);
    loading = false;
  }

  async function loadActiveReportId(): Promise<void> {
    const entry = await getGloballyActiveTimeEntry();
    activeReportId = entry?.reportId;
  }

  $effect(() => {
    filter;
    loadReports();
  });

  // Läuft einmal beim Mount - reicht für den Normalfall (Navigation in einen
  // Bericht und zurück mountet diesen Screen ohnehin frisch neu). DayClocks
  // onChanged deckt den Sonderfall ab, dass sich der Eingecheckt-Status
  // ändert, OHNE dass man diesen Screen verlässt (z.B. "Tag ausstempeln").
  $effect(() => {
    loadActiveReportId();
  });

  function newReport(): void {
    navigate('/reports/new');
  }

  function closeMenu(): void {
    menuOpen = false;
  }

  function menuNavigate(path: string): void {
    closeMenu();
    navigate(path);
  }

  function menuExportBackup(): void {
    closeMenu();
    void exportBackup();
  }

  function menuTriggerImport(): void {
    closeMenu();
    triggerImport();
  }

  function menuToggleTheme(): void {
    closeMenu();
    toggleTheme();
  }

  function menuOpenBulkExport(): void {
    closeMenu();
    bulkExportOpen = true;
  }

  // Schließt das Menü bei Escape - Maus-/Tastatur-Bedienung (z.B. iPad mit
  // externer Tastatur), auf dem Handy per Backdrop-Tap ohnehin abgedeckt.
  $effect(() => {
    if (!menuOpen) return;
    function handleKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeMenu();
    }
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  async function exportBackup(): Promise<void> {
    if (backupBusy) return;
    backupBusy = true;
    backupError = '';
    try {
      const blob = await buildBackupFile();
      const fileName = suggestedBackupFileName();
      const file = new File([blob], fileName, { type: 'application/json' });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: fileName });
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      backupError = 'Sicherung konnte nicht erstellt werden. Bitte erneut versuchen.';
      console.error('Backup-Export fehlgeschlagen', err);
    } finally {
      backupBusy = false;
    }
  }

  function triggerImport(): void {
    fileInput?.click();
  }

  async function handleImportFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // gleiche Datei muss danach erneut wählbar sein
    if (!file) return;

    backupBusy = true;
    backupError = '';
    try {
      const { data, summary } = await parseBackupFile(file);
      const confirmed = confirm(
        `Sicherung enthält ${summary.reportCount} Berichte, ${summary.timeEntryCount} Zeiteinträge, ` +
          `${summary.materialItemCount} Materialpositionen und ${summary.photoCount} Fotos.\n\n` +
          `Jetzt importieren? Vorhandene Berichte mit gleicher ID werden dabei überschrieben.`
      );
      if (!confirmed) return;

      await restoreBackup(data);
      await loadReports();
    } catch (err) {
      backupError = err instanceof Error ? err.message : 'Import fehlgeschlagen. Bitte erneut versuchen.';
      console.error('Backup-Import fehlgeschlagen', err);
    } finally {
      backupBusy = false;
    }
  }

  function menuTriggerServiceOrderImport(): void {
    closeMenu();
    serviceOrderFileInput?.click();
  }

  /**
   * Liest einen als PDF ausgewählten ELSA-Serviceauftrag ein (siehe
   * importServiceOrderFromFile(), src/lib/import/importServiceOrder.ts) und
   * springt bei Erfolg direkt in den neu angelegten (oder bei bereits
   * offenem Bericht zur selben Projektnummer: den dafür ergänzten) Bericht -
   * erspart dem Monteur, Projektnummer, Kundendaten und erwartetes Material
   * von Hand abzutippen. Alle übernommenen Felder bleiben dort wie gewohnt
   * frei editierbar, da die Erkennung reine Heuristik auf ein festes
   * Vorlagen-Format ist (kein Standard wie bei GS1-Codes).
   */
  async function handleServiceOrderFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // gleiche Datei muss danach erneut wählbar sein
    if (!file) return;

    importOrderBusy = true;
    importOrderError = '';
    importOrderErrorDetail = '';
    importOrderErrorDetailOpen = false;
    try {
      const result = await importServiceOrderFromFile(file, getTechnicianName() || undefined);
      if (!result.reused && result.materialCount > 0) {
        alert(`${result.materialCount} Materialposition(en) aus dem Serviceauftrag wurden vorausgefüllt übernommen.`);
      }
      navigate(`/reports/${result.report.id}`);
    } catch (err) {
      // Nur eine gezielte ServiceOrderImportError (s. importServiceOrder.ts,
      // z.B. "keine Projektnummer gefunden") zeigt ihre eigene Meldung -
      // jeder andere (technische/unerwartete) Fehler bekommt stattdessen
      // diesen generischen, für den Nutzer verständlichen Hinweis, statt
      // einer rohen Browser-/Bibliotheks-Fehlermeldung. Die rohe Meldung
      // bleibt trotzdem (ausgeblendet, s. Template) abrufbar - sonst lässt
      // sich ein Fehler auf einem Gerät ohne eigene Entwicklerwerkzeuge
      // (z.B. iPhone ohne angeschlossenen Mac) nicht konkret zurückmelden.
      if (err instanceof ServiceOrderImportError) {
        importOrderError = err.message;
      } else {
        importOrderError =
          'Serviceauftrag konnte nicht gelesen werden. Bitte erneut versuchen oder das PDF als Datei (nicht als Foto/Scan) prüfen.';
        importOrderErrorDetail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
      console.error('Serviceauftrag-Import fehlgeschlagen', err);
    } finally {
      importOrderBusy = false;
    }
  }
</script>

<div class="screen">
  <header class="header">
    <div class="brand">
      <img src={logoUrl} alt="" class="brand-icon" width="34" height="34" />
      <h1 class="brand-name"><span class="brand-accent">R</span>ivo</h1>
    </div>
    <div class="menu-wrapper">
      <button
        type="button"
        class="menu-toggle"
        onclick={() => (menuOpen = !menuOpen)}
        aria-label="Menü öffnen"
        aria-haspopup="true"
        aria-expanded={menuOpen}
      >
        <Icon name="menu" size={22} />
      </button>
      {#if menuOpen}
        <button type="button" class="menu-backdrop" onclick={closeMenu} aria-label="Menü schließen"></button>
        <div class="menu-popup" role="menu">
          <button type="button" role="menuitem" onclick={() => menuNavigate('/statistik')}>
            <span class="menu-icon"><Icon name="stats" /></span><span>Auswertung</span>
          </button>
          <button type="button" role="menuitem" onclick={() => menuNavigate('/leerlaufzeiten')}>
            <span class="menu-icon"><Icon name="clock" /></span><span>Leerlaufzeiten zuordnen</span>
          </button>
          <button type="button" role="menuitem" onclick={() => menuNavigate('/abwesenheiten')}>
            <span class="menu-icon"><Icon name="calendar" /></span><span>Abwesenheiten</span>
          </button>
          <button type="button" role="menuitem" onclick={() => menuNavigate('/einstellungen')}>
            <span class="menu-icon"><Icon name="settings" /></span><span>Einstellungen</span>
          </button>
          <button type="button" role="menuitem" onclick={menuTriggerServiceOrderImport} disabled={importOrderBusy}>
            <span class="menu-icon"><Icon name="file-text" /></span><span>Serviceauftrag importieren</span>
          </button>
          <button type="button" role="menuitem" onclick={menuExportBackup} disabled={backupBusy}>
            <span class="menu-icon"><Icon name="download" /></span><span>Sicherung exportieren</span>
          </button>
          <button type="button" role="menuitem" onclick={menuTriggerImport} disabled={backupBusy}>
            <span class="menu-icon"><Icon name="upload" /></span><span>Sicherung wiederherstellen</span>
          </button>
          <button type="button" role="menuitem" onclick={menuOpenBulkExport}>
            <span class="menu-icon"><Icon name="copy" /></span><span>Serviceberichte sammelexportieren</span>
          </button>
          <button type="button" role="menuitem" onclick={menuToggleTheme}>
            <span class="menu-icon">
              <Icon name={themeState.mode === 'dark' ? 'sun' : 'moon'} />
            </span>
            <span>{themeState.mode === 'dark' ? 'Helles Design' : 'Dunkles Design'}</span>
          </button>
        </div>
      {/if}
      <input
        bind:this={fileInput}
        type="file"
        accept="application/json,.json"
        class="visually-hidden"
        onchange={handleImportFile}
      />
      <input
        bind:this={serviceOrderFileInput}
        type="file"
        accept="application/pdf,.pdf"
        class="visually-hidden"
        onchange={handleServiceOrderFile}
      />
    </div>
  </header>
  {#if backupError}
    <p class="backup-error">{backupError}</p>
  {/if}
  {#if importOrderError}
    <p class="backup-error">{importOrderError}</p>
    {#if importOrderErrorDetail}
      <button
        type="button"
        class="error-detail-toggle"
        onclick={() => (importOrderErrorDetailOpen = !importOrderErrorDetailOpen)}
      >
        {importOrderErrorDetailOpen ? 'Technische Details ausblenden' : 'Technische Details anzeigen'}
      </button>
      {#if importOrderErrorDetailOpen}
        <p class="error-detail">{importOrderErrorDetail}</p>
      {/if}
    {/if}
  {/if}
  {#if importOrderBusy}
    <p class="backup-error import-busy">Serviceauftrag wird gelesen…</p>
  {/if}

  <DayClock onChanged={loadActiveReportId} />

  <input
    type="search"
    class="search"
    bind:value={searchQuery}
    placeholder="Suchen (Projektnummer, Kunde)…"
    aria-label="Berichte durchsuchen"
  />

  <div class="filters" role="tablist" aria-label="Berichte filtern">
    <button type="button" class:active={filter === 'all'} onclick={() => (filter = 'all')}>Alle</button>
    <button type="button" class:active={filter === 'open'} onclick={() => (filter = 'open')}>Offen</button>
    <button type="button" class:active={filter === 'completed'} onclick={() => (filter = 'completed')}>
      Abgeschlossen
    </button>
    <button type="button" class:active={filter === 'locked'} onclick={() => (filter = 'locked')}>
      Gesperrt
    </button>
    <button type="button" class:active={filter === 'not-exported'} onclick={() => (filter = 'not-exported')}>
      Nicht exportiert
    </button>
  </div>

  <div class="content">
    {#if loading}
      <p class="hint">Lade Berichte…</p>
    {:else if reports.length === 0}
      <div class="empty">
        <p>Noch keine Serviceberichte vorhanden.</p>
        <p class="hint">Tippe unten rechts auf „+“, um deinen ersten Bericht anzulegen.</p>
      </div>
    {:else if filteredReports.length === 0}
      <div class="empty">
        <p>Keine Treffer für „{searchQuery}“.</p>
      </div>
    {:else}
      <ul class="list">
        {#each filteredReports as report (report.id)}
          <li><ReportCard {report} checkedIn={report.id === activeReportId} /></li>
        {/each}
      </ul>
    {/if}
  </div>

  <button type="button" class="fab" onclick={newReport} aria-label="Neuer Bericht">+</button>

  {#if bulkExportOpen}
    <BulkExportDialog onClose={() => (bulkExportOpen = false)} onExported={loadReports} />
  {/if}
</div>

<style>
  .screen {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: calc(var(--space-4) + var(--safe-top)) var(--space-4) var(--space-2);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .brand-icon {
    border-radius: 22%;
    flex-shrink: 0;
  }

  .brand-name {
    margin: 0;
    font-size: 1.4rem;
  }

  .brand-accent {
    color: var(--color-brand-accent);
  }

  .menu-wrapper {
    position: relative;
  }

  .menu-toggle {
    background: transparent;
    border: none;
    font-size: 1.4rem;
    padding: var(--space-2);
    min-height: auto;
    color: var(--color-text);
  }

  .menu-backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    padding: 0;
    min-height: auto;
    z-index: 20;
  }

  .menu-popup {
    position: absolute;
    top: calc(100% + var(--space-1));
    right: 0;
    z-index: 21;
    display: flex;
    flex-direction: column;
    min-width: 240px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: 0 12px 28px var(--color-shadow);
    overflow: hidden;
  }

  .menu-popup button {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    background: transparent;
    border: none;
    border-radius: 0;
    padding: var(--space-3) var(--space-4);
    min-height: 52px;
    text-align: left;
    font-size: 0.95rem;
    color: var(--color-text);
  }

  .menu-popup button:not(:last-child) {
    border-bottom: 1px solid var(--color-border);
  }

  .menu-popup button:disabled {
    opacity: 0.5;
  }

  .menu-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4em;
    flex-shrink: 0;
  }

  .backup-error {
    margin: 0 var(--space-4) var(--space-3);
    color: var(--color-danger);
    font-size: 0.85rem;
    text-align: center;
  }

  .backup-error.import-busy {
    color: var(--color-text-muted);
  }

  .error-detail-toggle {
    display: block;
    margin: 0 auto var(--space-3);
    background: none;
    border: none;
    color: var(--color-text-muted);
    font-size: 0.8rem;
    text-decoration: underline;
  }

  .error-detail {
    margin: 0 var(--space-4) var(--space-3);
    padding: var(--space-2);
    background: var(--color-surface-muted);
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    font-size: 0.75rem;
    font-family: monospace;
    word-break: break-word;
    text-align: left;
  }

  .search {
    display: block;
    width: calc(100% - 2 * var(--space-4));
    margin: 0 var(--space-4) var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    font-size: 0.95rem;
    color: var(--color-text);
  }

  .filters {
    display: flex;
    gap: var(--space-2);
    padding: 0 var(--space-4) var(--space-3);
    overflow-x: auto;
  }

  .filters button {
    min-height: 36px;
    padding: var(--space-1) var(--space-4);
    border-radius: 999px;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text-muted);
    font-size: 0.85rem;
    white-space: nowrap;
  }

  .filters button.active {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-primary-contrast);
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 0 var(--space-4) calc(var(--space-6) + var(--safe-bottom) + 64px);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .hint {
    color: var(--color-text-muted);
    text-align: center;
    margin-top: var(--space-6);
  }

  .empty {
    text-align: center;
    margin-top: var(--space-6);
    color: var(--color-text-muted);
  }

  .empty p {
    margin: var(--space-2) 0;
  }

  .fab {
    position: fixed;
    right: var(--space-5);
    bottom: calc(var(--space-5) + var(--safe-bottom));
    width: 60px;
    height: 60px;
    border-radius: 50%;
    background: var(--color-primary);
    color: var(--color-primary-contrast);
    border: none;
    font-size: 1.8rem;
    line-height: 1;
    box-shadow: 0 8px 20px var(--color-primary-glow);
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
