const MANAGED_RUNE_PAGE_KEY = 'sona-chat-bridge.rune-page-id.v1'

// Page names remain clean; ownership follows the exact ID written by Sona.
// Retain recognition of branded pages created by upstream versions.
export function isManagedRunePage(page: { id: number; name: string }): boolean {
  return /\s-\s*Sona$/i.test(page.name) || DataStore.get<number>(MANAGED_RUNE_PAGE_KEY) === page.id
}

export function rememberRunePage<T extends { id: number }>(page: T): T {
  DataStore.set(MANAGED_RUNE_PAGE_KEY, page.id)
  return page
}
