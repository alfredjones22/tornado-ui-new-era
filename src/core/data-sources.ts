/** Defaults are conveniences, not required services. null disables a remote
 * source; undefined keeps its default. Bundled files always take precedence. */
export interface DataSources { sagaUrl?: string | null; artifactsUrl?: string | null }
export const SAGA_URLS = { 1: 'https://saga.0000000000.org', 11155111: 'https://saga.0000000000.org/sepolia' } as const
export const ARTIFACTS_URL = 'https://artifacts.0000000000.org/'
export const sourceUrl = (file: string, base: string) => new URL(file, `${base.replace(/\/+$/, '')}/`).href
