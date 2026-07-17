import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Production edge CSP (task-manager.mfsdev.net) previously set only:
 *   default-src 'self' http: https: ws: wss: data: blob: 'unsafe-inline'; frame-ancestors 'self';
 * Browsers warn on every page when script-src (and style-src) fall back to default-src.
 *
 * Keep the same source list — do not loosen. Explicit script-src / style-src silence the
 * fallback warning. App needs 'unsafe-inline' for the root theme bootstrap script and
 * a few style={{}} attributes; dist client has no eval()/new Function (verified).
 */
const CSP_SRC =
  "'self' http: https: ws: wss: data: blob: 'unsafe-inline'" as const

export const CONTENT_SECURITY_POLICY = [
  `default-src ${CSP_SRC}`,
  `script-src ${CSP_SRC}`,
  `style-src ${CSP_SRC}`,
  "frame-ancestors 'self'",
].join('; ')

const securityHeaders = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
} as const

/**
 * Apply CSP on every response (SSR + static). Vite `preview.headers` /
 * `server.headers` only attach via static asset middleware; TanStack Start SSR
 * routes would otherwise omit the header.
 */
function cspHeadersPlugin(): Plugin {
  const attach = (
    middlewares: {
      use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void
    },
  ) => {
    middlewares.use((_req, res, next) => {
      for (const [name, value] of Object.entries(securityHeaders)) {
        res.setHeader(name, value)
      }
      next()
    })
  }
  return {
    name: 'task-manager-csp-headers',
    configureServer(server) {
      attach(server.middlewares)
    },
    configurePreviewServer(server) {
      attach(server.middlewares)
    },
  }
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    cspHeadersPlugin(),
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  // served behind an nginx reverse proxy (task-manager.mfsdev.net) — allow the proxied Host
  preview: {
    allowedHosts: true,
    headers: { ...securityHeaders },
  },
  // Same CSP in dev so local console matches preview/prod policy shape.
  server: {
    headers: { ...securityHeaders },
  },
})

export default config
