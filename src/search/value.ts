import { Effect } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import type {
  Component,
  DateValue,
  OfTypeValue,
  Precision,
  Prefix,
  ReferenceValue,
  TokenValue,
  Value,
  ValueType
} from "./tree.js"

const PREFIXES: ReadonlySet<string> = new Set<Prefix>([
  "eq",
  "ne",
  "gt",
  "lt",
  "ge",
  "le",
  "sa",
  "eb",
  "ap"
])

const NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/

const DATE =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/

const URL_REF = /^https?:\/\/\S+$/

const TYPED_REF = /^([A-Z][A-Za-z]{0,63})\/([A-Za-z0-9\-.]{1,64})$/

const ID_REF = /^[A-Za-z0-9\-.]{1,64}$/

const refuse = (reason: string): Effect.Effect<never, Failure> =>
  Effect.fail(new Rejected({ reason }))

const cut = (raw: string, separator: string): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let current = ""
  let escaped = false
  for (const character of raw) {
    if (escaped) {
      current += "\\" + character
      escaped = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (character === separator) {
      parts.push(current)
      current = ""
      continue
    }
    current += character
  }
  if (escaped) current += "\\"
  parts.push(current)
  return parts
}

export const splitOr = (raw: string): ReadonlyArray<string> => cut(raw, ",")

export const unescape = (raw: string): string => {
  let out = ""
  let escaped = false
  for (const character of raw) {
    if (escaped) {
      out += character
      escaped = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    out += character
  }
  return escaped ? out + "\\" : out
}

const withPrefix = (raw: string): { readonly prefix: Prefix; readonly rest: string } =>
  raw.length > 2 && PREFIXES.has(raw.slice(0, 2))
    ? { prefix: raw.slice(0, 2) as Prefix, rest: raw.slice(2) }
    : { prefix: "eq", rest: raw }

const digits = (raw: string, name: string): Effect.Effect<number, Failure> =>
  NUMBER.test(raw)
    ? Effect.succeed(Number(raw))
    : refuse(`${name}: expected a number, got ${raw}`)

const offsetOf = (zone: string | undefined): number => {
  if (zone === undefined || zone === "Z") return 0
  const sign = zone.startsWith("-") ? -1 : 1
  const hours = Number(zone.slice(1, 3))
  const minutes = Number(zone.slice(4, 6))
  return sign * (hours * 60 + minutes) * 60000
}

const precisionOf = (
  month: string | undefined,
  day: string | undefined,
  hour: string | undefined,
  second: string | undefined,
  fraction: string | undefined
): Precision => {
  if (month === undefined) return "year"
  if (day === undefined) return "month"
  if (hour === undefined) return "day"
  if (second === undefined) return "minute"
  return fraction === undefined ? "second" : "instant"
}

const iso = (at: number): string => new Date(at).toISOString()

const dateRange = (raw: string, name: string): Effect.Effect<DateValue, Failure> => {
  const { prefix, rest } = withPrefix(raw)
  const found = DATE.exec(rest)
  if (found === null) return refuse(`${name}: expected a date, got ${raw}`)
  const [, year, month, day, hour, minute, second, fraction, zone] = found
  const y = Number(year)
  const mo = month === undefined ? 1 : Number(month)
  const d = day === undefined ? 1 : Number(day)
  const hh = hour === undefined ? 0 : Number(hour)
  const mi = minute === undefined ? 0 : Number(minute)
  const ss = second === undefined ? 0 : Number(second)
  const ms = fraction === undefined ? 0 : Math.floor(Number(`0${fraction}`) * 1000)
  if (mo < 1 || mo > 12 || d < 1 || hh > 23 || mi > 59 || ss > 59) {
    return refuse(`${name}: expected a date, got ${raw}`)
  }
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return refuse(`${name}: expected a date, got ${raw}`)
  }
  const offset = offsetOf(zone)
  const start = Date.UTC(y, mo - 1, d, hh, mi, ss, ms) - offset
  const precision = precisionOf(month, day, hour, second, fraction)
  const end =
    precision === "year"
      ? Date.UTC(y + 1, 0, 1) - offset
      : precision === "month"
        ? Date.UTC(y, mo, 1) - offset
        : precision === "day"
          ? start + 86400000
          : precision === "minute"
            ? start + 60000
            : precision === "second"
              ? start + 1000
              : start + 1
  return Effect.succeed({
    kind: "date",
    prefix,
    precision,
    start: iso(start),
    end: iso(end),
    text: raw
  })
}

const token = (raw: string, name: string): Effect.Effect<TokenValue, Failure> => {
  const parts = cut(raw, "|")
  const [left, right] = parts
  if (parts.length === 1) {
    const code = unescape(left ?? "")
    return code.length === 0
      ? refuse(`${name}: expected a token, got ${raw}`)
      : Effect.succeed({ kind: "token", system: undefined, code, anySystem: true, text: raw })
  }
  if (parts.length > 2) return refuse(`${name}: expected a token, got ${raw}`)
  const system = unescape(left ?? "")
  const code = unescape(right ?? "")
  if (system.length === 0 && code.length === 0) {
    return refuse(`${name}: expected a token, got ${raw}`)
  }
  return Effect.succeed({
    kind: "token",
    system: system.length === 0 ? undefined : system,
    code: code.length === 0 ? undefined : code,
    anySystem: false,
    text: raw
  })
}

const quantity = (raw: string, name: string): Effect.Effect<Value, Failure> => {
  const { prefix, rest } = withPrefix(raw)
  const parts = cut(rest, "|")
  if (parts.length !== 1 && parts.length !== 3) {
    return refuse(`${name}: expected value|system|code, got ${raw}`)
  }
  const [amount, system, code] = parts
  return digits(unescape(amount ?? ""), name).pipe(
    Effect.map((value) => ({
      kind: "quantity" as const,
      prefix,
      value,
      system: system === undefined || system.length === 0 ? undefined : unescape(system),
      code: code === undefined || code.length === 0 ? undefined : unescape(code),
      text: raw
    }))
  )
}

const reference = (raw: string, name: string): Effect.Effect<ReferenceValue, Failure> => {
  const text = unescape(raw)
  if (URL_REF.test(text)) {
    return Effect.succeed({ kind: "reference", ref: { form: "url", url: text }, text: raw })
  }
  const typed = TYPED_REF.exec(text)
  if (typed !== null) {
    return Effect.succeed({
      kind: "reference",
      ref: { form: "typed", type: typed[1] ?? "", id: typed[2] ?? "" },
      text: raw
    })
  }
  return ID_REF.test(text)
    ? Effect.succeed({ kind: "reference", ref: { form: "id", id: text }, text: raw })
    : refuse(`${name}: expected a reference, got ${raw}`)
}

export const parseIdentifier = (
  raw: string,
  name: string
): Effect.Effect<ReferenceValue, Failure> =>
  token(raw, name).pipe(
    Effect.map((found) => ({
      kind: "reference" as const,
      ref: {
        form: "identifier" as const,
        system: found.system,
        code: found.code,
        anySystem: found.anySystem
      },
      text: raw
    }))
  )

export const parseOfType = (raw: string, name: string): Effect.Effect<OfTypeValue, Failure> => {
  const parts = cut(raw, "|").map(unescape)
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return refuse(`${name}: expected system|code|value, got ${raw}`)
  }
  const [system, code, value] = parts
  return Effect.succeed({
    kind: "of-type",
    system: system ?? "",
    code: code ?? "",
    value: value ?? "",
    text: raw
  })
}

export const parseValue = (
  valueType: ValueType,
  raw: string,
  name: string,
  components: ReadonlyArray<Component> = []
): Effect.Effect<Value, Failure> => {
  switch (valueType) {
    case "number": {
      const { prefix, rest } = withPrefix(raw)
      return digits(unescape(rest), name).pipe(
        Effect.map((value) => ({ kind: "number" as const, prefix, value, text: raw }))
      )
    }
    case "date":
      return dateRange(raw, name)
    case "string": {
      const text = unescape(raw)
      return text.length === 0
        ? refuse(`${name}: expected text, got an empty value`)
        : Effect.succeed({ kind: "string", text })
    }
    case "token":
      return token(raw, name)
    case "quantity":
      return quantity(raw, name)
    case "reference":
      return reference(raw, name)
    case "uri": {
      const value = unescape(raw)
      return value.length === 0
        ? refuse(`${name}: expected an address, got an empty value`)
        : Effect.succeed({ kind: "uri", value, text: raw })
    }
    case "composite": {
      const parts = cut(raw, "$")
      if (parts.length !== components.length) {
        return refuse(
          `${name}: expected ${components.length} components, got ${parts.length}`
        )
      }
      return Effect.forEach(components, (component, index) =>
        parseValue(component.valueType, parts[index] ?? "", `${name}.${component.name}`)
      ).pipe(Effect.map((found) => ({ kind: "composite" as const, parts: found, text: raw })))
    }
  }
}
