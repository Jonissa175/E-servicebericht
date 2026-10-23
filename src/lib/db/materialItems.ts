import { getDB } from './client';
import { recomputeReportSummary } from './summary';
import type { ID, MaterialItem } from './types';

const ALL_STORES = ['materialItems', 'timeEntries', 'photos', 'reports'] as const;

export interface MaterialItemInput {
  description: string;
  quantity: number;
  unit: string;
  articleNumber?: string;
  /** Siehe MaterialItem.plannedQuantity - nur beim Anlegen aus einem importierten Serviceauftrag gesetzt. */
  plannedQuantity?: number;
  /** Siehe MaterialItem.source. */
  source?: MaterialItem['source'];
}

/** Materialpositionen eines Berichts, in Erfassungsreihenfolge. */
export async function listMaterialItems(reportId: ID): Promise<MaterialItem[]> {
  const db = await getDB();
  const items = await db.getAllFromIndex('materialItems', 'reportId', reportId);
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addMaterialItem(reportId: ID, input: MaterialItemInput): Promise<MaterialItem> {
  const db = await getDB();
  const now = new Date().toISOString();
  const item: MaterialItem = {
    id: crypto.randomUUID(),
    reportId,
    description: input.description.trim(),
    quantity: input.quantity,
    unit: input.unit.trim(),
    articleNumber: input.articleNumber?.trim() || undefined,
    plannedQuantity: input.plannedQuantity,
    source: input.source,
    createdAt: now,
    updatedAt: now
  };

  const tx = db.transaction(ALL_STORES, 'readwrite');
  await tx.objectStore('materialItems').put(item);
  await recomputeReportSummary(tx, reportId, now);
  await tx.done;
  return item;
}

export async function updateMaterialItem(id: ID, patch: Partial<MaterialItemInput>): Promise<MaterialItem | undefined> {
  const db = await getDB();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  const store = tx.objectStore('materialItems');
  const item = await store.get(id);
  if (!item) {
    await tx.done;
    return undefined;
  }

  const merged: MaterialItem = {
    ...item,
    ...patch,
    description: patch.description !== undefined ? patch.description.trim() : item.description,
    unit: patch.unit !== undefined ? patch.unit.trim() : item.unit,
    articleNumber: patch.articleNumber !== undefined ? patch.articleNumber.trim() || undefined : item.articleNumber,
    updatedAt: new Date().toISOString()
  };

  await store.put(merged);
  await recomputeReportSummary(tx, item.reportId, merged.updatedAt);
  await tx.done;
  return merged;
}

export async function deleteMaterialItem(id: ID): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  const store = tx.objectStore('materialItems');
  const item = await store.get(id);
  if (!item) {
    await tx.done;
    return;
  }
  await store.delete(id);
  await recomputeReportSummary(tx, item.reportId);
  await tx.done;
}
