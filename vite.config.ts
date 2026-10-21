import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import mkcert from 'vite-plugin-mkcert';

// https://vitejs.dev/config/
// mkcert lädt beim ersten Aufruf einen Zertifikats-Helper von GitHub nach -
// das darf niemals Build/Typecheck/CI blockieren (z.B. hinter einem Proxy
// ohne GitHub-Zugriff). Daher nur aktiv, wenn explizit per
// `npm run dev:iphone` angefordert (siehe package.json).
const useMkcert = process.env.VITE_USE_MKCERT === '1';

// Für ein GitHub-Pages-Projekt-Deployment liegt die App unter einem
// Unterpfad (https://<user>.github.io/<repo>/), nicht an der Domain-Wurzel.
// Der Deploy-Workflow setzt VITE_BASE_PATH entsprechend; lokal (npm run dev
// /build) bleibt es bei "/".
const basePath = process.env.VITE_BASE_PATH || '/';

export default defineConfig(() => ({
  base: basePath,
  plugins: [
    svelte(),
    useMkcert && mkcert(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Rivo',
        short_name: 'Rivo',
        description: 'Rivo – digitale Serviceberichte für Elektrohandwerk-Serviceeinsätze',
        lang: 'de',
        start_url: basePath,
        scope: basePath,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#2563eb',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // Die selbst gehosteten OCR-Dateien (Tesseract-Worker/WASM-Kern unter
        // public/tesseract/, deutsche Trainingsdaten unter public/tessdata/ -
        // siehe BarcodeScanner.svelte "Etikett-Text"-Modus) sind bewusst NICHT
        // im normalen Precache: mehrere MB nur für ein Feature, das nicht
        // jeder Nutzer verwendet, würde die Erstinstallation unnötig
        // aufblähen. .wasm/.gz matchen globPatterns oben ohnehin nicht, aber
        // die kleinen .js-Dateien (worker.min.js, tesseract-core-lstm.js)
        // würden über das "**/*.js"-Muster sonst versehentlich mit
        // precacht werden - deshalb hier zusätzlich per globIgnores explizit
        // ausgeschlossen. Stattdessen werden alle OCR-Dateien beim ersten
        // tatsächlichen Etikett-Text-Scan ganz normal per HTTP geladen und ab
        // da per Workbox CacheFirst dauerhaft im Service Worker
        // zwischengespeichert - danach funktioniert auch dieses Feature
        // komplett offline, ohne die App insgesamt größer zu machen.
        globIgnores: ['tesseract/**', 'tessdata/**', 'pdfjs/**'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/tesseract/') || url.pathname.includes('/tessdata/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-assets',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          // Selbst gehosteter pdfjs-dist-Worker (public/pdfjs/, siehe
          // src/lib/import/serviceOrderPdf.ts "Serviceauftrag importieren") -
          // aus demselben Grund wie die OCR-Dateien oben nicht im normalen
          // Precache (über 1 MB, nur fürs PDF-Import-Feature relevant),
          // sondern erst beim ersten tatsächlichen Import geladen und danach
          // dauerhaft zwischengespeichert.
          {
            urlPattern: ({ url }) => url.pathname.includes('/pdfjs/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdfjs-assets',
              expiration: { maxEntries: 5, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    })
  ],
  server: {
    host: true
  }
}));
