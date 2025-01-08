export type Primitive =
  | "string"
  | "boolean"
  | "integer"
  | "decimal"
  | "date"
  | "dateTime"
  | "instant"
  | "uri"
  | "code"
  | "id"

export type Card = "0..1" | "1..1" | "0..*" | "1..*"

export interface Leaf {
  readonly kind: Primitive
  readonly card: Card
}

export interface Group {
  readonly kind: "group"
  readonly card: Card
  readonly children: Elements
}

export interface Open {
  readonly kind: "open"
  readonly card: Card
}

export type Element = Leaf | Group | Open

export type Elements = Record<string, Element>

export interface Definition {
  readonly type: string
  readonly elements: Elements
}

export const el = (kind: Primitive, card: Card = "0..1"): Leaf => ({
  kind,
  card
})

export const group = (children: Elements, card: Card = "0..1"): Group => ({
  kind: "group",
  card,
  children
})

export const open = (card: Card = "0..1"): Open => ({ kind: "open", card })

export const repeats = (card: Card): boolean => card.endsWith("*")

export const required = (card: Card): boolean => card.startsWith("1")

const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/
const DATETIME =
  /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?)?)?$/
const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const CODE = /^[^\s]+( [^\s]+)*$/
const ID = /^[A-Za-z0-9\-.]{1,64}$/
const DAY = /^(\d{4})-(\d{2})-(\d{2})/
const CLOCK = /T(\d{2}):(\d{2}):(\d{2})/

const MONTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const leap = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

const dated = (text: string): boolean => {
  const parts = DAY.exec(text)
  if (parts === null) return true
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const held = MONTHS[month - 1]
  if (held === undefined) return false
  const last = month === 2 && leap(year) ? 29 : held
  return day >= 1 && day <= last
}

const timed = (text: string): boolean => {
  const parts = CLOCK.exec(text)
  if (parts === null) return true
  return (
    Number(parts[1]) <= 23 && Number(parts[2]) <= 59 && Number(parts[3]) <= 60
  )
}

export const matches = (kind: Primitive, value: unknown): boolean => {
  if (kind === "boolean") return typeof value === "boolean"
  if (kind === "integer") return Number.isInteger(value)
  if (kind === "decimal") {
    return typeof value === "number" && Number.isFinite(value)
  }
  if (typeof value !== "string") return false
  switch (kind) {
    case "string":
      return value.trim().length > 0
    case "uri":
      return value.length > 0 && !/\s/.test(value)
    case "code":
      return CODE.test(value)
    case "id":
      return ID.test(value)
    case "date":
      return DATE.test(value) && dated(value)
    case "dateTime":
      return DATETIME.test(value) && dated(value) && timed(value)
    case "instant":
      return INSTANT.test(value) && dated(value) && timed(value)
  }
}
