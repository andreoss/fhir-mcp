export type Criterion = "relevance"

export interface Rankable {
  readonly code: string
  readonly display?: string
}

export type Scored<T extends Rankable> = T & {
  readonly rank: number
  readonly score: number
}

export type Ordering<T extends Rankable> =
  | {
      readonly _tag: "ranked"
      readonly criterion: Criterion
      readonly entries: ReadonlyArray<Scored<T>>
    }
  | {
      readonly _tag: "unranked"
      readonly entries: ReadonlyArray<T>
    }

const text = (value: string | undefined): string => (value ?? "").toLowerCase()

const scoreOf = (needle: string, item: Rankable): number => {
  const display = text(item.display)
  const code = text(item.code)
  let score = 0
  if (display !== "") {
    if (display === needle) score += 100
    else if (display.startsWith(needle)) score += 60
    else if (display.includes(needle)) score += 30
  }
  if (code === needle) score += 10
  else if (code.startsWith(needle)) score += 5
  else if (code.includes(needle)) score += 2
  return score
}

const settles = (a: Rankable, b: Rankable): number => {
  const lengthOf = (item: Rankable) => (item.display ?? "").length
  const byLength = lengthOf(a) - lengthOf(b)
  if (byLength !== 0) return byLength
  if (a.code < b.code) return -1
  if (a.code > b.code) return 1
  return 0
}

export const order = <T extends Rankable>(
  query: string | undefined,
  items: ReadonlyArray<T>
): Ordering<T> => {
  if (query === undefined || query.length === 0) {
    return { _tag: "unranked", entries: items }
  }
  const needle = query.toLowerCase()
  const scored = items
    .map((item) => ({ ...item, score: scoreOf(needle, item) }))
    .sort((a, b) => (a.score === b.score ? settles(a, b) : b.score - a.score))
    .map((item, index) => ({ ...item, rank: index + 1 }))
  return { _tag: "ranked", criterion: "relevance", entries: scored }
}