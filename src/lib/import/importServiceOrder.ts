import { addMaterialItem, listMaterialItems } from '../db/materialItems';
import { createReport, listReportsByProjectNumber } from '../db/reports';
import type { ServiceReport } from '../db/types';
import { extractPdfText } from './serviceOrderPdf';
import { parseServiceOrderText, type ParsedServiceOrder, type ParsedServiceOrderMaterial } from '../utils/serviceOrderImport';

/**
 * Eigene Error-Klasse für erwartete, nutzerverständliche Fehler (z.B. keine
 * Projektnummer im PDF gefunden) - damit die UI (ReportList.svelte) diese
 * gezielt vom Nutzer zeigen kann, während ein unerwarteter technischer
 * Fehler (z.B. aus der PDF-Extraktion) dort stattdessen einen generischen,
 * verständlichen Hinweis bekommt statt einer rohen, für den Nutzer
 * nichtssagenden Browser-/Bibliotheks-Fehlermeldung.
 */
export class ServiceOrderImportError extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Markiert einen unerwarteten Fehler mit der Pipeline-Stufe, in der er
 * aufgetreten ist (Extraktion/Interpretation/Speichern) - bislang zeigten
 * die "Technischen Details" in der UI (ReportList.svelte) nur
 * Fehlername+Meldung ohne jeden Hinweis darauf, WELCHER der drei Schritte
 * überhaupt fehlgeschlagen ist. Bei einem auf einem echten Gerät
 * auftretenden, hier nicht reproduzierbaren Fehler ist das der erste nötige
 * Anhaltspunkt zur weiteren Eingrenzung. `cause` erhält den Originalfehler
 * (inkl. Stack), den ReportList.svelte zusätzlich mit anzeigt.
 */
function stageError(stage: string, err: unknown): Error {
  return new Error(`[${stage}] ${errorMessage(err)}`, { cause: err });
}

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
 * Wirft eine ServiceOrderImportError mit nutzerverständlicher Meldung, wenn
 * im PDF keine Projektnummer gefunden wurde (z.B. falsches/fremdes PDF
 * ausgewählt) - ohne Projektnummer lässt sich kein Bericht sinnvoll anlegen.
 * Jeder andere (unerwartete/technische) Fehler, z.B. aus der PDF-Extraktion
 * selbst, wird unverändert durchgereicht - die UI zeigt dafür bewusst einen
 * generischen Hinweis statt der rohen Fehlermeldung, siehe
 * ReportList.svelte handleServiceOrderFile().
 */
export async function importServiceOrderFromFile(file: File, technicianName?: string): Promise<ServiceOrderImportResult> {
  let rawText: string;
  try {
    rawText = await extractPdfText(file);
  } catch (err) {
    throw stageError('PDF-Extraktion', err);
  }

  let parsed: ParsedServiceOrder;
  try {
    parsed = parseServiceOrderText(rawText);
  } catch (err) {
    throw stageError('Text-Interpretation', err);
  }

  if (!parsed.projectNumber) {
    throw new ServiceOrderImportError(
      'Im PDF wurde keine Projektnummer gefunden - ist das wirklich ein Serviceauftrag im bekannten ELSA-Format?'
    );
  }

  let report: ServiceReport;
  let reused = false;

  try {
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
  } catch (err) {
    throw stageError('Bericht anlegen/Material speichern', err);
  }
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
