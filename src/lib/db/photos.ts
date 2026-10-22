import { getDB } from './client';
import { recomputeReportSummary } from './summary';
import type { ID, Photo } from './types';

const ALL_STORES = ['photos', 'timeEntries', 'materialItems', 'reports'] as const;

export interface PhotoInput {
  blob: Blob;
  thumbnailBlob: Blob;
  mimeType: string;
  width?: number;
  height?: number;
  sizeBytes: number;
  takenAt?: string;
}

/** Foto-Metadaten (inkl. Blobs) eines Berichts, chronologisch sortiert. */
export async function listPhotos(reportId: ID): Promise<Photo[]> {
  const db = await getDB();
  const photos = await db.getAllFromIndex('photos', 'reportId', reportId);
  return photos.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
}

export async function getPhoto(id: ID): Promise<Photo | undefined> {
  const db = await getDB();
  return db.get('photos', id);
}

export async function addPhoto(reportId: ID, input: PhotoInput): Promise<Photo> {
  const db = await getDB();
  const now = new Date().toISOString();
  const photo: Photo = {
    id: crypto.randomUUID(),
    reportId,
    blob: input.blob,
    thumbnailBlob: input.thumbnailBlob,
    mimeType: input.mimeType,
    width: input.width,
    height: input.height,
    sizeBytes: input.sizeBytes,
    takenAt: input.takenAt ?? now
  };

  const tx = db.transaction(ALL_STORES, 'readwrite');
  await tx.objectStore('photos').put(photo);
  await recomputeReportSummary(tx, reportId, now);
  await tx.done;
  return photo;
}

/** Aktualisiert bislang nur `note` (eigene Notiz zu genau diesem Foto) - bei Bedarf um weitere Felder erweiterbar. */
export async function updatePhoto(id: ID, patch: { note?: string }): Promise<Photo | undefined> {
  const db = await getDB();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  const store = tx.objectStore('photos');
  const photo = await store.get(id);
  if (!photo) {
    await tx.done;
    return undefined;
  }

  if (patch.note !== undefined) photo.note = patch.note.trim() || undefined;

  await store.put(photo);
  await recomputeReportSummary(tx, photo.reportId);
  await tx.done;
  return photo;
}

export async function deletePhoto(id: ID): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  const store = tx.objectStore('photos');
  const photo = await store.get(id);
  if (!photo) {
    await tx.done;
    return;
  }
  await store.delete(id);
  await recomputeReportSummary(tx, photo.reportId);
  await tx.done;
}
