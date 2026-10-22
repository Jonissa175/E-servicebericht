import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDB } from '../testUtils';
import { addPhoto, getPhoto, listPhotos, updatePhoto } from '../../lib/db/photos';
import { createReport } from '../../lib/db/reports';

beforeEach(async () => {
  await resetTestDB();
});

function fakeBlob(): Blob {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
}

describe('photos repository - note (eigene Notiz pro Foto)', () => {
  it('legt ein Foto ohne Notiz an (normaler Fall beim Hochladen)', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const photo = await addPhoto(report.id, {
      blob: fakeBlob(),
      thumbnailBlob: fakeBlob(),
      mimeType: 'image/jpeg',
      sizeBytes: 4
    });
    expect(photo.note).toBeUndefined();
  });

  it('trägt eine Notiz nachträglich ein und lässt sie unabhängig von anderen Fotos ändern', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const photoA = await addPhoto(report.id, { blob: fakeBlob(), thumbnailBlob: fakeBlob(), mimeType: 'image/jpeg', sizeBytes: 4 });
    const photoB = await addPhoto(report.id, { blob: fakeBlob(), thumbnailBlob: fakeBlob(), mimeType: 'image/jpeg', sizeBytes: 4 });

    const updatedA = await updatePhoto(photoA.id, { note: 'Sicherung vor dem Austausch' });
    expect(updatedA?.note).toBe('Sicherung vor dem Austausch');

    const updatedB = await updatePhoto(photoB.id, { note: 'Zählerschrank nach der Sanierung' });
    expect(updatedB?.note).toBe('Zählerschrank nach der Sanierung');

    // Die Notiz von Foto A darf durch das Bearbeiten von Foto B nicht verändert worden sein.
    const reloadedA = await getPhoto(photoA.id);
    expect(reloadedA?.note).toBe('Sicherung vor dem Austausch');

    const [listedA, listedB] = await listPhotos(report.id);
    expect(listedA.note).toBe('Sicherung vor dem Austausch');
    expect(listedB.note).toBe('Zählerschrank nach der Sanierung');
  });

  it('erlaubt, eine Notiz nachträglich wieder zu entfernen (leerer String -> undefined)', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const photo = await addPhoto(report.id, { blob: fakeBlob(), thumbnailBlob: fakeBlob(), mimeType: 'image/jpeg', sizeBytes: 4 });
    await updatePhoto(photo.id, { note: 'Erste Notiz' });

    const cleared = await updatePhoto(photo.id, { note: '' });
    expect(cleared?.note).toBeUndefined();
  });

  it('liefert undefined bei unbekannter Foto-ID, ohne zu werfen', async () => {
    const result = await updatePhoto('does-not-exist', { note: 'egal' });
    expect(result).toBeUndefined();
  });
});
