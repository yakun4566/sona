export interface ChatBridge {
  begin(): Promise<number>
  check(round: number): Promise<void>
  save(text: string, round: number): Promise<void>
}

declare global {
  interface Window {
    __SONA_CHAT_BRIDGE__?: ChatBridge
    __SONA_QUERY_ENEMIES__?: () => Promise<string>
  }
}
