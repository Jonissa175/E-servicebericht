/**
 * Erkennt das alte, inzwischen abgeschaffte Merge-Format "Name (Tel. 0123...)"
 * in `contactPerson` - für Altberichte, die vor Einführung des eigenen
 * `contactPhone`-Felds angelegt wurden.
 */
const LEGACY_CONTACT_PERSON_WITH_PHONE = /^(.*\S)\s*\(Tel\.\s*(.+)\)$/;

/**
 * Trennt `contactPerson`/`contactPhone` rein darstellungsseitig auf,
 * verändert nie die gespeicherten Daten. Ist `contactPhone` bereits gesetzt
 * (alle seit Einführung dieses Felds angelegten/bearbeiteten Berichte), wird
 * es direkt verwendet. Nur wenn es FEHLT, aber `contactPerson` dem alten,
 * inzwischen abgeschafften Merge-Format "Name (Tel. 0123...)" entspricht
 * (Altberichte von vor diesem Feld), wird es wieder in Name/Telefonnummer
 * aufgeteilt - genutzt sowohl vom Word-Export (docxExport.ts) als auch von
 * der Unterschrift-Vorausfüllung (ReportDetail.svelte), damit dort nie der
 * reine Kundenname mit der Telefonnummer vermischt vorausgefüllt wird.
 */
export function splitContactPersonAndPhone(report: {
  contactPerson?: string;
  contactPhone?: string;
}): { contactPerson: string; contactPhone: string } {
  if (report.contactPhone) {
    return { contactPerson: report.contactPerson ?? '', contactPhone: report.contactPhone };
  }
  const legacyMatch = report.contactPerson ? LEGACY_CONTACT_PERSON_WITH_PHONE.exec(report.contactPerson) : null;
  if (legacyMatch) {
    return { contactPerson: legacyMatch[1], contactPhone: legacyMatch[2] };
  }
  return { contactPerson: report.contactPerson ?? '', contactPhone: '' };
}
