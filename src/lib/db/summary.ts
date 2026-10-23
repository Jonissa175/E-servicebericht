import type { IDBPTransaction } from 'idb';
import type { ID, ISODateTime, ServiceBerichtDB } from './types';

type SummaryStores = ('reports' | 'timeEntries' | 'materialItems' | 'photos')[];
export type SummaryTx = IDBPTransaction<ServiceBerichtDB, SummaryStores, 'readwrite'>;

/**
 * Rechnet die denormalisierten Summary-Felder eines Reports (Anzahl Zeiten/
 * Material/Fotos, Gesamtdauer) aus den aktuellen Kind-Datensätzen neu und
 * schreibt sie zurück. Muss innerhalb derselben Transaktion aufgerufen
 * werden, die den auslösenden Kind-Datensatz verändert hat, damit die
 * Summary nie mit dem eigentlichen Datenbestand auseinanderläuft.
 */
export async function recomputeReportSummary(
  tx: SummaryTx,
  reportId: ID,
  now: ISODateTime = new Date().toISOString()
): Promise<void> {
  const reportsStore = tx.objectStore('reports');
  const report = await reportsStore.get(reportId);
  if (!report) return;

  const [timeEntries, materialItems, photos] = await Promise.all([
    tx.objectStore('timeEntries').index('reportId').getAll(reportId),
    tx.objectStore('materialItems').index('reportId').getAll(reportId),
    tx.objectStore('photos').index('reportId').getAll(reportId)
  ]);

  // Trotz des Namens (historisch gewachsen, s. ServiceReport.timeEntryCount)
  // zählt dies die Anzahl UNTERSCHIEDLICHER Kalendertage, nicht die Anzahl
  // der Zeiteintrags-Datensätze selbst - mehrfaches Ein-/Ausstempeln am
  // selben Tag (z.B. vormittags/nachmittags getrennt) soll die in der
  // Übersicht als "Tage" angezeigte Zahl nicht pro Vorgang erhöhen.
  report.timeEntryCount = new Set(timeEntries.map((entry) => entry.date)).size;
  report.totalDurationMinutes = timeEntries.reduce((sum, entry) => sum + (entry.durationMinutes ?? 0), 0);
  report.materialItemCount = materialItems.length;
  report.photoCount = photos.length;
  report.updatedAt = now;

  await reportsStore.put(report);
}
