import { describe, expect, it } from 'vitest';
import { parseServiceOrderText } from '../../lib/utils/serviceOrderImport';

// Die exakten Zeilen, die pdfjs-dist (siehe src/lib/import/serviceOrderPdf.ts)
// aus einem echten ELSA-Serviceauftrag-PDF extrahiert - Text auf derselben
// visuellen Zeile wird dabei OHNE jedes Trennzeichen aneinandergereiht (siehe
// Kommentar in serviceOrderImport.ts), inkl. der Zeilen-Verschmelzung der
// Kopf-Info-Box mit dem linken Adress-Block auf Seite 1.
const SAMPLE_RAW = [
  'ELSA cnc service GmbH - Ammerthalstraße 12 - 85551 Kirchheim bei München',
  'FrauDok-nr.: 264216',
  'Sabine HanslbauerDatum: 30.09.2026',
  'Tassilostraße 2aKundennr.: 12850',
  'Projektnr.: 264235',
  '85609 Aschheim',
  'IBAN: DE44 7025 0150 0040 2968 40',
  'SWIFT-BIC BYLADEM1KMS',
  'UID-Nr. DE162463240',
  'ServiceauftragKopie',
  'elektro',
  'Auftrag: Kabelkanal Markiese, Steckdose Terrasse',
  'Einsatzort:',
  'Hinweis zum Installationsort:',
  'Sonstige Infos:',
  'Projektnummer: 264235',
  'Sachbearbeiter:',
  'Projektleiter:',
  '-KUNDENDATEN -',
  'Frau',
  'Sabine Hanslbauer',
  'Tassilostraße 2a',
  '85609 Aschheim',
  'Ansprechpartner vor Ort: Sabine Hanslbauer',
  'Telefon: 01748425400',
  'E-Mail: sabine-hanslbauer@web.de',
  'Pos.MengeEin.Text',
  '1Kabelkanal Markiese 1.OG',
  '1.0104mLeitungsführungskanal LF 15x15 vw',
  '1.0204mSchlauchleitung H05VV-F 3G1,5',
  'Seite 1 von 2',
  'Pos.MengeEin.Text',
  '1.0301StckWinkel LF-Kanal',
  '2Markiese EG Terrasse',
  '2.0104mLeitungsführungskanal PVC LF 15x15 gsw',
  '3Steckdose EG Terrasse',
  '3.01020mNYY-J 3x2,5',
  '3.0201StckGießharz-Muffe',
  '4Bewegungsmelder',
  '4.0101StckBusch-J. Wächter aws 6800-34-102C',
  '4.0201StckBusch-J. Univ.Relais-Einsatz UP 230V 2300W/VA 6401 U-102',
  '4.0301StckBusch-J. Abdeckrahmen 1fach aws 2101-34',
  '4.0401StckBusch-J. Wechseltaster-Einsatz 1pol. 2020 US-206',
  '5Arbeitsaufwand',
  '4.0208Std.Leitender Monteur',
  'Obermonteur für Energie- und Gebäudetechnik',
  '4.0308Std.Auszubildender',
  'Energie- und Gebäudetechnik',
  '4.0401StückAn- und Abreisepauschale Zone 1',
  'Beinhaltet: Reisezeit und Reisekilometer',
  '4.0501StückRüstzeit-/Materialbeschaffung, Bearbeitungspauschale',
  'ELSA cnc service GmbH • Ammerthalstraße 12 • 85551 Kirchheim bei MünchenKreissparkasse München Starnberg Ebersberg',
  'GF Bernhard Sander • HRB 104822 München • UID-Nr. DE162463240IBAN: DE44 7025 0150 0040 2968 40',
  'Tel.: +49 89 9033812 • www.elsa-service.de • Mail: info@elsa-service.deSWIFT-BIC BYLADEM1KMS',
  'Seite 2 von 2'
].join('\n');

describe('parseServiceOrderText', () => {
  it('erkennt Projektnummer, Dokumentnummer, Kunde, Ansprechpartner, Telefon und Kurzbeschreibung', () => {
    const result = parseServiceOrderText(SAMPLE_RAW);
    expect(result.projectNumber).toBe('264235');
    expect(result.documentNumber).toBe('264216');
    expect(result.customer).toBe('Sabine Hanslbauer');
    expect(result.contactPerson).toBe('Sabine Hanslbauer');
    expect(result.contactPhone).toBe('01748425400');
    expect(result.projectDescription).toBe('Kabelkanal Markiese, Steckdose Terrasse');
  });

  it('erkennt alle Material-Positionen über beide Seiten hinweg mit Menge/Einheit/Bezeichnung', () => {
    const result = parseServiceOrderText(SAMPLE_RAW);
    expect(result.materials).toEqual([
      { description: 'Leitungsführungskanal LF 15x15 vw', quantity: 4, unit: 'm' },
      { description: 'Schlauchleitung H05VV-F 3G1,5', quantity: 4, unit: 'm' },
      { description: 'Winkel LF-Kanal', quantity: 1, unit: 'Stk' },
      { description: 'Leitungsführungskanal PVC LF 15x15 gsw', quantity: 4, unit: 'm' },
      { description: 'NYY-J 3x2,5', quantity: 20, unit: 'm' },
      { description: 'Gießharz-Muffe', quantity: 1, unit: 'Stk' },
      { description: 'Busch-J. Wächter aws 6800-34-102C', quantity: 1, unit: 'Stk' },
      { description: 'Busch-J. Univ.Relais-Einsatz UP 230V 2300W/VA 6401 U-102', quantity: 1, unit: 'Stk' },
      { description: 'Busch-J. Abdeckrahmen 1fach aws 2101-34', quantity: 1, unit: 'Stk' },
      { description: 'Busch-J. Wechseltaster-Einsatz 1pol. 2020 US-206', quantity: 1, unit: 'Stk' }
    ]);
  });

  it('nimmt "Arbeitsaufwand"-Positionen NICHT als Material, sondern als Hinweistext (inkl. Fortsetzungszeilen)', () => {
    const result = parseServiceOrderText(SAMPLE_RAW);
    expect(result.materials.some((m) => /Monteur|Auszubildender|Abreisepauschale|Rüstzeit/.test(m.description))).toBe(
      false
    );
    expect(result.laborLines).toEqual([
      '8 Std Leitender Monteur Obermonteur für Energie- und Gebäudetechnik',
      '8 Std Auszubildender Energie- und Gebäudetechnik',
      '1 Stk An- und Abreisepauschale Zone 1 Beinhaltet: Reisezeit und Reisekilometer',
      '1 Stk Rüstzeit-/Materialbeschaffung, Bearbeitungspauschale'
    ]);
  });

  it('summiert die geplanten Mannstunden aus den "Std"-Arbeitsaufwand-Positionen (Pauschalen/Stückzahlen zählen nicht mit)', () => {
    const result = parseServiceOrderText(SAMPLE_RAW);
    expect(result.plannedLaborHours).toBe(16);
  });

  it('ignoriert wiederkehrende Brief-/Fußzeilen (Bankverbindung, Handelsregister) und Seitenzahlen', () => {
    const result = parseServiceOrderText(SAMPLE_RAW);
    const allText = [...result.materials.map((m) => m.description), ...result.laborLines].join(' ');
    expect(allText).not.toMatch(/Kreissparkasse|SWIFT-BIC|IBAN:|HRB|Seite \d/);
  });

  it('liefert leere Listen und undefined-Felder, wenn gar nichts erkennbar ist', () => {
    const result = parseServiceOrderText('nur irgendein Text ohne Struktur');
    expect(result.materials).toEqual([]);
    expect(result.laborLines).toEqual([]);
    expect(result.plannedLaborHours).toBeUndefined();
    expect(result.projectNumber).toBeUndefined();
    expect(result.customer).toBeUndefined();
  });

  it('trimmt den rohen Text, liefert ihn aber unverändert in `raw`', () => {
    const result = parseServiceOrderText(`  ${SAMPLE_RAW}  `);
    expect(result.raw).toBe(SAMPLE_RAW);
  });
});
