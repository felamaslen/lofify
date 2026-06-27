import { getCertificate } from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { defineConfig, UserConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Serve the dev server over HTTPS with a self-signed cert when `DEV_HTTPS` is set, so
// secure-context-only browser APIs (Web Share, Clipboard — used by the track Share action) work in
// dev. It listens with TLS on the normal port (5173), not 443. Off by default: the cert is
// untrusted, so the browser shows a one-time warning.
const useHttps = process.env.DEV_HTTPS === '1' || process.env.DEV_HTTPS === 'true';

export default defineConfig(async (): Promise<UserConfig> => {
  // `@vitejs/plugin-basic-ssl` generates and caches a self-signed cert; assign it straight to
  // `server.https` so Vite's dev server speaks TLS on its port (one PEM holds both cert and key).
  const cert = useHttps ? await getCertificate('node_modules/.vite/basic-ssl') : null;

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'Lofify',
          short_name: 'Lofify',
          description: 'Your music library, streamed.',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#0f172a',
          theme_color: '#0f172a',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // Precache the app shell only. Audio chunks and GraphQL are deliberately
          // excluded — they're large and dynamic, and the player streams them itself.
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/graphql/, /^\/api/, /^\/tracks?\//],
        },
      }),
    ],
    css: {
      postcss: {
        plugins: [tailwindcss(), autoprefixer()],
      },
    },
    server: {
      allowedHosts: true,
      port: 5173,
      host: '0.0.0.0',
      ...(cert ? { https: { cert, key: cert } } : {}),
    },
  };
});
