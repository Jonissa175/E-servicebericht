import { addMaterialItem, listMaterialItems } from '../db/materialItems';
import { createReport, listReportsByProjectNumber } from '../db/reports';
import type { ServiceReport } from '../db/types';
import { extractPdfText } from './serviceOrderPdf';
import { parseServiceOrderText, type ParsedServiceOrder, type ParsedServiceOrderMaterial } from '../utils/serviceOrderImport';

export interface ServiceOrderImportResult {
  report: ServiceReport;
  parsed: ParsedServiceOrder;
  /** Anzahl neu angelegter Materialpositionen (0, wenn in einen bestehenden Bericht mit bereits vorhandenem Material importiert wurde - siehe unten). */
  materialCount: number;
  /** true, wenn ein bereits offener Bericht mit dieser Projektnummer wiederverwendet wurde, statt einen neuen anzulegen. */
  reused: boolean;
}

/**
 * Baut den Notizen-Text für den neu angelegten Bericht - Serviceauftrags-
 * Nummer zur Rückfrage beim Büro sowie die "Arbeitsaufwand"-Positionen
 * (geplante Stunden/Pauschalen) als reiner Hinweistext, siehe
 * serviceOrderImport.ts: diese sind kein Material und haben keine
 * Entsprechung im Zeiten-Tab (dort wird tatsächlich gestempelt, nicht
 * geplant) - rein informativ für den Monteur vor Ort.
 */
function buildImportNotes(parsed: ParsedServiceOrder): string | undefined {
  const lines: string[] = [];
  if (parsed.documentNumber) lines.push(`Serviceauftrag-Nr. ${parsed.documentNumber} (automatisch importiert)`);
  if (parsed.laborLines.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Geplanter Arbeitsaufwand laut Serviceauftrag:');
    lines.push(...parsed.laborLines.map((line) => `- ${line}`));
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Liest einen Serviceauftrag (PDF) ein und legt daraus automatisch einen
 * neuen Bericht samt vorausgefüllter Materialliste an (erwartete Menge je
 * Position als `plannedQuantity`, siehe db/types.ts) - erspart dem
 * Servicetechniker, Projektnummer, Kundendaten und erwartetes Material von
 * Hand abzutippen. Alle übernommenen Felder bleiben im Bericht wie gewohnt
 * frei editierbar, da die Erkennung (siehe serviceOrderImport.ts) reine
 * Heuristik auf ein festes Vorlagen-Format ist.
 *
 * Existiert bereits ein offener (nicht gesperrter) Bericht mit derselben
 * Projektnummer, wird NICHT automatisch ein Duplikat angelegt: der Nutzer
 * entscheidet per Rückfrage, ob das Material stattdessen dort ergänzt
 * werden soll (derselbe Ablauf wie die bestehende Duplikat-Prüfung beim
 * manuellen Neuanlegen, siehe ReportDetail.svelte
 * checkForDuplicateProjectNumber()) - oder ob trotzdem ein weiterer Bericht
 * zu dieser Projektnummer entstehen soll (z.B. ein Folgeauftrag).
 *
 * Wirft einen Error mit nutzerverständlicher Meldung, wenn im PDF keine
 * Projektnummer gefunden wurde (z.B. falsches/fremdes PDF ausgewählt) -
 * ohne Projektnummer lässt sich kein Bericht sinnvoll anlegen.
 */
export async function importServiceOrderFromFile(file: File, technicianName?: string): Promise<ServiceOrderImportResult> {
  const rawText = await extractPdfText(file);
  const parsed = parseServiceOrderText(rawText);
  if (!parsed.projectNumber) {
    throw new Error(
      'Im PDF wurde keine Projektnummer gefunden - ist das wirklich ein Serviceauftrag im bekannten ELSA-Format?'
    );
  }

  let report: ServiceReport;
  let reused = false;

  const existingOpen = (await listReportsByProjectNumber(parsed.projectNumber)).find((r) => !r.finalizedAt);
  if (existingOpen) {
    const customerHint = existingOpen.customer ? ` (Kunde: ${existingOpen.customer})` : '';
    const wantsExisting = confirm(
      `Für Projekt "${parsed.projectNumber}"${customerHint} existiert bereits ein offener Bericht.\n\n` +
        'OK = Material aus dem Serviceauftrag dort ergänzen\nAbbrechen = trotzdem einen neuen Bericht anlegen'
    );
    if (wantsExisting) {
      report = existingOpen;
      reused = true;
    } else {
      report = await createNewReport(parsed, technicianName);
    }
  } else {
    report = await createNewReport(parsed, technicianName);
  }

  // Beim Wiederverwenden eines bestehenden Berichts (z.B. versehentlich
  // zweimal denselben Serviceauftrag importiert) bereits vorhandene
  // Positionen nicht erneut anlegen, sonst würde sich das Material
  // duplizieren (gleiche Logik-Idee wie die Zeiten-Überlappungsprüfung in
  // clockActions.ts: Doppelzählung vermeiden). Bei einem neu angelegten
  // Bericht ist diese Prüfung naturgemäß immer leer.
  const materialsToAdd = reused ? await filterAlreadyPresent(report.id, parsed.materials) : parsed.materials;

  for (const material of materialsToAdd) {
    await addMaterialItem(report.id, {
      description: material.description,
      quantity: material.quantity,
      unit: material.unit,
      plannedQuantity: material.quantity
    });
  }

  return { report, parsed, materialCount: materialsToAdd.length, reused };
}

async function filterAlreadyPresent(
  reportId: string,
  materials: ParsedServiceOrderMaterial[]
): Promise<ParsedServiceOrderMaterial[]> {
  const existingDescriptions = new Set(
    (await listMaterialItems(reportId)).map((item) => item.description.trim().toLowerCase())
  );
  return materials.filter((material) => !existingDescriptions.has(material.description.trim().toLowerCase()));
}

async function createNewReport(parsed: ParsedServiceOrder, technicianName?: string): Promise<ServiceReport> {
  const contactPerson = parsed.contactPerson
    ? parsed.contactPhone
      ? `${parsed.contactPerson} (Tel. ${parsed.contactPhone})`
      : parsed.contactPerson
    : undefined;

  return createReport({
    projectNumber: parsed.projectNumber as string,
    projectDescription: parsed.projectDescription,
    customer: parsed.customer,
    contactPerson,
    technicianName,
    notes: buildImportNotes(parsed)
  });
}
