import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function contentSecurityPolicy(apiBaseUrl, isDevServer = false) {
  const apiOrigin = new URL(apiBaseUrl).origin
  return [
    "default-src 'self'",
    `script-src 'self'${isDevServer ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}${isDevServer ? ' ws://localhost:5174 ws://127.0.0.1:5174' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const apiBaseUrl = env.VITE_API_BASE_URL || process.env.VITE_API_BASE_URL || 'http://localhost:3000/api/v1'
  const csp = contentSecurityPolicy(apiBaseUrl, command === 'serve')
  if (mode === 'production') {
    // Production must deploy the shared UI on distinct origins. The runtime
    // origin guard below then keeps operator routes off the public origin.
    if (!env.VITE_STOREFRONT_PUBLIC_URL || !env.VITE_OPERATOR_PUBLIC_URL || !env.VITE_API_BASE_URL) {
      throw new Error('Production requires VITE_STOREFRONT_PUBLIC_URL, VITE_OPERATOR_PUBLIC_URL, and VITE_API_BASE_URL.')
    }
    const storefront = new URL(env.VITE_STOREFRONT_PUBLIC_URL)
    const operator = new URL(env.VITE_OPERATOR_PUBLIC_URL)
    const api = new URL(env.VITE_API_BASE_URL)
    if (storefront.protocol !== 'https:' || operator.protocol !== 'https:' || storefront.origin === operator.origin ||
        api.protocol !== 'https:' || storefront.pathname !== '/' || operator.pathname !== '/' ||
        storefront.search || operator.search || storefront.hash || operator.hash) {
      throw new Error('Production requires a valid HTTPS VITE_API_BASE_URL and distinct root HTTPS origins for VITE_STOREFRONT_PUBLIC_URL and VITE_OPERATOR_PUBLIC_URL.')
    }
  }
  return {
    plugins: [react()],
    build: { sourcemap: false },
    server: { port: 5174, headers: { 'Content-Security-Policy': csp } },
    preview: { headers: { 'Content-Security-Policy': contentSecurityPolicy(apiBaseUrl) } }
  }
})
