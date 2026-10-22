import type { DBSchema } from 'idb';

export type ID = string; // crypto.randomUUID()
export type ISODate = string; // "2026-08-10"
export type ISODateTime = string; // vollständiger ISO-8601-Zeitstempel

export type ReportStatus = 'open' | 'completed';

/**
 * Ein Servicebericht. `technicianName` ist bewusst ein freies Textfeld (kein
 * Fremdschlüssel) - Platzhalter für eine spätere Nutzerzuordnung, wenn mehrere
 * Monteure die App verwenden. Die *Count/-Duration-Felder sind denormalisiert,
 * damit die Listenansicht ausschließlich den `reports`-Store lesen muss und
 * nie Zeiten/Material/Foto-Stores anfassen muss.
 */
export interface ServiceReport {
  id: ID;
  projectNumber: string;
  projectDescription?: string;
  customer?: string;
  contactPerson?: string;
  /**
   * Telefonnummer des Ansprechpartners, getrennt von `contactPerson`
   * (reiner Name) - beim Serviceauftrag-Import automatisch aus der dort
   * separat erkannten Nummer vorbefüllt (siehe importServiceOrder.ts),
   * sonst frei editierbar. Vorher (bis zu diesem Feld) wurde die Nummer
   * fälschlich in den `contactPerson`-Text gemergt ("Name (Tel. 0123...)")
   * - ältere, so gespeicherte Berichte haben deshalb weiterhin dieses
   * Altformat in `contactPerson` und KEIN `contactPhone`; der Word-Export
   * erkennt das rein darstellungsseitig und trennt es dort wieder auf
   * (siehe `splitContactPersonAndPhone()` in docxExport.ts) - die
   * gespeicherten Daten selbst werden dabei nicht verändert.
   */
  contactPhone?: string;
  technicianName?: string;
  status: ReportStatus;
  notes?: string;
  /**
   * Eigenes Feld für die im Word-Export unter "Durchgeführte Arbeiten:"
   * eintragene Beschreibung - bewusst GETRENNT vom allgemeinen `notes`-Feld
   * ("Notizen"), weil der Nutzer dafür ein eigenständiges Feld in der App
   * wollte statt `notes` doppelt zu verwenden. `notes` bleibt als freies
   * "was ist mir sonst noch aufgefallen"-Feld bestehen.
   */
  performedWork?: string;

  /**
   * Geplante Mannstunden für diesen Einsatz (Summe über alle Rollen/
   * Kategorien, z.B. Monteur + Azubi zusammen) - bei einem Serviceauftrag-
   * Import automatisch aus den "Arbeitsaufwand"-Stunden-Positionen
   * vorbefüllt (siehe importServiceOrder.ts), für jeden Bericht aber frei
   * editier-/nachtragbar. Rein informativ zum Abgleich mit der tatsächlich
   * erfassten Zeit (totalDurationMinutes) in der Übersicht - keine eigene
   * Validierung/Begrenzung.
   */
  plannedLaborHours?: number;

  /** Kunden-Unterschrift (Abnahme) als PNG-Blob vom Unterschriften-Pad, inkl. Original-Pixelgröße für den Export. */
  signatureBlob?: Blob;
  signatureWidth?: number;
  signatureHeight?: number;
  signedByName?: string;
  signedAt?: ISODateTime;

  /**
   * Der eigentliche "gesperrt"-Zeitstempel: wird gesetzt, sobald der Bericht
   * final abgeschlossen wird - entweder automatisch beim Erfassen einer
   * Kunden-Unterschrift (setReportSignature) oder manuell durch den Monteur
   * ohne Unterschrift (finalizeReport), z.B. wenn keine Unterschrift nötig
   * oder möglich ist. `signedAt` beschreibt nur zusätzlich, OB (und wie)
   * unterschrieben wurde - für die Sperre selbst zählt allein `finalizedAt`.
   */
  finalizedAt?: ISODateTime;

  /** Zeitpunkt des letzten erfolgreichen Word-Exports/Downloads/Teilens - für die "bereits eingereicht?"-Anzeige in der Übersicht. */
  exportedAt?: ISODateTime;

  timeEntryCount: number;
  totalDurationMinutes: number;
  materialItemCount: number;
  photoCount: number;

  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface TimeEntry {
  id: ID;
  /**
   * Optional seit der Tagesstempeluhr: `undefined` bedeutet Leerlaufzeit
   * (eingestempelt, aber keinem Projekt zugeordnet). Manuell im Zeiten-Tab
   * erfasste Einträge haben immer eine reportId, wie bisher.
   */
  reportId?: ID;
  /**
   * Verknüpfung zum Tagesstempel (WorkDay), der diesen Eintrag erzeugt hat -
   * nur gesetzt für Einträge aus der Tagesstempeluhr (checkInDay/
   * switchToProject/switchToIdle), NIE für manuell im Zeiten-Tab erfasste
   * Einträge.
   */
  workDayId?: ID;
  date: ISODate;
  startTime?: string; // "HH:mm"
  endTime?: string; // "HH:mm"
  durationMinutes?: number;
  note?: string;
  /**
   * Markiert eine unbezahlte Pause (aus dem Tagesausstempeln heraus erfasst,
   * siehe clockActions.checkOutDay()) - hat wie Leerlaufzeit nie eine
   * reportId, zählt aber zusätzlich NIRGENDS als Arbeitszeit (weder
   * produktiv noch Leerlaufzeit): getDayStats(), getDayProjectBreakdown()
   * und listUnassignedIdleEntries() ignorieren Einträge mit isBreak. Kein
   * eigener DB_VERSION-Bump nötig - ein optionales neues Feld, bestehende
   * Einträge ohne dieses Feld gelten automatisch als "keine Pause".
   */
  isBreak?: boolean;
  /**
   * Nur bei isBreak-Einträgen gesetzt: dokumentiert, welche Nachbar-Einträge
   * beim Anlegen dieser Pause gekürzt/gesplittet/gelöscht wurden (siehe
   * timeEntries.trimOverlappingTimeEntries()) - Grundlage für
   * restoreBreak(), das diese Änderungen beim Löschen der Pause wieder
   * rückgängig macht.
   */
  trimRecords?: TimeEntryTrimRecord[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/**
 * Der "Vorher"-Zustand eines einzelnen Nachbar-Eintrags, der beim Anlegen
 * einer Pause weggeschnitten wurde - reicht aus, um trimOverlappingTimeEntries()
 * für genau diesen Eintrag wieder rückgängig zu machen (siehe
 * timeEntries.restoreBreak()).
 */
export interface TimeEntryTrimRecord {
  /** ID des ursprünglichen Eintrags (bleibt auch nach dem Wegschneiden gültig, außer bei wasDeleted). */
  entryId: ID;
  reportId?: ID;
  workDayId?: ID;
  date: ISODate;
  originalStartTime?: string;
  originalEndTime?: string;
  originalNote?: string;
  /** true, wenn der Eintrag komplett im Pausenfenster lag und deshalb ganz gelöscht wurde. */
  wasDeleted: boolean;
  /** Falls der Eintrag gesplittet wurde: ID des dabei neu entstandenen zweiten Teils (wird beim Rückgängigmachen wieder gelöscht). */
  splitEntryId?: ID;
}

/**
 * Der Tagesstempel: unabhängig von einem konkreten Projekt, umschließt
 * beliebig viele Projekt-/Leerlaufzeit-TimeEntry-Abschnitte (siehe
 * TimeEntry.workDayId). Es kann global immer nur höchstens ein WorkDay ohne
 * checkOutTime geben (durchgesetzt in der Action-Schicht, src/lib/clockActions.ts).
 */
export interface WorkDay {
  id: ID;
  date: ISODate; // lokales Datum beim Einstempeln
  checkInTime?: string; // "HH:mm"
  checkOutTime?: string; // "HH:mm" - undefined = Tag noch aktiv
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type AbsenceType = 'vacation' | 'sick' | 'timeoff';

/**
 * Eine Abwesenheit (Urlaub/Krank/Zeitausgleich) für einen ganzen Kalendertag
 * - auch rückwirkend oder für die Zukunft eintragbar, unabhängig von der
 * Tagesstempeluhr. Bewusst OHNE eigene uuid: das Datum selbst ist der
 * Primärschlüssel (keyPath in der DB) - es kann nur eine Abwesenheit pro Tag
 * geben, ein erneutes Speichern für denselben Tag überschreibt die
 * vorherige Eintragung automatisch (Upsert statt Duplikat-Vermeidung).
 */
export interface Absence {
  date: ISODate;
  type: AbsenceType;
  note?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface MaterialItem {
  id: ID;
  reportId: ID;
  description: string;
  quantity: number;
  unit: string;
  articleNumber?: string;
  /**
   * Erwartete/geplante Menge laut importiertem Serviceauftrag (siehe
   * src/lib/import/importServiceOrder.ts) - rein informativ zum Abgleich
   * mit der tatsächlich verbauten `quantity`, bleibt bei Abweichung
   * unverändert stehen. Nur gesetzt für per Import vorausgefüllte
   * Positionen - manuell angelegte Positionen haben kein "Soll".
   */
  plannedQuantity?: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Photo {
  id: ID;
  reportId: ID;
  blob: Blob;
  thumbnailBlob: Blob;
  mimeType: string;
  width?: number;
  height?: number;
  sizeBytes: number;
  takenAt: ISODateTime;
}

export interface ServiceBerichtDB extends DBSchema {
  reports: {
    key: ID;
    value: ServiceReport;
    indexes: { projectNumber: string; status: string; updatedAt: string };
  };
  timeEntries: {
    key: ID;
    value: TimeEntry;
    indexes: { reportId: string; date: string; workDayId: string };
  };
  materialItems: {
    key: ID;
    value: MaterialItem;
    indexes: { reportId: string };
  };
  photos: {
    key: ID;
    value: Photo;
    indexes: { reportId: string };
  };
  workDays: {
    key: ID;
    value: WorkDay;
    indexes: { date: string };
  };
  absences: {
    key: ISODate;
    value: Absence;
  };
}

export const DB_NAME = 'e-servicebericht-db';
export const DB_VERSION = 4;
