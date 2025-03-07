export const PINNED_REVISION = "2025-03-26" as const

export interface Negotiated {
  readonly agreed: typeof PINNED_REVISION
  readonly asked: string | undefined
}

export const negotiate = (asked: string | undefined): Negotiated => ({
  agreed: PINNED_REVISION,
  asked
})

export interface Capabilities {
  readonly tools: { readonly listChanged: boolean }
}

export const capabilities = (): Capabilities => ({ tools: { listChanged: false } })
