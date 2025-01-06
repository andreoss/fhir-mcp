import { Clock, Effect, Layer } from "effect"
import { NotFound } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { ancestorOf, findConcept, reasonFor, resolve } from "./system.js"
import type { Sources } from "./system.js"
import { expand as expandValueSet } from "./expand.js"
import { TerminologyPort } from "./port.js"
import type {
  ExpandRequest,
  Expansion,
  Lookup,
  LookupRequest,
  Match,
  PairRequest,
  Subsumption,
  Terminology
} from "./port.js"
import { load } from "./load.js"
import type { TerminologyFiles } from "./load.js"

export const make = (sources: Sources): Terminology => {
  const lookup = ({ system, code, version }: LookupRequest): Effect.Effect<Lookup, Failure> =>
    Effect.suspend((): Effect.Effect<Lookup, Failure> => {
      const found = resolve(sources, system, version)
      if (found._tag !== "System") {
        const content = found._tag === "Unsupplied" ? found.record.content : "referenced"
        const reason = found._tag === "Unsupplied" ? found.record.reason : reasonFor("referenced")
        const answer: Lookup = { _tag: "Unsupplied", system, content, reason }
        return Effect.succeed(answer)
      }
      const concept = findConcept(found.system, code)
      if (concept === undefined) {
        if (found.system.content === "complete") {
          return Effect.fail(new NotFound({ type: system, id: code }))
        }
        const answer: Lookup = {
          _tag: "Unsupplied",
          system,
          content: found.system.content,
          reason: reasonFor(found.system.content)
        }
        return Effect.succeed(answer)
      }
      const answer: Lookup = {
        _tag: "Found",
        system,
        version: found.system.version,
        code: concept.code,
        display: concept.display,
        inactive: concept.inactive === true,
        designation: concept.designation ?? []
      }
      return Effect.succeed(answer)
    })

  const subsumes = ({
    system,
    left,
    right,
    version
  }: PairRequest): Effect.Effect<Subsumption, Failure> =>
    Effect.suspend((): Effect.Effect<Subsumption, Failure> => {
      const found = resolve(sources, system, version)
      if (found._tag !== "System") return Effect.succeed<Subsumption>("unknown")
      const above = findConcept(found.system, left)
      const below = findConcept(found.system, right)
      if (above === undefined || below === undefined) {
        return found.system.content === "complete"
          ? Effect.fail(new NotFound({ type: system, id: above === undefined ? left : right }))
          : Effect.succeed<Subsumption>("unknown")
      }
      if (above.code === below.code) return Effect.succeed<Subsumption>("equivalent")
      if (ancestorOf(found.system, above.code, below.code)) {
        return Effect.succeed<Subsumption>("subsumes")
      }
      if (ancestorOf(found.system, below.code, above.code)) {
        return Effect.succeed<Subsumption>("subsumed-by")
      }
      return Effect.succeed<Subsumption>("not-subsumed")
    })

  const compare = ({
    system,
    left,
    right,
    version
  }: PairRequest): Effect.Effect<Match, Failure> =>
    Effect.suspend((): Effect.Effect<Match, Failure> => {
      const asText = (reason: string) =>
        Effect.succeed<Match>({ _tag: "Text", equal: left === right, reason })
      const found = resolve(sources, system, version)
      if (found._tag === "Unknown") return asText(reasonFor("referenced"))
      if (found._tag === "Unsupplied") return asText(found.record.reason)
      const one = findConcept(found.system, left)
      const other = findConcept(found.system, right)
      if (one === undefined || other === undefined) {
        return found.system.content === "complete"
          ? Effect.fail(new NotFound({ type: system, id: one === undefined ? left : right }))
          : asText(reasonFor(found.system.content))
      }
      return Effect.succeed<Match>({ _tag: "Codes", equal: one.code === other.code })
    })

  const expand = (request: ExpandRequest): Effect.Effect<Expansion, Failure> =>
    Effect.flatMap(Clock.currentTimeMillis, (millis) =>
      expandValueSet(sources, request, new Date(millis).toISOString())
    )

  return { lookup, subsumes, compare, expand }
}

export const layer = (sources: Sources): Layer.Layer<TerminologyPort> =>
  Layer.succeed(TerminologyPort, make(sources))

export const fromDirectory = (
  dir: string,
  base: Sources
): Effect.Effect<Sources, Failure, TerminologyFiles> =>
  Effect.map(load(dir), (loaded) => ({
    ...base,
    loaded: [...(base.loaded ?? []), ...loaded]
  }))
