import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // Eigene, von vite.config.ts unabhaengige Konfiguration - die dortige
  // assetsInclude-Ergaenzung (fuer die docxtemplater-Vorlage, siehe
  // src/lib/export/docxExport.ts) gilt hier nicht automatisch mit.
  assetsInclude: ['**/*.docx'],
  test: {
    environment: 'node',
    setupFiles: ['fake-indexeddb/auto'],
    include: ['src/tests/**/*.test.ts']
  }
});
