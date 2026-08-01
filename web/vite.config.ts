import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Reachable via Caddy/Cloudflare Tunnel at triton.pelorus.org
    // (2026-08-01, renamed from iptv-web-player.pelorus.org the same day) —
    // Vite's dev server rejects any Host header it doesn't recognize by
    // default (DNS-rebinding protection), which otherwise shows up as a 403
    // from Vite itself, not from Caddy/the tunnel. Same fix applied to
    // iptv-recorder's own vite.config.ts.
    allowedHosts: ['triton.pelorus.org'],
    proxy: {
      '/api': {
        target: 'http://localhost:4300',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
