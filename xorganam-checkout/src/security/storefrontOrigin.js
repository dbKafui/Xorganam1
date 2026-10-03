const storefrontOrigin = import.meta.env.VITE_STOREFRONT_PUBLIC_URL
  ? new URL(import.meta.env.VITE_STOREFRONT_PUBLIC_URL).origin
  : null
const operatorOrigin = import.meta.env.VITE_OPERATOR_PUBLIC_URL
  ? new URL(import.meta.env.VITE_OPERATOR_PUBLIC_URL).origin
  : null

function isStorefrontPath(path) {
  return path.startsWith('/store/') || ['/marketplace', '/my-orders'].includes(path)
}

export function redirectToIsolatedOrigin(location = window.location) {
  if (!storefrontOrigin || !operatorOrigin) return

  // The production build is deployed on both origins. Redirect before React
  // renders so authenticated operator UI never mounts on the public origin.
  const destinationOrigin = location.origin === storefrontOrigin && !isStorefrontPath(location.pathname)
    ? operatorOrigin
    : location.origin === operatorOrigin && isStorefrontPath(location.pathname)
      ? storefrontOrigin
      : location.origin !== storefrontOrigin && location.origin !== operatorOrigin
        ? (isStorefrontPath(location.pathname) ? storefrontOrigin : operatorOrigin)
        : null
  if (destinationOrigin) {
    location.replace(new URL(`${location.pathname}${location.search}${location.hash}`, destinationOrigin))
  }
}
