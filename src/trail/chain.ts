import { createHash } from "node:crypto"
import { holds, pins } from "./seal.js"
import type { Anchor, Seal } from "./seal.js"

export type Outcome = "success" | "refused" | "failed"

export interface Entry {
  readonly actor: string
  readonly action: string
  readonly resource: string
  readonly outcome: Outcome
  readonly correlation: string
}

export interface Line extends Entry {
  readonly seq: number
  readonly at: number
  readonly prev: string
  readonly digest: string
}

export interface Held {
  readonly lines: ReadonlyArray<Line>
  readonly anchor: Anchor | undefined
  readonly seals: ReadonlyArray<Seal>
}

export type Cause =
  | "content"
  | "missing"
  | "order"
  | "truncated"
  | "seal"
  | "anchor"

export interface Break {
  readonly seq: number
  readonly cause: Cause
  readonly detail: string
}

export interface Report {
  readonly ok: boolean
  readonly checked: number
  readonly head: number | undefined
  readonly broke: Break | undefined
}

export const GENESIS = "0".repeat(64)

const part = (value: string): string => `${value.length}:${value}`

export const canon = (entry: Entry, at: number, prev: string): string =>
  [
    prev,
    String(at),
    entry.actor,
    entry.action,
    entry.resource,
    entry.outcome,
    entry.correlation
  ]
    .map(part)
    .join("")

export const digestOf = (entry: Entry, at: number, prev: string): string =>
  createHash("sha256").update(canon(entry, at, prev)).digest("hex")

export const intact = (line: Line): boolean =>
  digestOf(line, line.at, line.prev) === line.digest

const expected = (
  lines: ReadonlyArray<Line>,
  index: number,
  anchor: Anchor | undefined
): string => {
  const before = lines[index - 1]
  if (before !== undefined) return before.digest
  const first = lines[index]
  return anchor !== undefined && first !== undefined && anchor.seq === first.seq
    ? anchor.prev
    : GENESIS
}

const linked = (
  lines: ReadonlyArray<Line>,
  anchor: Anchor | undefined
): Break | undefined => {
  const where = new Map(lines.map((line) => [line.digest, line.seq]))
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    if (!intact(line)) {
      return {
        seq: line.seq,
        cause: "content",
        detail: `record ${line.seq} content does not match its digest`
      }
    }
    if (line.prev === expected(lines, index, anchor)) continue
    const held = where.get(line.prev)
    if (held === undefined) {
      return {
        seq: line.seq,
        cause: "missing",
        detail: `record ${line.seq} names a predecessor no longer held`
      }
    }
    return {
      seq: line.seq,
      cause: "order",
      detail: `record ${line.seq} names record ${held}, held later`
    }
  }
  return undefined
}

const pinned = (
  key: string,
  lines: ReadonlyArray<Line>,
  seals: ReadonlyArray<Seal>
): Break | undefined => {
  const bySeq = new Map(lines.map((line) => [line.seq, line]))
  for (const seal of [...seals].sort((a, b) => a.seq - b.seq)) {
    if (!holds(key, seal)) {
      return {
        seq: seal.seq,
        cause: "seal",
        detail: `the seal over record ${seal.seq} does not verify`
      }
    }
    const line = bySeq.get(seal.seq)
    if (line === undefined) {
      return {
        seq: seal.seq,
        cause: "truncated",
        detail: `sealed record ${seal.seq} is no longer in the trail`
      }
    }
    if (line.digest !== seal.digest) {
      return {
        seq: seal.seq,
        cause: "seal",
        detail: `record ${seal.seq} no longer carries the sealed digest`
      }
    }
  }
  return undefined
}

const broken = (key: string, held: Held): Break | undefined => {
  if (held.anchor !== undefined && !pins(key, held.anchor)) {
    return {
      seq: held.anchor.seq,
      cause: "anchor",
      detail: `the anchor at record ${held.anchor.seq} does not verify`
    }
  }
  return (
    linked(held.lines, held.anchor) ?? pinned(key, held.lines, held.seals)
  )
}

export const audit = (key: string, held: Held): Report => {
  const broke = broken(key, held)
  return {
    ok: broke === undefined,
    checked: held.lines.length,
    head: held.lines[held.lines.length - 1]?.seq,
    broke
  }
}

export const write = (held: Held): string =>
  [
    ...held.lines.map((line) => JSON.stringify({ kind: "line", ...line })),
    ...held.seals.map((seal) => JSON.stringify({ kind: "seal", ...seal })),
    ...(held.anchor === undefined
      ? []
      : [JSON.stringify({ kind: "anchor", ...held.anchor })])
  ].join("\n")

export const read = (text: string): Held => {
  const lines: Array<Line> = []
  const seals: Array<Seal> = []
  let anchor: Anchor | undefined
  for (const raw of text.split("\n")) {
    if (raw.trim().length === 0) continue
    const { kind, ...held } = JSON.parse(raw) as { readonly kind: string }
    if (kind === "line") lines.push(held as unknown as Line)
    if (kind === "seal") seals.push(held as unknown as Seal)
    if (kind === "anchor") anchor = held as unknown as Anchor
  }
  return { lines, anchor, seals }
}
