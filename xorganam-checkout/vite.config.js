import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'

const storefrontCsp = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' https:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https: http://localhost:3000 ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
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
  // Vite injects React Refresh's bootstrapping script inline in development.
  // Allow that script only on the dev server; production keeps the strict CSP
  // served by nginx and never enables unsafe-inline for scripts.
  const devCsp = storefrontCsp.replace("script-src ", "script-src 'unsafe-inline' ")
  return {
    plugins: [react()],
    // Apply CSP as an HTTP response header to the HTML and assets served by
    // Vite in development and preview. The HTML meta policy remains a fallback.
    server: { port: 5174, headers: { 'Content-Security-Policy': mode === 'development' ? devCsp : storefrontCsp } },
    preview: { headers: { 'Content-Security-Policy': storefrontCsp } }
  }
})
