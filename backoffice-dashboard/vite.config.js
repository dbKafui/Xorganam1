import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function csp(apiBaseUrl, dev = false) {
  const apiOrigin = new URL(apiBaseUrl).origin
  return [
    "default-src 'self'",
    `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}${dev ? ' ws://localhost:5173 ws://127.0.0.1:5173' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const apiBaseUrl = env.VITE_API_BASE_URL || process.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1'
  return {
    plugins: [react()],
    build: { sourcemap: false },
    server: {
      port: 5173,
      headers: { 'Content-Security-Policy': csp(apiBaseUrl, command === 'serve') }
    },
    preview: { headers: { 'Content-Security-Policy': csp(apiBaseUrl) } }
  }
})
