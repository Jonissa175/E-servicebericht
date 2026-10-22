import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDB } from '../testUtils';
import { createNewReport } from '../../lib/import/importServiceOrder';
import type { ParsedServiceOrder } from '../../lib/utils/serviceOrderImport';

beforeEach(async () => {
  await resetTestDB();
});

function fakeParsed(overrides: Partial<ParsedServiceOrder> = {}): ParsedServiceOrder {
  return {
    projectNumber: '2026-010',
    customer: 'Musterfirma GmbH',
    materials: [],
    laborLines: [],
    raw: '',
    ...overrides
  };
}

describe('importServiceOrder.createNewReport', () => {
  it('übernimmt contactPerson und contactPhone als getrennte Felder, statt sie zu einem Text zu mischen', async () => {
    const report = await createNewReport(fakeParsed({ contactPerson: 'Sabine Hanslbauer', contactPhone: '01748425400' }));
    expect(report.contactPerson).toBe('Sabine Hanslbauer');
    expect(report.contactPhone).toBe('01748425400');
  });

  it('funktioniert auch ohne erkannte Telefonnummer', async () => {
    const report = await createNewReport(fakeParsed({ contactPerson: 'Sabine Hanslbauer', contactPhone: undefined }));
    expect(report.contactPerson).toBe('Sabine Hanslbauer');
    expect(report.contactPhone).toBeUndefined();
  });
});
