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
