import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDB } from '../testUtils';
import { addMaterialItem, listMaterialItems, updateMaterialItem } from '../../lib/db/materialItems';
import { createReport } from '../../lib/db/reports';

beforeEach(async () => {
  await resetTestDB();
});

describe('materialItems repository - plannedQuantity (Serviceauftrag-Import, s. importServiceOrder.ts)', () => {
  it('legt eine Position ohne plannedQuantity an, wenn keine übergeben wird (normaler manueller Fall)', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const item = await addMaterialItem(report.id, { description: 'Kabel NYM-J 3x1,5', quantity: 10, unit: 'm' });

    expect(item.plannedQuantity).toBeUndefined();
    const [stored] = await listMaterialItems(report.id);
    expect(stored.plannedQuantity).toBeUndefined();
  });

  it('legt eine importierte Position mit plannedQuantity an und lässt die tatsächliche Menge unabhängig davon bearbeiten', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const item = await addMaterialItem(report.id, {
      description: 'Leitungsführungskanal LF 15x15 vw',
      quantity: 4,
      unit: 'm',
      plannedQuantity: 4
    });

    expect(item.plannedQuantity).toBe(4);

    // Weniger verbaut als geplant - die geplante Menge bleibt als Referenz unverändert stehen.
    const updated = await updateMaterialItem(item.id, { quantity: 3 });
    expect(updated?.quantity).toBe(3);
    expect(updated?.plannedQuantity).toBe(4);
  });

  it('erlaubt, die geplante Menge nachträglich wieder zu entfernen', async () => {
    const report = await createReport({ projectNumber: 'A' });
    const item = await addMaterialItem(report.id, { description: 'Winkel LF-Kanal', quantity: 1, unit: 'Stk', plannedQuantity: 1 });

    const updated = await updateMaterialItem(item.id, { plannedQuantity: undefined });
    expect(updated?.plannedQuantity).toBeUndefined();
  });
});
