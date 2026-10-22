/**
 * `pizzip` liefert keine eigenen TypeScript-Typen (im Gegensatz zu
 * `docxtemplater`, das offizielle Typen mitbringt) - deshalb hier eine
 * eigene, bewusst schlanke Deklaration nur für die in docxExport.ts
 * tatsächlich genutzten Methoden.
 */
declare module 'pizzip' {
  interface PizZipFileOptions {
    binary?: boolean;
  }

  interface PizZipFile {
    asText(): string;
    asUint8Array(): Uint8Array;
  }

  class PizZip {
    constructor(data: ArrayBuffer | Uint8Array | string);
    file(name: string): PizZipFile | null;
    file(name: string, data: string | ArrayBuffer | Uint8Array, options?: PizZipFileOptions): this;
    generate(options: { type: 'blob'; mimeType?: string }): Blob;
  }

  export = PizZip;
}

/** Vite liefert für importierte .docx-Dateien die ausgelieferte URL als String (wie bei .svg etc.). */
declare module '*.docx' {
  const url: string;
  export default url;
}

/**
 * `cfb` (von SheetJS separat veröffentlichtes, schlankes Paket nur für den
 * OLE2-Compound-File-Container, ohne jede BIFF8/XLSX-Interpretation) liefert
 * keine eigenen TypeScript-Typen - eigene, schlanke Deklaration nur für die
 * in timesheetEmbed.ts tatsächlich genutzten Funktionen. Siehe dortigen
 * Dateikommentar für die Begründung, warum `cfb` statt des vollständigen
 * `xlsx`-Pakets zum Einsatz kommt.
 */
declare module 'cfb' {
  interface CfbEntry {
    name: string;
    /** Je nach Umgebung `Uint8Array`, Node-`Buffer` oder einfaches `Array<number>` - siehe `toUint8Array()` in timesheetEmbed.ts. */
    content: ArrayLike<number>;
  }
  interface CfbContainer {
    FileIndex: CfbEntry[];
  }
  const CFB: {
    parse(data: Uint8Array): CfbContainer;
    write(cfb: CfbContainer, options: { type: 'array' }): ArrayLike<number>;
  };
  export default CFB;
}
