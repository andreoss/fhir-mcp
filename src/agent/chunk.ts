export interface Chunk {
  readonly offset: number
  readonly length: number
  readonly text: string
}

export interface Page {
  readonly total: number
  readonly chunks: ReadonlyArray<Chunk>
  readonly withheld: number
}

export const split = (text: string, budget: number): ReadonlyArray<Chunk> => {
  const points = Array.from(text)
  const out: Array<Chunk> = []
  const step = Math.max(1, Math.floor(budget))
  for (let at = 0; at < points.length; at += step) {
    const part = points.slice(at, at + step)
    out.push({ offset: at, length: part.length, text: part.join("") })
  }
  return out
}

export const page = (
  chunks: ReadonlyArray<Chunk>,
  start: number,
  first: number
): Page => {
  const from = Math.max(0, start)
  const taken = chunks.slice(from, from + Math.max(1, first))
  return { total: chunks.length, chunks: taken, withheld: chunks.length - taken.length }
}