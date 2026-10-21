<script lang="ts">
  import {
    createReport,
    deleteReport,
    finalizeReport,
    getReport,
    listReportsByProjectNumber,
    markReportExported,
    setReportSignature,
    unlockReport,
    updateReport
  } from '../lib/db/reports';
  import { getActiveTimeEntry } from '../lib/db/timeEntries';
  import { switchToIdle } from '../lib/clockActions';
  import type { ReportStatus, ServiceReport } from '../lib/db/types';
  import { navigate } from '../lib/router.svelte';
  import { debounce } from '../lib/utils/debounce';
  import { formatDateTimeDE, formatDurationMinutes } from '../lib/utils/date';
  import { getTechnicianName, setTechnicianName } from '../lib/settings';
  import TimeClock from '../lib/components/TimeClock.svelte';
  import TimeEntrySection from '../lib/components/TimeEntrySection.svelte';
  import MaterialSection from '../lib/components/MaterialSection.svelte';
  import PhotoSection from '../lib/components/PhotoSection.svelte';
  import SignatureSection from '../lib/components/SignatureSection.svelte';
  import StatusBadge from '../lib/components/StatusBadge.svelte';
  import Icon from '../lib/components/Icon.svelte';

  let { id }: { id: string } = $props();

  // `id` wird bewusst nur beim Mount gelesen: App.svelte rendert diesen
  // Screen innerhalb eines {#key route.id}-Blocks, der bei Routenwechsel
  // ohnehin eine frische Komponenteninstanz erzeugt.
  const isNewRoute = $derived(id === 'new');

  let reportId = $state<string | undefined>(undefined);
  let loading = $state(!isNewRoute);
  let notFound = $state(false);

  let projectNumber = $state('');
  let projectDescription = $state('');
  let customer = $state('');
  let contactPerson = $state('');
  // Bei einem neuen Bericht mit dem zuletzt verwendeten Techniker-Namen
  // vorausfüllen (lokal auf dem Gerät gemerkt, siehe lib/settings.ts) - erspart
  // erneutes Eintippen bei jedem einzelnen Bericht.
  let technicianName = $state(isNewRoute ? getTechnicianName() : '');
  let notes = $state('');
  let status = $state<ReportStatus>('open');
  // Als Text-State wie die übrigen Felder (leer = nicht gesetzt), nicht als
  // Zahl - sonst müsste jede Zwischeneingabe beim Tippen (z.B. "1" vor dem
  // ",5" von "1,5") schon eine gültige Zahl sein.
  let plannedLaborHours = $state('');

  let timeEntryCount = $state(0);
  let totalDurationMinutes = $state(0);
  let materialItemCount = $state(0);
  let photoCount = $state(0);

  let signatureBlob = $state<Blob | undefined>(undefined);
  let signedByName = $state<string | undefined>(undefined);
  let signedAt = $state<string | undefined>(undefined);
  let finalizedAt = $state<string | undefined>(undefined);

  /**
   * Alle Berichte mit derselben Projektnummer wie dieser (chronologisch,
   * ältester zuerst - siehe listReportsByProjectNumber()), inkl. diesem
   * Bericht selbst. Einmalig beim Laden anhand der zu diesem Zeitpunkt
   * gespeicherten Projektnummer ermittelt (siehe Lade-Effekt unten); ändert
   * sich die Projektnummer danach, bleibt die Liste bis zum nächsten
   * Neuladen auf dem alten Stand - für eine reine Info-/Sprung-Anzeige
   * unkritisch. Grundlage sowohl für den "X. von Y Berichten"-Badge als auch
   * für die Liste der "verknüpften" Berichte zum direkten Hinspringen.
   */
  let relatedReports = $state<ServiceReport[]>([]);
  let relatedReportsOpen = $state(false);

  const projectVisitInfo = $derived.by(() => {
    if (relatedReports.length <= 1 || !reportId) return undefined;
    const index = relatedReports.findIndex((r) => r.id === reportId);
    return index === -1 ? undefined : { index: index + 1, total: relatedReports.length };
  });

  // Ein final abgeschlossener Bericht darf nicht mehr verändert werden - die
  // Sperre hängt an `finalizedAt`, das sowohl beim Unterschreiben als auch
  // beim manuellen Abschließen ohne Unterschrift gesetzt wird (siehe
  // saveSignature()/finalizeWithoutSignature()). Einziger Weg zurück: die
  // Sperre bewusst wieder aufheben (unlockManually() bzw. "Entfernen" im
  // Unterschrift-Tab).
  const locked = $derived(!!finalizedAt);

  /**
   * Mannstunden-Soll/Ist-Vergleich für die Übersicht: `plannedLaborHours`
   * (editierbar, bei einem Serviceauftrag-Import automatisch aus den
   * "Std"-Arbeitsaufwand-Positionen vorbefüllt, s. db/types.ts) gegen die
   * bereits erfasste Gesamtzeit (totalDurationMinutes, alle Kategorien/
   * Projektzeit zusammen - der Nutzer wollte ausdrücklich "egal welche
   * Kategorie"). undefined, solange kein Soll gesetzt ist - dann gibt es
   * nichts zum Vergleichen und die Anzeige bleibt ausgeblendet (gleiches
   * Prinzip wie plannedQuantity bei Material: nur anzeigen, wenn ein Soll
   * überhaupt bekannt ist).
   *
   * Schwellwerte 80%/100% sind ein bewusst einfacher, nachvollziehbarer
   * Standard (grün bis knapp vor Erreichen des Solls, gelb kurz davor, rot
   * bei Überschreitung) - lassen sich bei Bedarf leicht anpassen.
   */
  const laborBudget = $derived.by(() => {
    const planned = parsePlannedLaborHours();
    if (planned === undefined) return undefined;
    const usedHours = totalDurationMinutes / 60;
    const ratio = usedHours / planned;
    const level: 'ok' | 'warn' | 'over' = ratio > 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok';
    return { usedHours, planned, ratio, level };
  });

  // Kopfdaten sind bei einem neuen Bericht ausgeklappt (müssen ja erst
  // ausgefüllt werden), bei einem bereits vorhandenen dagegen eingeklappt -
  // spart auf kleinen Bildschirmen Platz für die eigentliche Arbeit
  // (Zeiten/Material/Fotos). Per Tap auf die Kopfzeile jederzeit umschaltbar.
  let fieldsExpanded = $state(isNewRoute);

  let activeTab = $state<'übersicht' | 'zeiten' | 'material' | 'fotos' | 'unterschrift'>('übersicht');
  let savedPulseVisible = $state(false);
  let savedPulseTimeout: ReturnType<typeof setTimeout> | undefined;
  let projectNumberMissing = $state(false);
  // Verhindert, dass die Duplikat-Rückfrage (siehe checkForDuplicateProjectNumber()
  // unten) für denselben Entwurf mehrfach erscheint, nachdem der Nutzer sich
  // schon einmal bewusst für "trotzdem neuen Bericht anlegen" entschieden hat.
  let duplicateWarningDismissed = false;
  let exporting = $state(false);
  let exportError = $state(false);

  function flashSaved(): void {
    savedPulseVisible = true;
    if (savedPulseTimeout) clearTimeout(savedPulseTimeout);
    savedPulseTimeout = setTimeout(() => (savedPulseVisible = false), 1500);
  }

  /** z.B. 6.5 -> "6,5 Std." - für die Mannstunden-Anzeige, deutsches Dezimalkomma statt Punkt. */
  function formatHoursDE(hours: number): string {
    return `${hours.toLocaleString('de-DE', { maximumFractionDigits: 1 })} Std.`;
  }

  /** `plannedLaborHours` als Zahl, oder undefined bei leerem/ungültigem Feld - Komma wie bei Menge-Feldern als Dezimaltrennzeichen zugelassen. */
  function parsePlannedLaborHours(): number | undefined {
    const trimmed = plannedLaborHours.trim();
    if (!trimmed) return undefined;
    const num = Number(trimmed.replace(',', '.'));
    return Number.isFinite(num) && num > 0 ? num : undefined;
  }

  async function persistNow(): Promise<void> {
    if (!reportId) {
      if (!projectNumber.trim()) return;
      const created = await createReport({
        projectNumber,
        projectDescription: projectDescription || undefined,
        customer: customer || undefined,
        contactPerson: contactPerson || undefined,
        technicianName: technicianName || undefined,
        notes: notes || undefined,
        plannedLaborHours: parsePlannedLaborHours()
      });
      reportId = created.id;
      // Absichtlich noch KEIN navigate() hier: das würde über
      // {#key route.id} in App.svelte sofort diese Komponente neu mounten
      // und dabei gerade eingetippten, noch ungespeicherten Text in anderen
      // Feldern verwerfen (der Nutzer tippt beim Anlegen oft mehrere Felder
      // kurz hintereinander aus). Die URL wird stattdessen erst an
      // unkritischen Stellen synchronisiert, siehe syncUrlToReportId().
    }
    const id = reportId;
    if (!id) return;
    // Direkt nach dem Anlegen mit dem aktuellen Stand aktualisieren, statt
    // hier aufzuhören - falls seit dem Lesen der Felder oben weitergetippt
    // wurde, landet der neueste Stand so trotzdem sofort in der DB.
    const updated = await updateReport(id, {
      projectNumber,
      projectDescription: projectDescription || undefined,
      customer: customer || undefined,
      contactPerson: contactPerson || undefined,
      technicianName: technicianName || undefined,
      notes: notes || undefined,
      status,
      plannedLaborHours: parsePlannedLaborHours()
    });
    if (updated) flashSaved();
  }

  // persistNow() liest reaktiven State und macht dann einen Lesen-Ändern-
  // Schreiben-Zyklus auf der DB. Bei schnell aufeinanderfolgenden Aufrufen
  // (z.B. onblur={flushNow} beim Wechsel zwischen mehreren Feldern kurz
  // hintereinander) dürfen diese Zyklen NIE parallel laufen - sonst kann ein
  // später gestarteter, aber früher abgeschlossener Aufruf einen bereits
  // gespeicherten Feldwert wieder überschreiben. saveChain serialisiert alle
  // Aufrufe strikt in Aufrufreihenfolge.
  let saveChain: Promise<void> = Promise.resolve();

  function queueSave(): Promise<void> {
    saveChain = saveChain.then(persistNow).catch((err) => console.error('Speichern fehlgeschlagen', err));
    return saveChain;
  }

  const scheduledSave = debounce(() => {
    queueSave();
  }, 450);

  function onFieldChange(): void {
    projectNumberMissing = false;
    scheduledSave.run();
  }

  /** Wie onFieldChange(), merkt sich den Techniker-Namen zusätzlich lokal als neuen Standard für künftige Berichte (siehe lib/settings.ts). */
  function onTechnicianNameInput(): void {
    onFieldChange();
    setTechnicianName(technicianName);
  }

  function flushNow(): void {
    scheduledSave.flush();
  }

  /**
   * Prüft beim Verlassen des Projektnummer-Feldes (onblur), ob zu dieser
   * Nummer bereits ein ANDERER offener (nicht gesperrter) Bericht existiert -
   * und zwar bewusst NICHT als Teil von persistNow() selbst, sondern erst
   * hier, wo die Nummer garantiert vollständig eingetippt ist. Grund: Die
   * zeichenweise Autosave-Debounce (450ms Tipp-Pause, siehe scheduledSave)
   * kann während des Tippens jederzeit mit einer noch UNVOLLSTÄNDIGEN
   * Nummer feuern (z.B. bei einer kurzen Denkpause zwischen "2026-" und
   * "0142") und dabei bereits über persistNow() einen Bericht anlegen -
   * eine Duplikat-Prüfung direkt in persistNow() würde dann mit der
   * unvollständigen Nummer laufen, keinen Treffer finden, und da reportId
   * ab da gesetzt ist, nie wieder erneut geprüft (jeder weitere
   * persistNow()-Aufruf landet nur noch im Update-Zweig). Deshalb: erst
   * hier, mit der endgültigen Nummer, und ausdrücklich unter Ausschluss des
   * eigenen (ggf. gerade erst durch genau so eine verfrühte Debounce-Runde
   * entstandenen) Berichts.
   *
   * Nur relevant beim erstmaligen Anlegen (isNewRoute) - beim Bearbeiten
   * eines bereits bestehenden Berichts wird nicht geprüft, um dort niemals
   * versehentlich den gerade bearbeiteten Bericht zur Löschung anzubieten.
   */
  async function checkForDuplicateProjectNumber(): Promise<void> {
    flushNow();
    await saveChain;
    if (!isNewRoute || duplicateWarningDismissed || locked) return;
    const trimmed = projectNumber.trim();
    if (!trimmed) return;

    const openExisting = (await listReportsByProjectNumber(trimmed)).find(
      (r) => !r.finalizedAt && r.id !== reportId
    );
    if (!openExisting) return;

    const label = openExisting.projectDescription
      ? `${openExisting.projectNumber} – ${openExisting.projectDescription}`
      : openExisting.projectNumber;
    const customerHint = openExisting.customer ? ` (Kunde: ${openExisting.customer})` : '';
    const wantsExisting = confirm(
      `Für Projekt "${label}"${customerHint} existiert bereits ein offener Bericht.\n\nOK = im bestehenden Bericht weiterarbeiten\nAbbrechen = trotzdem einen neuen Bericht anlegen`
    );

    if (wantsExisting) {
      // Ein evtl. durch eine verfrühte Debounce-Runde bereits für DIESEN
      // Entwurf angelegter (und damit brandneuer, praktisch leerer) Bericht
      // wird beim Wechsel gleich mit aufgeräumt, statt als stille Leiche in
      // der Übersicht liegen zu bleiben.
      if (reportId) await deleteReport(reportId);
      navigate(`/reports/${openExisting.id}`, { replace: true });
      return;
    }

    duplicateWarningDismissed = true;
    // Nutzerwunsch: beim bewussten Anlegen eines weiteren Berichts zum
    // selben Projekt gleich die Basisdaten aus dem bestehenden Bericht
    // übernehmen, statt sie erneut eintippen zu müssen - bleiben dabei ganz
    // normal weiter editierbar. Bereits selbst eingetippte Werte werden
    // nicht überschrieben.
    if (!projectDescription && openExisting.projectDescription) projectDescription = openExisting.projectDescription;
    if (!customer && openExisting.customer) customer = openExisting.customer;
    if (!contactPerson && openExisting.contactPerson) contactPerson = openExisting.contactPerson;
    onFieldChange();
  }

  /**
   * Trägt die URL von "/reports/new" auf die inzwischen vergebene reportId
   * nach - wichtig für Reload/Zurück-Button, aber bewusst NICHT direkt nach
   * dem Anlegen aufgerufen (siehe persistNow()). Nur an Stellen aufrufen, an
   * denen der Nutzer gerade nicht mitten im Tippen ist (Tab-Wechsel,
   * Hintergrund/Verlassen der Seite) - der {#key route.id}-Remount, den das
   * auslöst, ist an diesen Punkten unkritisch.
   */
  function syncUrlToReportId(): void {
    if (reportId && isNewRoute) {
      navigate(`/reports/${reportId}`, { replace: true });
    }
  }

  $effect(() => {
    if (isNewRoute) return;
    let cancelled = false;
    loading = true;
    getReport(id).then((report) => {
      if (cancelled) return;
      if (!report) {
        notFound = true;
        loading = false;
        return;
      }
      reportId = report.id;
      projectNumber = report.projectNumber;
      projectDescription = report.projectDescription ?? '';
      customer = report.customer ?? '';
      contactPerson = report.contactPerson ?? '';
      technicianName = report.technicianName ?? '';
      notes = report.notes ?? '';
      status = report.status;
      plannedLaborHours = report.plannedLaborHours !== undefined ? String(report.plannedLaborHours) : '';
      timeEntryCount = report.timeEntryCount;
      totalDurationMinutes = report.totalDurationMinutes;
      materialItemCount = report.materialItemCount;
      photoCount = report.photoCount;
      signatureBlob = report.signatureBlob;
      signedByName = report.signedByName;
      signedAt = report.signedAt;
      finalizedAt = report.finalizedAt;
      loading = false;

      listReportsByProjectNumber(report.projectNumber).then((related) => {
        if (cancelled) return;
        relatedReports = related;
      });
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    function handleVisibilityChange(): void {
      if (document.visibilityState === 'hidden') {
        flushNow();
        syncUrlToReportId();
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', flushNow);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', flushNow);
      flushNow();
    };
  });

  async function refreshSummary(): Promise<void> {
    if (!reportId) return;
    const report = await getReport(reportId);
    if (!report) return;
    timeEntryCount = report.timeEntryCount;
    totalDurationMinutes = report.totalDurationMinutes;
    materialItemCount = report.materialItemCount;
    photoCount = report.photoCount;
  }

  /**
   * Beendet eine ggf. noch laufende Stempeluhr dieses Berichts - wird sowohl
   * beim Unterschreiben als auch beim manuellen Abschließen ohne Unterschrift
   * aufgerufen, damit beim Sperren kein offener Zeiteintrag zurückbleibt.
   *
   * Nutzt bewusst switchToIdle() (wie das normale "Auschecken" in TimeClock)
   * statt den Eintrag nur direkt zu schließen: sonst bleibt der Tagesstempel
   * zwar aktiv, aber ohne offenen Abschnitt zurück - ein Zustand, den der Rest
   * der App nie erwartet (siehe checkInDay()). Konkret bewirkte das einen Bug:
   * die "Heute bisher"-Kachel in der Berichtsliste fror danach ein, weil ihr
   * Live-Update-Intervall an einen offenen Eintrag gekoppelt ist. switchToIdle()
   * eröffnet stattdessen sofort einen neuen Leerlaufzeit-Abschnitt, genau wie
   * beim manuellen Auschecken aus einem Projekt.
   */
  async function autoStopActiveClock(): Promise<void> {
    if (!reportId) return;
    const activeEntry = await getActiveTimeEntry(reportId);
    if (!activeEntry) return;
    await switchToIdle();
    await refreshSummary();
  }

  async function saveSignature(blob: Blob, name: string, width: number, height: number): Promise<void> {
    if (!reportId) return;
    const updated = await setReportSignature(reportId, { blob, signedByName: name, width, height });
    if (!updated) return;
    signatureBlob = updated.signatureBlob;
    signedByName = updated.signedByName;
    signedAt = updated.signedAt;
    finalizedAt = updated.finalizedAt;
    flashSaved();

    // Unterschreiben sperrt den Bericht (siehe `locked`). Der Status springt
    // konsequent auf "Abgeschlossen".
    await autoStopActiveClock();
    if (status !== 'completed') status = 'completed';
    await queueSave();
  }

  /** Schließt den Bericht final ab, ohne Kunden-Unterschrift - z.B. wenn keine Unterschrift nötig oder möglich ist. */
  async function finalizeWithoutSignature(): Promise<void> {
    if (!reportId || locked) return;
    if (
      !confirm(
        'Bericht ohne Kunden-Unterschrift final abschließen? Er wird danach gesperrt und lässt sich nicht mehr ändern, bis die Sperre wieder aufgehoben wird.'
      )
    )
      return;
    const updated = await finalizeReport(reportId);
    if (!updated) return;
    status = updated.status;
    finalizedAt = updated.finalizedAt;
    flashSaved();
    await autoStopActiveClock();
  }

  /** Hebt die Sperre auf (egal ob durch Unterschrift oder manuelles Abschließen entstanden) - ohne eigene Bestätigung, wird von den aufrufenden Stellen jeweils selbst abgefragt. */
  async function clearSignature(): Promise<void> {
    if (!reportId) return;
    const updated = await unlockReport(reportId);
    if (!updated) return;
    signatureBlob = updated.signatureBlob;
    signedByName = updated.signedByName;
    signedAt = updated.signedAt;
    finalizedAt = updated.finalizedAt;
    flashSaved();
  }

  /** Sperre-aufheben-Button im Banner - Bestätigungstext hängt davon ab, ob dabei auch eine Unterschrift verloren geht. */
  async function unlockManually(): Promise<void> {
    const message = signedAt
      ? 'Bericht entsperren? Dabei wird auch die vorhandene Kunden-Unterschrift entfernt - für eine erneute Freigabe muss ggf. neu unterschrieben werden.'
      : 'Bericht wirklich entsperren? Er wird dadurch wieder bearbeitbar.';
    if (!confirm(message)) return;
    await clearSignature();
  }

  async function toggleStatus(): Promise<void> {
    status = status === 'open' ? 'completed' : 'open';
    // Bewusst NICHT über flushNow(): der Status-Button löst kein
    // oninput={onFieldChange} aus, es gäbe also nichts "Pending" zum
    // Flushen - queueSave() direkt aufzurufen ist hier der korrekte Weg,
    // sonst wird die Änderung nie gespeichert (siehe Regressionstest).
    await queueSave();
  }

  async function removeReport(): Promise<void> {
    if (!reportId) {
      navigate('/', { replace: true });
      return;
    }
    if (!confirm('Diesen Servicebericht inkl. aller Zeiten, Material und Fotos endgültig löschen?')) return;
    await deleteReport(reportId);
    navigate('/', { replace: true });
  }

  async function exportReport(): Promise<void> {
    if (!reportId || exporting) return;
    exporting = true;
    exportError = false;
    try {
      const [{ getFullReport }, { buildReportDocx, suggestedFileName }] = await Promise.all([
        import('../lib/export/getFullReport'),
        import('../lib/export/docxExport')
      ]);
      const data = await getFullReport(reportId);
      if (!data) return;

      const blob = await buildReportDocx(data);
      const fileName = suggestedFileName(data.report);
      const mimeType = blob.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const file = new File([blob], fileName, { type: mimeType });

      // Auf dem iPhone spürbar besserer Workflow: direkt aus dem Share-Sheet
      // per Mail/WhatsApp/AirDrop verschicken, statt erst in Dateien suchen zu
      // müssen. navigator.share() kann trotz vorher erfolgreichem canShare()
      // trotzdem fehlschlagen - beobachtet auf Android (Chrome, sowohl im
      // Browser als auch installiert): die "User Activation" (das kurze
      // Zeitfenster, in dem der Browser einen echten Nutzer-Klick als Beleg
      // akzeptiert) kann durch die asynchrone Dokument-Erzeugung oben bereits
      // abgelaufen sein, bevor share() überhaupt aufgerufen wird - auf Android
      // deutlich strenger/kürzer bemessen als in iOS Safari. Ein solcher
      // Fehlschlag ist deshalb bewusst KEIN Grund, den Export komplett
      // abzubrechen: statt "Export fehlgeschlagen" anzuzeigen, fällt der
      // Export auf den klassischen Download-Link darunter zurück, der ganz
      // ohne User-Activation auskommt und deshalb zuverlässig funktioniert.
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: fileName });
          await markReportExported(reportId);
          return;
        } catch (shareErr) {
          // Ein vom Nutzer abgebrochener Share-Dialog ist kein Fehler - dort
          // NICHT auf den Download zurückfallen (der Nutzer wollte gerade
          // nicht exportieren), sondern den Export einfach beenden.
          if (shareErr instanceof DOMException && shareErr.name === 'AbortError') return;
          console.warn('navigator.share() fehlgeschlagen, falle auf Download zurück', shareErr);
        }
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      await markReportExported(reportId);
    } catch (err) {
      exportError = true;
      console.error('Export fehlgeschlagen', err);
    } finally {
      exporting = false;
    }
  }

  function back(): void {
    if (!reportId && !projectNumber.trim()) {
      // Reiner Entwurf ohne Projektnummer - nichts zu speichern, einfach zurück.
      navigate('/');
      return;
    }
    flushNow();
    navigate('/');
  }

  function openSectionTab(tab: 'zeiten' | 'material' | 'fotos' | 'unterschrift'): void {
    if (!reportId) {
      projectNumberMissing = true;
      return;
    }
    activeTab = tab;
  }
</script>

<div class="screen">
  <header class="header">
    <button type="button" class="back" onclick={back} aria-label="Zurück zur Liste"><Icon name="back" /></button>
    <h1>{isNewRoute && !reportId ? 'Neuer Bericht' : 'Servicebericht'}</h1>
    {#if savedPulseVisible}
      <span class="saved"><Icon name="check" size={14} />Gespeichert</span>
    {/if}
    {#if reportId}
      <button
        type="button"
        class="export-report"
        onclick={exportReport}
        disabled={exporting}
        aria-label="Als Word-Dokument exportieren"
      >
        {#if exporting}…{:else}<Icon name="download" />{/if}
      </button>
      <button type="button" class="delete-report" onclick={removeReport} aria-label="Bericht löschen">
        <Icon name="trash" />
      </button>
    {/if}
  </header>
  {#if exportError}
    <p class="export-error">Export fehlgeschlagen. Bitte erneut versuchen.</p>
  {/if}

  {#if loading}
    <p class="hint">Lade Bericht…</p>
  {:else if notFound}
    <div class="empty">
      <p>Dieser Bericht wurde nicht gefunden.</p>
      <button type="button" class="primary" onclick={() => navigate('/', { replace: true })}>Zur Übersicht</button>
    </div>
  {:else}
    <div class="content">
      {#if locked}
        <div class="locked-banner" class:signed={!!signedAt} class:finalized={!signedAt}>
          <p>
            <Icon name="lock" size={15} />
            {#if signedAt}
              Unterschrieben am {new Date(signedAt).toLocaleString('de-DE')}{signedByName ? ` von ${signedByName}` : ''} – der Bericht ist gesperrt.
            {:else}
              Final abgeschlossen am {finalizedAt ? new Date(finalizedAt).toLocaleString('de-DE') : ''} (ohne Unterschrift) – der Bericht ist gesperrt.
            {/if}
          </p>
          <button type="button" class="unlock" onclick={unlockManually}><Icon name="unlock" size={15} />Sperre aufheben</button>
        </div>
      {/if}
      {#if reportId}
        <div class="header-row">
          <button
            type="button"
            class="fields-toggle"
            onclick={() => (fieldsExpanded = !fieldsExpanded)}
            aria-expanded={fieldsExpanded}
          >
            <span class="fields-toggle-text">
              <strong>{projectNumber || 'Ohne Projektnummer'}</strong>
              {#if customer}<span class="fields-toggle-customer"> · {customer}</span>{/if}
            </span>
            <span class="chevron" class:open={fieldsExpanded}><Icon name="chevron-down" size={16} /></span>
          </button>
          {#if projectVisitInfo}
            <button
              type="button"
              class="visit-badge"
              class:open={relatedReportsOpen}
              onclick={() => (relatedReportsOpen = !relatedReportsOpen)}
              aria-expanded={relatedReportsOpen}
              aria-label="{relatedReportsOpen ? 'Verknüpfte Berichte einklappen' : 'Verknüpfte Berichte anzeigen'} ({projectVisitInfo.index}. von {projectVisitInfo.total})"
            >
              {projectVisitInfo.index}. von {projectVisitInfo.total}
              <Icon name="chevron-down" size={12} />
            </button>
          {/if}
        </div>
        {#if relatedReportsOpen && projectVisitInfo}
          <ul class="related-reports">
            {#each relatedReports as related, i (related.id)}
              {@const isCurrent = related.id === reportId}
              <li>
                <button
                  type="button"
                  class="related-report-row"
                  class:current={isCurrent}
                  disabled={isCurrent}
                  onclick={() => navigate(`/reports/${related.id}`)}
                >
                  <span class="related-report-label">
                    {i + 1}. Bericht · {formatDateTimeDE(related.createdAt)}
                    {#if isCurrent}<span class="related-report-current-tag">(aktuell geöffnet)</span>{/if}
                  </span>
                  <StatusBadge status={related.status} signed={!!related.signedAt} locked={!!related.finalizedAt} />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
      {#if !reportId || fieldsExpanded}
      <div class="fields">
        <label class:invalid={projectNumberMissing}>
          Projektnummer *
          <input
            type="text"
            bind:value={projectNumber}
            oninput={onFieldChange}
            onblur={checkForDuplicateProjectNumber}
            placeholder="z.B. 2026-0142"
            required
            disabled={locked}
          />
        </label>
        {#if projectNumberMissing}
          <p class="field-hint">Bitte zuerst eine Projektnummer eingeben.</p>
        {/if}

        <label>
          Kurzbeschreibung
          <input
            type="text"
            bind:value={projectDescription}
            oninput={onFieldChange}
            onblur={flushNow}
            placeholder="z.B. Zählerschrank-Sanierung EG"
            disabled={locked}
          />
        </label>

        <label>
          Kunde
          <input
            type="text"
            bind:value={customer}
            oninput={onFieldChange}
            onblur={flushNow}
            placeholder="Firma"
            disabled={locked}
          />
        </label>

        <label>
          Ansprechpartner (Kunde)
          <input
            type="text"
            bind:value={contactPerson}
            oninput={onFieldChange}
            onblur={flushNow}
            placeholder="Name des Ansprechpartners vor Ort"
            disabled={locked}
          />
        </label>

        <label>
          Techniker
          <input
            type="text"
            bind:value={technicianName}
            oninput={onTechnicianNameInput}
            onblur={flushNow}
            placeholder="Dein Name"
            disabled={locked}
          />
        </label>

        <label>
          Geplante Mannstunden (optional)
          <input
            type="text"
            inputmode="decimal"
            bind:value={plannedLaborHours}
            oninput={onFieldChange}
            onblur={flushNow}
            placeholder="z.B. 16"
            disabled={locked}
          />
        </label>

        <div class="status-row">
          <button
            type="button"
            class="status-toggle"
            class:completed={status === 'completed' && !locked}
            class:signed={locked && !!signedAt}
            class:finalized={locked && !signedAt}
            onclick={toggleStatus}
            disabled={locked}
          >
            {#if locked && signedAt}
              <Icon name="lock" size={14} />Unterschrieben
            {:else if locked}
              <Icon name="lock" size={14} />Final abgeschlossen
            {:else if status === 'open'}
              <Icon name="circle" size={14} />Offen
            {:else}
              <Icon name="check" size={14} />Abgeschlossen
            {/if}
          </button>
          {#if !locked}
            <button type="button" class="finalize-btn" onclick={finalizeWithoutSignature}>
              <Icon name="lock" size={14} />Ohne Unterschrift final abschließen
            </button>
          {/if}
        </div>
      </div>
      {/if}

      <div class="tabs" role="tablist" aria-label="Bereich wählen">
        <button type="button" class:active={activeTab === 'übersicht'} onclick={() => (activeTab = 'übersicht')}>
          Übersicht
        </button>
        <button type="button" class:active={activeTab === 'zeiten'} onclick={() => openSectionTab('zeiten')}>
          Zeiten
        </button>
        <button type="button" class:active={activeTab === 'material'} onclick={() => openSectionTab('material')}>
          Material
        </button>
        <button type="button" class:active={activeTab === 'fotos'} onclick={() => openSectionTab('fotos')}>
          Fotos
        </button>
        <button
          type="button"
          class:active={activeTab === 'unterschrift'}
          onclick={() => openSectionTab('unterschrift')}
        >
          Unterschrift
        </button>
      </div>

      <div class="tab-content">
        {#if activeTab === 'übersicht'}
          <div class="overview">
            {#if reportId}
              <TimeClock {reportId} {locked} onChanged={refreshSummary} />
            {/if}
            <div class="stats">
              <div class="stat"><strong>{timeEntryCount}</strong><span>Tage</span></div>
              <div class="stat"><strong>{formatDurationMinutes(totalDurationMinutes)}</strong><span>Zeit gesamt</span></div>
              <div class="stat"><strong>{materialItemCount}</strong><span>Material-Positionen</span></div>
              <div class="stat"><strong>{photoCount}</strong><span>Fotos</span></div>
            </div>
            {#if laborBudget}
              <div class="labor-budget" class:warn={laborBudget.level === 'warn'} class:over={laborBudget.level === 'over'}>
                <div class="labor-budget-row">
                  <span>Mannstunden</span>
                  <span
                    >{formatHoursDE(laborBudget.usedHours)} von {formatHoursDE(laborBudget.planned)} ({Math.round(
                      laborBudget.ratio * 100
                    )} %)</span
                  >
                </div>
                <div class="labor-budget-bar">
                  <div class="labor-budget-fill" style:width="{Math.min(laborBudget.ratio, 1) * 100}%"></div>
                </div>
              </div>
            {/if}
            <label>
              Notizen
              <textarea
                rows="5"
                bind:value={notes}
                oninput={onFieldChange}
                onblur={flushNow}
                placeholder="Allgemeine Notizen zum Einsatz…"
                disabled={locked}
              ></textarea>
            </label>
          </div>
        {:else if activeTab === 'zeiten' && reportId}
          <TimeEntrySection {reportId} {locked} onChanged={refreshSummary} />
        {:else if activeTab === 'material' && reportId}
          <MaterialSection {reportId} {locked} onChanged={refreshSummary} />
        {:else if activeTab === 'fotos' && reportId}
          <PhotoSection {reportId} {locked} onChanged={refreshSummary} />
        {:else if activeTab === 'unterschrift' && reportId}
          <SignatureSection
            {signatureBlob}
            {signedByName}
            {signedAt}
            defaultName={contactPerson}
            onSave={saveSignature}
            onClear={clearSignature}
          />
        {/if}
      </div>
    </div>
  {/if}
</div>

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

  .back,
  .export-report,
  .delete-report {
    background: transparent;
    border: none;
    font-size: 1.2rem;
    padding: var(--space-2);
    min-height: auto;
  }

  .export-report:disabled {
    opacity: 0.5;
  }

  .delete-report {
    color: var(--color-danger);
  }

  .saved {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 0.8rem;
    color: var(--color-success);
    font-weight: 600;
    white-space: nowrap;
  }

  .export-error {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    color: var(--color-danger);
    font-size: 0.85rem;
    text-align: center;
  }

  .hint {
    color: var(--color-text-muted);
    text-align: center;
    margin-top: var(--space-6);
  }

  .empty {
    text-align: center;
    margin-top: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    align-items: center;
  }

  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
  }

  .locked-banner {
    margin: var(--space-4) var(--space-4) 0;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: flex-start;
  }

  /* Unterschrieben vs. manuell final abgeschlossen bekommen bewusst
     unterschiedliche Farben - siehe StatusBadge.svelte. */
  .locked-banner.signed {
    background: var(--color-signed-bg);
    color: var(--color-signed);
  }

  .locked-banner.finalized {
    background: var(--color-finalized-bg);
    color: var(--color-finalized);
  }

  .locked-banner p {
    margin: 0;
    font-weight: 600;
    line-height: 1.4;
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }

  .locked-banner .unlock {
    background: transparent;
    border: 1px solid currentColor;
    color: inherit;
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    min-height: auto;
    font-weight: 600;
    font-size: 0.8rem;
  }

  .header-row {
    display: flex;
    align-items: stretch;
    gap: var(--space-2);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }

  .fields-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    padding: var(--space-4);
    text-align: left;
    min-height: auto;
  }

  .fields-toggle-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fields-toggle-customer {
    color: var(--color-text-muted);
    font-weight: 400;
  }

  .visit-badge {
    display: flex;
    align-items: center;
    align-self: center;
    flex-shrink: 0;
    gap: 3px;
    margin-right: var(--space-3);
    padding: 3px var(--space-2);
    border: none;
    border-radius: 999px;
    background: var(--color-surface-muted);
    color: var(--color-text-muted);
    font-size: 0.7rem;
    font-weight: 600;
    min-height: auto;
  }

  .visit-badge :global(svg) {
    transition: transform 0.15s ease;
  }

  .visit-badge.open :global(svg) {
    transform: rotate(180deg);
  }

  .chevron {
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform 0.15s ease;
  }

  .chevron.open {
    transform: rotate(180deg);
  }

  .related-reports {
    list-style: none;
    margin: 0;
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }

  .related-report-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    background: var(--color-surface-muted);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    text-align: left;
    min-height: auto;
    font-size: 0.85rem;
  }

  .related-report-row.current {
    border-color: var(--color-primary);
    opacity: 0.7;
  }

  .related-report-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .related-report-current-tag {
    color: var(--color-text-muted);
    font-weight: 400;
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
  }

  .fields input:disabled,
  .overview textarea:disabled {
    opacity: 0.7;
  }

  .status-toggle:disabled {
    opacity: 0.7;
  }

  .fields label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: 0.85rem;
    color: var(--color-text-muted);
  }

  .fields label.invalid input {
    border-color: var(--color-danger);
  }

  .field-hint {
    margin: calc(var(--space-2) * -1) 0 0;
    font-size: 0.8rem;
    color: var(--color-danger);
  }

  .status-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .status-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    align-self: flex-start;
    background: var(--color-open-bg);
    color: var(--color-open);
    border: none;
    border-radius: 999px;
    padding: var(--space-2) var(--space-4);
    font-weight: 600;
    min-height: auto;
  }

  .finalize-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px dashed var(--color-border);
    color: var(--color-text-muted);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-4);
    font-size: 0.8rem;
    font-weight: 600;
    min-height: auto;
  }

  .status-toggle.completed {
    background: var(--color-completed-bg);
    color: var(--color-completed);
  }

  .status-toggle.signed {
    background: var(--color-signed-bg);
    color: var(--color-signed);
  }

  .status-toggle.finalized {
    background: var(--color-finalized-bg);
    color: var(--color-finalized);
  }

  .tabs {
    display: flex;
    border-bottom: 1px solid var(--color-border);
    padding: 0 var(--space-2);
    overflow-x: auto;
  }

  .tabs button {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    padding: var(--space-3) var(--space-3);
    color: var(--color-text-muted);
    font-weight: 600;
    min-height: auto;
    white-space: nowrap;
  }

  .tabs button.active {
    color: var(--color-primary);
    border-bottom-color: var(--color-primary);
  }

  .tab-content {
    padding: var(--space-4);
    padding-bottom: calc(var(--space-6) + var(--safe-bottom));
  }

  .overview {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-3);
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
    font-size: 1.2rem;
  }

  .stat span {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .labor-budget {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .labor-budget-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-2);
    font-size: 0.85rem;
  }

  .labor-budget-row span:first-child {
    font-weight: 600;
  }

  .labor-budget-row span:last-child {
    color: var(--color-text-muted);
    font-size: 0.8rem;
  }

  .labor-budget-bar {
    height: 8px;
    background: var(--color-surface-muted);
    border-radius: 999px;
    overflow: hidden;
  }

  .labor-budget-fill {
    height: 100%;
    border-radius: 999px;
    background: var(--color-success);
    transition: width 0.2s ease;
  }

  .labor-budget.warn .labor-budget-fill {
    background: var(--color-open);
  }

  .labor-budget.over .labor-budget-fill {
    background: var(--color-danger);
  }

  .labor-budget.warn .labor-budget-row span:last-child {
    color: var(--color-open);
    font-weight: 600;
  }

  .labor-budget.over .labor-budget-row span:last-child {
    color: var(--color-danger);
    font-weight: 600;
  }

  .overview label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: 0.85rem;
    color: var(--color-text-muted);
  }

  .primary {
    background: var(--color-primary);
    color: var(--color-primary-contrast);
    border: none;
    border-radius: var(--radius-sm);
    padding: var(--space-3) var(--space-5);
    font-weight: 600;
  }
</style>
