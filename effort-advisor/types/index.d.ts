export type Snapshot = {
  display: 'band' | 'status' | 'both' | 'none'
  model: string
  current: string
  /** The level the prompt was judged against (before any change chosen). */
  judgedFrom: string
  recommended: string | null
  confidence: number
  isMismatch: boolean
  /** Why it did or did not ask (boundary, cooldown, confidence...). */
  decision: string
  /** The prompt's head, for /effort-advise. */
  prompt: string
  reasons: string[]
  notes: string[]
  scores: Record<string, number>
  message: string | null
  /** Up/down evidence lines for /effort-advise. */
  upEvidence: string[]
  downEvidence: string[]
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'effort-advisor': { snapshot: Shaped<Snapshot | null> }
  }
}
