<script lang="ts">
  import { addPhoto, deletePhoto, listPhotos, updatePhoto } from '../db/photos';
  import type { Photo } from '../db/types';
  import { createThumbnail } from '../utils/image';
  import Icon from './Icon.svelte';

  let { reportId, locked = false, onChanged }: { reportId: string; locked?: boolean; onChanged: () => void } = $props();

  let photos = $state<Photo[]>([]);
  let loading = $state(true);
  let uploading = $state(false);
  let uploadError = $state<string | undefined>();
  let thumbnailUrls = $state<Record<string, string>>({});
  // Lokaler Entwurf der Foto-Notizen, getrennt von `photos` - wie bei den
  // übrigen Textfeldern in der App (z.B. ReportDetail.svelte) tippt man in
  // ein eigenes State-Objekt, nicht direkt in die geladene Liste, und
  // speichert erst onblur.
  let noteDrafts = $state<Record<string, string>>({});

  let viewerPhoto = $state<Photo | undefined>();
  let viewerUrl = $state<string | undefined>();

  let cameraInput: HTMLInputElement | undefined;
  let libraryInput: HTMLInputElement | undefined;

  // Bewusst NICHT reaktiv (kein $state): reine Bookkeeping-Liste zum
  // Aufräumen der Object-URLs. Würde man stattdessen `thumbnailUrls`
  // sowohl lesen (zum Revoken) als auch schreiben innerhalb desselben
  // $effect, entsteht eine Endlosschleife ("effect reads and writes the
  // same piece of state" / effect_update_depth_exceeded).
  let activeObjectUrls: string[] = [];

  function revokeAllThumbnails(): void {
    for (const url of activeObjectUrls) URL.revokeObjectURL(url);
    activeObjectUrls = [];
    thumbnailUrls = {};
  }

  async function load(): Promise<void> {
    loading = true;
    revokeAllThumbnails();
    const loaded = await listPhotos(reportId);
    const nextThumbnailUrls: Record<string, string> = {};
    const nextObjectUrls: string[] = [];
    const nextNoteDrafts: Record<string, string> = {};
    for (const photo of loaded) {
      const url = URL.createObjectURL(photo.thumbnailBlob);
      nextThumbnailUrls[photo.id] = url;
      nextObjectUrls.push(url);
      nextNoteDrafts[photo.id] = photo.note ?? '';
    }
    photos = loaded;
    thumbnailUrls = nextThumbnailUrls;
    activeObjectUrls = nextObjectUrls;
    noteDrafts = nextNoteDrafts;
    loading = false;
  }

  /** Speichert die Notiz GENAU dieses einen Fotos - unabhängig von allen anderen Fotos. */
  async function savePhotoNote(photoId: string): Promise<void> {
    const draft = noteDrafts[photoId] ?? '';
    const updated = await updatePhoto(photoId, { note: draft });
    if (!updated) return;
    photos = photos.map((photo) => (photo.id === photoId ? updated : photo));
  }

  $effect(() => {
    reportId;
    load();
    return () => revokeAllThumbnails();
  });

  // Sicherheitsnetz: Vollbild-Objekt-URL beim Verlassen des Screens freigeben,
  // auch wenn der Viewer nie explizit geschlossen wurde.
  $effect(() => {
    return () => {
      if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    };
  });

  async function handleFiles(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) return;
    uploading = true;
    uploadError = undefined;
    try {
      for (const file of Array.from(fileList)) {
        const { thumbnailBlob, width, height } = await createThumbnail(file);
        await addPhoto(reportId, {
          blob: file,
          thumbnailBlob,
          mimeType: file.type || 'image/jpeg',
          width,
          height,
          sizeBytes: file.size
        });
      }
      await load();
      onChanged();
    } catch (error) {
      console.error('Foto konnte nicht verarbeitet werden', error);
      uploadError = 'Foto konnte nicht verarbeitet werden. Bitte erneut versuchen.';
    } finally {
      uploading = false;
    }
  }

  function openViewer(photo: Photo): void {
    viewerPhoto = photo;
    viewerUrl = URL.createObjectURL(photo.blob);
  }

  function closeViewer(): void {
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = undefined;
    viewerPhoto = undefined;
  }

  async function removeCurrent(): Promise<void> {
    if (!viewerPhoto || locked) return;
    if (!confirm('Dieses Foto endgültig löschen?')) return;
    const id = viewerPhoto.id;
    closeViewer();
    await deletePhoto(id);
    await load();
    onChanged();
  }
</script>

<div class="section">
  {#if locked}
    <p class="hint">Bericht ist gesperrt – Fotos können nicht mehr geändert werden.</p>
  {:else}
    <div class="upload-buttons">
      <button type="button" onclick={() => cameraInput?.click()} disabled={uploading}>
        <Icon name="camera" />Kamera
      </button>
      <button type="button" onclick={() => libraryInput?.click()} disabled={uploading}>
        <Icon name="image" />Bibliothek
      </button>
    </div>
  {/if}

  <input
    bind:this={cameraInput}
    type="file"
    accept="image/*"
    capture="environment"
    class="visually-hidden"
    onchange={(event) => {
      void handleFiles(event.currentTarget.files);
      event.currentTarget.value = '';
    }}
  />
  <input
    bind:this={libraryInput}
    type="file"
    accept="image/*"
    multiple
    class="visually-hidden"
    onchange={(event) => {
      void handleFiles(event.currentTarget.files);
      event.currentTarget.value = '';
    }}
  />

  {#if uploading}<p class="hint">Foto wird verarbeitet…</p>{/if}
  {#if uploadError}<p class="error">{uploadError}</p>{/if}

  {#if loading}
    <p class="hint">Lade Fotos…</p>
  {:else if photos.length === 0}
    <p class="hint">Noch keine Fotos vorhanden.</p>
  {:else}
    <div class="photo-list">
      {#each photos as photo (photo.id)}
        <div class="photo-row">
          <button type="button" class="thumb" onclick={() => openViewer(photo)}>
            <img src={thumbnailUrls[photo.id]} alt="Einsatzfoto" loading="lazy" />
          </button>
          <label class="note-label">
            Notiz zu diesem Foto
            <textarea
              rows="2"
              bind:value={noteDrafts[photo.id]}
              onblur={() => savePhotoNote(photo.id)}
              placeholder="Was zeigt dieses Foto?"
              disabled={locked}
            ></textarea>
          </label>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if viewerPhoto && viewerUrl}
  <div class="viewer" role="dialog" aria-modal="true">
    <img src={viewerUrl} alt="Einsatzfoto in Vollansicht" />
    <div class="viewer-actions">
      {#if !locked}
        <button type="button" class="delete" onclick={removeCurrent}><Icon name="trash" />Löschen</button>
      {/if}
      <button type="button" class="close" onclick={closeViewer}>Schließen</button>
    </div>
  </div>
{/if}

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .upload-buttons {
    display: flex;
    gap: var(--space-3);
  }

  .upload-buttons button {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-weight: 600;
  }

  .hint {
    color: var(--color-text-muted);
    text-align: center;
    margin: var(--space-4) 0;
  }

  .error {
    color: var(--color-danger);
    text-align: center;
  }

  .photo-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .photo-row {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
  }

  .thumb {
    flex: 0 0 auto;
    width: 84px;
    height: 84px;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    min-height: auto;
    background: var(--color-surface-muted);
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .note-label {
    flex: 1;
    min-width: 0;
    font-size: 0.85em;
    color: var(--color-text-muted);
  }

  .note-label textarea {
    width: 100%;
    margin-top: 4px;
    resize: vertical;
  }

  .viewer {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.92);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: var(--space-4);
    padding-top: calc(var(--space-4) + var(--safe-top));
    padding-bottom: calc(var(--space-4) + var(--safe-bottom));
  }

  .viewer img {
    max-width: 100%;
    max-height: 75vh;
    object-fit: contain;
    border-radius: var(--radius-sm);
  }

  .viewer-actions {
    display: flex;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }

  .viewer-actions button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: var(--space-2) var(--space-5);
    border-radius: var(--radius-sm);
    border: none;
    font-weight: 600;
  }

  .viewer-actions .delete {
    background: var(--color-danger);
    color: #fff;
  }

  .viewer-actions .close {
    background: #ffffff22;
    color: #fff;
    border: 1px solid #ffffff55;
  }
</style>
