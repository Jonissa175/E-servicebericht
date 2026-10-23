import { describe, expect, it } from 'vitest';
import { splitContactPersonAndPhone } from '../../lib/utils/contactPerson';

describe('splitContactPersonAndPhone', () => {
  it('lässt einen reinen Namen unverändert, wenn contactPhone bereits gesetzt ist', () => {
    const result = splitContactPersonAndPhone({ contactPerson: 'Sabine Hanslbauer', contactPhone: '0174 8425400' });
    expect(result.contactPerson).toBe('Sabine Hanslbauer');
    expect(result.contactPhone).toBe('0174 8425400');
  });

  it('lässt einen reinen Namen unverändert, wenn contactPhone fehlt und contactPerson KEIN Altformat ist', () => {
    const result = splitContactPersonAndPhone({ contactPerson: 'Sabine Hanslbauer', contactPhone: undefined });
    expect(result.contactPerson).toBe('Sabine Hanslbauer');
    expect(result.contactPhone).toBe('');
  });

  it('trennt bei einem Altbericht (contactPhone fehlt) das abgeschaffte Merge-Format "Name (Tel. ...)" wieder auf', () => {
    const result = splitContactPersonAndPhone({ contactPerson: 'Sabine Hanslbauer (Tel. 01748425400)', contactPhone: undefined });
    expect(result.contactPerson).toBe('Sabine Hanslbauer');
    expect(result.contactPhone).toBe('01748425400');
  });

  it('bevorzugt ein bereits gesetztes contactPhone, auch wenn contactPerson zufällig wie das Altformat aussieht', () => {
    const result = splitContactPersonAndPhone({
      contactPerson: 'Sabine Hanslbauer (Tel. 01748425400)',
      contactPhone: '089 1234567'
    });
    // contactPhone ist gesetzt - contactPerson wird NICHT per Regex angefasst/aufgetrennt.
    expect(result.contactPerson).toBe('Sabine Hanslbauer (Tel. 01748425400)');
    expect(result.contactPhone).toBe('089 1234567');
  });

  it('funktioniert ohne jeden Ansprechpartner (leere Strings, kein Fehler)', () => {
    const result = splitContactPersonAndPhone({ contactPerson: undefined, contactPhone: undefined });
    expect(result.contactPerson).toBe('');
    expect(result.contactPhone).toBe('');
  });
});
