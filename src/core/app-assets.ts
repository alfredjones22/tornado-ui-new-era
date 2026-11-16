/** Both index.html and compliance/index.html share public assets at the app
 * root. Keep that root inside the deployment directory, including IPFS CIDs. */
export function appAssetUrl(file: string): string {
  const documentUrl = new URL(location.href)
  documentUrl.pathname = documentUrl.pathname.replace(/\/compliance(?:\/(?:index\.html)?)?$/, '/')
  return new URL(file, new URL(import.meta.env.BASE_URL, documentUrl)).href
}
