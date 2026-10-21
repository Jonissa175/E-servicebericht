<script lang="ts">
  import { addMaterialItem, deleteMaterialItem, listMaterialItems, updateMaterialItem } from '../db/materialItems';
  import type { MaterialItem } from '../db/types';
  import { STANDARD_MATERIALS } from '../materialCatalog';
  import { parseScannedMaterialLabel } from '../utils/materialScan';
  import { parseLabelText } from '../utils/labelOcr';
  import Icon from './Icon.svelte';
  import BarcodeScanner from './BarcodeScanner.svelte';

  let { reportId, locked = false, onChanged }: { reportId: string; locked?: boolean; onChanged: () => void } = $props();

  const commonUnits = ['Stk', 'm', 'Set', 'Std', 'kg', 'lfm', 'Pkg'];
  const unitByDescription = new Map(STANDARD_MATERIALS.map((entry) => [entry.description, entry.unit]));
  let descriptionOptions = $state<string[]>(STANDARD_MATERIALS.map((entry) => entry.description));
  let unitTouched = $state(false);

  let items = $state<MaterialItem[]>([]);
  let loading = $state(true);
  let showForm = $state(false);
  let editingId = $state<string | undefined>();

  let formDescription = $state('');
  let formQuantity = $state('1');
  let formUnit = $state('Stk');
  let formArticleNumber = $state('');
  // Erwartete/geplante Menge laut importiertem Serviceauftrag (siehe
  // src/lib/import/importServiceOrder.ts) - nur beim Bearbeiten einer
  // IMPORTIERTEN Position gesetzt (leer bei manuell angelegten Positionen,
  // dort gibt es kein "Soll" und das Feld bleibt entsprechend ausgeblendet).
  // `formHasPlannedQuantity` steuert bewusst getrennt von `formPlannedQuantity`
  // selbst, OB das Feld überhaupt angezeigt wird - sonst würde es beim
  // Leeren des Eingabefelds (z.B. um den Soll-Wert bewusst zu entfernen)
  // mitten in der Bearbeitung verschwinden, da ein leerer String sonst
  // selbst als "nicht gesetzt" durchginge.
  let formPlannedQuantity = $state('');
  let formHasPlannedQuantity = $state(false);

  let scannerOpen = $state(false);
  // Rohtext des zuletzt gescannten Codes, solange das Formular dadurch
  // vorausgefüllt wurde - wird als Hinweis unter dem Formular angezeigt,
  // damit die Bezeichnung (die ein Barcode i.d.R. nicht enthält, siehe
  // parseScannedMaterialLabel()) leicht vom Etikett abgetippt werden kann.
  let lastScanRaw = $state<string | undefined>();

  async function load(): Promise<void> {
    loading = true;
    items = await listMaterialItems(reportId);
    loading = false;
    // Vorschlagsliste wächst um bereits in diesem Bericht verwendete
    // Bezeichnungen, zusätzlich zum Standard-Materialstamm (dedupliziert).
    const used = items.map((item) => item.description);
    descriptionOptions = [...new Set([...STANDARD_MATERIALS.map((entry) => entry.description), ...used])];
  }

  $effect(() => {
    reportId;
    load();
  });

  function resetForm(): void {
    formDescription = '';
    formQuantity = '1';
    formUnit = 'Stk';
    formArticleNumber = '';
    formPlannedQuantity = '';
    formHasPlannedQuantity = false;
    editingId = undefined;
    showForm = false;
    unitTouched = false;
    lastScanRaw = undefined;
  }

  function startAdd(): void {
    resetForm();
    showForm = true;
  }

  function startEdit(item: MaterialItem): void {
    editingId = item.id;
    formDescription = item.description;
    formQuantity = String(item.quantity);
    formUnit = item.unit;
    formArticleNumber = item.articleNumber ?? '';
    formPlannedQuantity = item.plannedQuantity !== undefined ? String(item.plannedQuantity) : '';
    formHasPlannedQuantity = item.plannedQuantity !== undefined;
    unitTouched = true; // Einheit eines bestehenden Eintrags nicht durch Katalog-Match überschreiben.
    lastScanRaw = undefined;
    showForm = true;
  }

  function openScanner(): void {
    scannerOpen = true;
  }

  /**
   * Übernimmt das Scan-Ergebnis des Lieferanten-Etiketts (z.B. Sonepar) in
   * ein neues Formular - Artikelnummer und Menge werden automatisch
   * vorausgefüllt, sofern der Code sie enthielt (siehe
   * parseScannedMaterialLabel()); die Bezeichnung bleibt bewusst leer zum
   * Abtippen vom Etikett, da Barcodes/QR-Codes so gut wie nie Freitext
   * transportieren. Alle Felder bleiben wie gewohnt editierbar, bevor
   * gespeichert wird.
   */
  function handleScanResult(rawText: string): void {
    scannerOpen = false;
    const parsed = parseScannedMaterialLabel(rawText);
    resetForm();
    if (parsed.articleNumber) formArticleNumber = parsed.articleNumber;
    if (parsed.quantity !== undefined) formQuantity = String(parsed.quantity);
    lastScanRaw = parsed.raw;
    showForm = true;
  }

  /**
   * Übernimmt das Ergebnis der Etikett-Text-Erkennung (OCR, siehe
   * BarcodeScanner.svelte "Etikett-Text"-Modus) in ein neues Formular -
   * anders als beim reinen Code-Scan (handleScanResult()) steht auf dem
   * Etikett gedruckter Text häufig auch die Beschreibung, daher füllt
   * parseLabelText() hier zusätzlich formDescription, sofern erkannt. OCR
   * ist fehleranfälliger als ein exakt dekodierter Code - alle Felder
   * bleiben deshalb genauso editierbar wie beim Code-Scan.
   */
  function handleOcrResult(rawText: string): void {
    scannerOpen = false;
    const parsed = parseLabelText(rawText);
    resetForm();
    if (parsed.description) formDescription = parsed.description;
    if (parsed.articleNumber) formArticleNumber = parsed.articleNumber;
    if (parsed.quantity !== undefined) formQuantity = String(parsed.quantity);
    lastScanRaw = parsed.raw;
    showForm = true;
  }

  /** Übernimmt bei einer Katalog-Bezeichnung automatisch die hinterlegte Einheit, sofern der Nutzer sie noch nicht selbst geändert hat. */
  function onDescriptionInput(): void {
    if (unitTouched) return;
    const suggestedUnit = unitByDescription.get(formDescription.trim());
    if (suggestedUnit) formUnit = suggestedUnit;
  }

  function onUnitInput(): void {
    unitTouched = true;
  }

  async function save(): Promise<void> {
    const description = formDescription.trim();
    const quantity = Number(formQuantity.replace(',', '.'));
    if (!description || !Number.isFinite(quantity) || quantity <= 0) return;

    const trimmedPlanned = formHasPlannedQuantity ? formPlannedQuantity.trim() : '';
    const plannedQuantity = trimmedPlanned ? Number(trimmedPlanned.replace(',', '.')) : undefined;

    const payload = {
      description,
      quantity,
      unit: formUnit.trim() || 'Stk',
      articleNumber: formArticleNumber,
      plannedQuantity: plannedQuantity !== undefined && Number.isFinite(plannedQuantity) ? plannedQuantity : undefined
    };
    if (editingId) {
      await updateMaterialItem(editingId, payload);
    } else {
      await addMaterialItem(reportId, payload);
    }
    resetForm();
    await load();
    onChanged();
  }

  async function remove(item: MaterialItem): Promise<void> {
    if (!confirm('Diese Materialposition löschen?')) return;
    await deleteMaterialItem(item.id);
    if (editingId === item.id) resetForm();
    await load();
    onChanged();
  }

  /** "4 Stk · geplant 5 Stk · Art.-Nr. ..." - die geplante Menge (falls per Serviceauftrag-Import gesetzt) nur zum Abgleich, keine eigene Validierung. */
  function formatMeta(item: MaterialItem): string {
    const parts = [`${item.quantity} ${item.unit}`];
    if (item.plannedQuantity !== undefined) parts.push(`geplant ${item.plannedQuantity} ${item.unit}`);
    if (item.articleNumber) parts.push(`Art.-Nr. ${item.articleNumber}`);
    return parts.join(' · ');
  }
</script>

<div class="section">
  {#if loading}
    <p class="hint">Lade Material…</p>
  {:else}
    {#if items.length === 0 && !showForm}
      <p class="hint">Noch kein Material erfasst.</p>
    {/if}
    {#if items.length > 0}
      <ul class="list">
        {#each items as item (item.id)}
          <li class="row">
            {#if locked}
              <div class="row-main">
                <span class="desc">{item.description}</span>
                <span class="meta">{formatMeta(item)}</span>
              </div>
            {:else}
              <button type="button" class="row-main" onclick={() => startEdit(item)}>
                <span class="desc">{item.description}</span>
                <span class="meta">{formatMeta(item)}</span>
              </button>
              <button type="button" class="delete" aria-label="Position löschen" onclick={() => remove(item)}>
                <Icon name="trash" />
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#if locked}
    <p class="hint">Bericht ist gesperrt – Material kann nicht mehr geändert werden.</p>
  {:else if showForm}
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        Bezeichnung
        <input
          type="text"
          list="description-options"
          bind:value={formDescription}
          oninput={onDescriptionInput}
          placeholder="z.B. Kabel NYM-J 3x1,5"
          required
        />
        <datalist id="description-options">
          {#each descriptionOptions as description (description)}
            <option value={description}></option>
          {/each}
        </datalist>
      </label>
      <div class="two-col">
        <label>
          {formHasPlannedQuantity ? 'Menge (verbaut)' : 'Menge'}
          <input type="text" inputmode="decimal" bind:value={formQuantity} />
        </label>
        <label>
          Einheit
          <input type="text" list="unit-options" bind:value={formUnit} oninput={onUnitInput} />
          <datalist id="unit-options">
            {#each commonUnits as unit (unit)}
              <option value={unit}></option>
            {/each}
          </datalist>
        </label>
      </div>
      {#if formHasPlannedQuantity}
        <label>
          Geplant laut Serviceauftrag
          <input type="text" inputmode="decimal" bind:value={formPlannedQuantity} />
        </label>
      {/if}
      <label>
        Artikelnummer (optional)
        <input type="text" bind:value={formArticleNumber} />
      </label>
      {#if lastScanRaw}
        <p class="scan-hint">
          {#if formDescription}
            Aus Scan übernommen (bitte prüfen): <span>{lastScanRaw}</span>
          {:else}
            Aus Scan übernommen (Bezeichnung bitte vom Etikett abtippen): <span>{lastScanRaw}</span>
          {/if}
        </p>
      {/if}
      <div class="form-actions">
        <button type="button" class="ghost" onclick={resetForm}>Abbrechen</button>
        <button type="submit" class="primary">Speichern</button>
      </div>
    </form>
  {:else}
    <div class="add-row">
      <button type="button" class="add" onclick={startAdd}>+ Position hinzufügen</button>
      <button type="button" class="scan" onclick={openScanner} aria-label="Material per Scan erfassen">
        <Icon name="camera" size={18} />
        Scannen
      </button>
    </div>
  {/if}
</div>

{#if scannerOpen}
  <BarcodeScanner onScan={handleScanResult} onOcrText={handleOcrResult} onClose={() => (scannerOpen = false)} />
{/if}

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

  .desc {
    font-weight: 600;
  }

  .meta {
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

  .add-row {
    display: flex;
    gap: var(--space-2);
  }

  .add {
    flex: 1;
    background: var(--color-surface);
    border: 1px dashed var(--color-primary);
    color: var(--color-primary);
    border-radius: var(--radius-md);
    font-weight: 600;
  }

  .scan {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    background: var(--color-surface);
    border: 1px dashed var(--color-primary);
    color: var(--color-primary);
    border-radius: var(--radius-md);
    font-weight: 600;
    padding: 0 var(--space-3);
  }

  .scan-hint {
    font-size: 0.8rem;
    color: var(--color-text-muted);
    background: var(--color-surface-muted);
    border-radius: var(--radius-sm);
    padding: var(--space-2);
    margin: 0;
  }

  .scan-hint span {
    font-weight: 600;
    word-break: break-all;
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
