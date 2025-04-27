import { Effect } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { isControl } from "../search/control.js"
import { at, ready } from "./model.js"
import type { Entry, Snapshot } from "./model.js"

const refuse = (reason: string): Effect.Effect<never, Failure> =>
  Effect.fail(new Rejected({ reason }))

const headOf = (name: string): string =>
  (name.split(":")[0] ?? name).split(".")[0] ?? name

const inForce = (
  held: Snapshot,
  type: string,
  name: string
): Effect.Effect<Entry, Failure> => {
  const entry = held.entries.get(at(type, name))
  if (entry === undefined) {
    return refuse(`unknown search parameter: ${name} on ${type}`)
  }
  return ready(entry)
    ? Effect.succeed(entry)
    : refuse(`search parameter not ready: ${at(type, name)} is ${entry.status}`)
}

const backwards = (
  held: Snapshot,
  name: string
): Effect.Effect<void, Failure> => {
  const segments = name.split(":")
  if (segments.length < 4) {
    return refuse(`${name}: expected _has:Type:reference:parameter`)
  }
  const source = segments[1] ?? ""
  const link = segments[2] ?? ""
  return inForce(held, source, link).pipe(
    Effect.flatMap((entry) =>
      entry.definition.valueType === "reference"
        ? check(held, source, segments.slice(3).join(":"))
        : refuse(`${name}: ${at(source, link)} is not a reference`)
    )
  )
}

const chained = (
  held: Snapshot,
  type: string,
  head: string,
  rest: string
): Effect.Effect<void, Failure> => {
  const [base, named] = head.split(":")
  const link = base ?? head
  return inForce(held, type, link).pipe(
    Effect.flatMap((entry) => {
      if (entry.definition.valueType !== "reference") {
        return refuse(`${head}: ${link} is not a reference and cannot be chained`)
      }
      const [only, ...others] = entry.definition.targets
      const target = named ?? (others.length === 0 ? only : undefined)
      if (target === undefined) {
        return refuse(`${head}: the chain target of ${link} is ambiguous, name the type`)
      }
      return check(held, target, rest)
    })
  )
}

const check = (
  held: Snapshot,
  type: string,
  name: string
): Effect.Effect<void, Failure> => {
  if (name === "_has" || name.startsWith("_has:")) return backwards(held, name)
  const dot = name.indexOf(".")
  if (dot >= 0) {
    return chained(held, type, name.slice(0, dot), name.slice(dot + 1))
  }
  return Effect.asVoid(inForce(held, type, name.split(":")[0] ?? name))
}

export const admit = (
  held: Snapshot,
  type: string,
  entries: ReadonlyArray<readonly [string, string]>
): Effect.Effect<void, Failure> =>
  Effect.forEach(
    entries,
    ([name]) => (isControl(headOf(name)) ? Effect.void : check(held, type, name)),
    { discard: true }
  )
