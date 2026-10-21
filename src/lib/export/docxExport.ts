import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ITableBordersOptions
} from 'docx';
import type { ServiceReport } from '../db/types';
import { formatDateDE, formatDateTimeDE, formatDurationMinutes } from '../utils/date';
import type { FullReport } from './getFullReport';

/** Breite eines eingebetteten Fotos im Dokument, in Pixeln (bei 96dpi ≈ 10,5cm). */
const PHOTO_MAX_WIDTH_PX = 400;

// Farbpalette angelehnt an das PWA-Theme (theme_color #2563eb in vite.config.ts).
const ACCENT = '2563EB';
const ACCENT_TINT = 'EFF6FF';
const ZEBRA_FILL = 'F6F7F9';
const BORDER_COLOR = 'DDE2EE';
const TEXT_MUTED = '5B6478';

const TABLE_BORDERS: ITableBordersOptions = {
  top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
  left: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
  right: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR },
  insideVertical: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR }
};

function heading(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2 });
}

function cell(text: string, options: { width: number; bold?: boolean; color?: string; fill?: string } = { width: 25 }): TableCell {
  return new TableCell({
    width: { size: options.width, type: WidthType.PERCENTAGE },
    shading: options.fill ? { fill: options.fill } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: options.bold, color: options.color })] })]
  });
}

function keyValueRow(label: string, value: string): TableRow {
  return new TableRow({
    children: [
      cell(label, { width: 30, bold: true, color: ACCENT, fill: ACCENT_TINT }),
      cell(value, { width: 70 })
    ]
  });
}

function headerRow(labels: string[]): TableRow {
  const width = 100 / labels.length;
  return new TableRow({
    children: labels.map((label) => cell(label, { width, bold: true, color: 'FFFFFF', fill: ACCENT }))
  });
}

function dataRow(values: string[], options: { bold?: boolean; zebra?: boolean } = {}): TableRow {
  const width = 100 / values.length;
  return new TableRow({
    children: values.map((value) =>
      cell(value, { width, bold: options.bold, fill: options.zebra ? ZEBRA_FILL : undefined })
    )
  });
}

function buildHeaderSection(report: ServiceReport): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: 'Servicebericht', heading: HeadingLevel.TITLE }),
    new Paragraph({ text: `Projektnummer: ${report.projectNumber}`, alignment: AlignmentType.LEFT })
  ];

  if (report.projectDescription) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: report.projectDescription, italics: true, color: TEXT_MUTED })],
        spacing: { after: 120 }
      })
    );
  }

  children.push(new Paragraph({ thematicBreak: true }));

  const rows = [
    keyValueRow('Kunde', report.customer || '–'),
    keyValueRow('Ansprechpartner', report.contactPerson || '–'),
    keyValueRow('Techniker', report.technicianName || '–'),
    keyValueRow('Status', report.status === 'completed' ? 'Abgeschlossen' : 'Offen'),
    keyValueRow('Erstellt am', formatDateTimeDE(report.createdAt)),
    keyValueRow('Stand', formatDateTimeDE(report.updatedAt))
  ];
  children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: TABLE_BORDERS, rows }));

  return children;
}

function buildTimeEntriesSection(data: FullReport): (Paragraph | Table)[] {
  const { timeEntries, report } = data;
  if (timeEntries.length === 0) {
    return [heading('Zeiten'), new Paragraph({ text: 'Keine Zeiten erfasst.' })];
  }

  const rows = [
    headerRow(['Datum', 'Start', 'Ende', 'Dauer', 'Notiz']),
    ...timeEntries.map((entry, index) =>
      dataRow(
        [
          formatDateDE(entry.date),
          entry.startTime ?? '–',
          entry.endTime ?? '–',
          formatDurationMinutes(entry.durationMinutes),
          entry.note ?? ''
        ],
        { zebra: index % 2 === 1 }
      )
    ),
    dataRow(['', '', '', formatDurationMinutes(report.totalDurationMinutes), 'Gesamt'], { bold: true })
  ];

  return [heading('Zeiten'), new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: TABLE_BORDERS, rows })];
}

function buildMaterialSection(data: FullReport): (Paragraph | Table)[] {
  const { materialItems } = data;
  if (materialItems.length === 0) {
    return [heading('Material'), new Paragraph({ text: 'Kein Material erfasst.' })];
  }

  // Die "Geplant"-Spalte nur anzeigen, wenn mindestens eine Position eine
  // geplante Menge trägt (siehe MaterialItem.plannedQuantity - nur bei aus
  // einem Serviceauftrag importierten Positionen gesetzt) - für ganz normal
  // manuell erfasste Berichte bleibt die Tabelle unverändert wie bisher.
  const hasPlanned = materialItems.some((item) => item.plannedQuantity !== undefined);
  const headers = hasPlanned
    ? ['Bezeichnung', 'Geplant', 'Verbaut', 'Einheit', 'Artikelnummer']
    : ['Bezeichnung', 'Menge', 'Einheit', 'Artikelnummer'];

  const rows = [
    headerRow(headers),
    ...materialItems.map((item, index) =>
      dataRow(
        hasPlanned
          ? [
              item.description,
              item.plannedQuantity !== undefined ? String(item.plannedQuantity) : '–',
              String(item.quantity),
              item.unit,
              item.articleNumber ?? '–'
            ]
          : [item.description, String(item.quantity), item.unit, item.articleNumber ?? '–'],
        { zebra: index % 2 === 1 }
      )
    )
  ];

  return [heading('Material'), new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: TABLE_BORDERS, rows })];
}

function buildNotesSection(data: FullReport): Paragraph[] {
  const notes = data.report.notes?.trim();
  if (!notes) return [];
  return [heading('Notizen'), ...notes.split('\n').map((line) => new Paragraph({ text: line }))];
}

async function buildPhotosSection(data: FullReport): Promise<(Paragraph | Table)[]> {
  const { photos } = data;
  if (photos.length === 0) return [];

  const children: (Paragraph | Table)[] = [heading('Fotos')];
  for (const photo of photos) {
    const buffer = await photo.thumbnailBlob.arrayBuffer();
    const width = photo.width && photo.height ? Math.min(PHOTO_MAX_WIDTH_PX, photo.width) : PHOTO_MAX_WIDTH_PX;
    const height =
      photo.width && photo.height ? Math.round((width / photo.width) * photo.height) : Math.round(width * 0.75);

    children.push(
      new Paragraph({
        children: [
          new ImageRun({
            type: 'jpg',
            data: buffer,
            transformation: { width, height }
          })
        ],
        spacing: { before: 120 }
      }),
      new Paragraph({
        children: [new TextRun({ text: formatDateTimeDE(photo.takenAt), color: TEXT_MUTED, size: 18 })],
        spacing: { after: 160 }
      })
    );
  }
  return children;
}

/** Breite der eingebetteten Unterschrift, in Pixeln - Unterschriften sind i.d.R. eher schmal/quer. */
const SIGNATURE_MAX_WIDTH_PX = 320;

async function buildSignatureSection(data: FullReport): Promise<(Paragraph | Table)[]> {
  const { signatureBlob, signatureWidth, signatureHeight, signedByName, signedAt } = data.report;
  if (!signatureBlob) return [];

  const buffer = await signatureBlob.arrayBuffer();
  const width = signatureWidth && signatureHeight ? Math.min(SIGNATURE_MAX_WIDTH_PX, signatureWidth) : SIGNATURE_MAX_WIDTH_PX;
  const height =
    signatureWidth && signatureHeight
      ? Math.round((width / signatureWidth) * signatureHeight)
      : Math.round(width * 0.4);

  const caption = [signedByName ? `Unterschrieben von ${signedByName}` : 'Unterschrieben', signedAt ? `am ${formatDateTimeDE(signedAt)}` : '']
    .filter(Boolean)
    .join(' ');

  return [
    heading('Unterschrift'),
    new Paragraph({
      children: [new ImageRun({ type: 'png', data: buffer, transformation: { width, height } })],
      spacing: { before: 120 }
    }),
    new Paragraph({ children: [new TextRun({ text: caption, color: TEXT_MUTED, size: 18 })], spacing: { after: 160 } })
  ];
}

/** Baut ein editierbares Word-Dokument aus einem vollständigen Bericht. Rein clientseitig, keine DB-/DOM-Zugriffe. */
export async function buildReportDocx(data: FullReport): Promise<Blob> {
  const children: (Paragraph | Table)[] = [
    ...buildHeaderSection(data.report),
    ...buildTimeEntriesSection(data),
    ...buildMaterialSection(data),
    ...buildNotesSection(data),
    ...(await buildPhotosSection(data)),
    ...(await buildSignatureSection(data))
  ];

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 } },
        title: {
          run: { color: ACCENT, bold: true, size: 40, font: 'Calibri' },
          paragraph: { spacing: { after: 60 } }
        },
        heading2: {
          run: { color: ACCENT, bold: true, size: 26, font: 'Calibri' },
          paragraph: { spacing: { before: 280, after: 140 } }
        }
      }
    },
    sections: [{ children }]
  });
  return Packer.toBlob(doc);
}

/** Dateiname-Vorschlag für den Download, z.B. "Servicebericht-2026-0142.docx". */
export function suggestedFileName(report: ServiceReport): string {
  const safeProject = report.projectNumber.trim().replace(/[^\w.-]+/g, '_') || 'ohne-Projektnummer';
  return `Servicebericht-${safeProject}.docx`;
}
