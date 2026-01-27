import { Effect } from "effect"
import type { Bundle, Engine, FhirResource, SearchQuery } from "../core/engine.js"
import { Gone, NotFound, Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { jsonOf } from "./wire.js"
import type { Answer, Bound, SendRequest } from "./wire.js"
import { TokenClock, TokenNet } from "./token.js"
import type { Post, Time } from "./token.js"
import type { Lifecycle } from "./lifecycle.js"

export type Send = (request: SendRequest) => Effect.Effect<Answer, Failure>

export type Credit = () => Effect.Effect<Readonly<Record<string, string>>, Failure>

export interface RemoteOptions {
  readonly baseUrl: string
  readonly bound: Bound
  readonly credit: Credit
  readonly send: Send
}

interface SearchParamDef {
  readonly name?: string
}

interface ResourceDef {
  readonly type?: string
  readonly searchParam?: ReadonlyArray<SearchParamDef>
}

interface CapabilityStatement {
  readonly resourceType?: string
  readonly rest?: ReadonlyArray<{ readonly resource?: ReadonlyArray<ResourceDef> }>
}

interface SearchPage extends Bundle {
  readonly link?: ReadonlyArray<{ readonly relation?: string; readonly url?: string }>
}

const MOST_PAGES = 100

export const bearerCredit = (token: string): Credit => () =>
  Effect.succeed({ authorization: `Bearer ${token}` })

export const basicCredit = (username: string, password: string): Credit => () =>
  Effect.succeed({
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  })

export const smartCredit = (options: {
  readonly lf: Lifecycle
  readonly clock: Time
  readonly post: Post
  readonly dependency: string
}): Credit => () =>
  options.lf.token().pipe(
    Effect.map((token) => ({ authorization: `Bearer ${token}` })),
    Effect.mapError(() => new Unavailable({ dependency: options.dependency })),
    Effect.provideService(TokenClock, options.clock),
    Effect.provideService(TokenNet, options.post)
  )

const named = (value: unknown, fallback: string): string =>
  typeof value === "string" ? (value as string) : fallback

export const remote = (options: RemoteOptions): Engine => {
  const call = (method: string, path: string) =>
    Effect.gen(function* () {
      const extra = yield* options.credit()
      return yield* options.send({
        method,
        url: /^https?:\/\//.test(path) ? path : `${options.baseUrl}/${path}`,
        headers: { accept: "application/fhir+json", ...Object.fromEntries(Object.entries(extra)) },
        bound: options.bound
      })
    })

  const read = (type: string, id: string) =>
    call("GET", `${type}/${id}`).pipe(
      Effect.flatMap((answer): Effect.Effect<FhirResource, Failure> => {
        if (answer.status === 404) return Effect.fail(new NotFound({ type, id }))
        if (answer.status === 410) return Effect.fail(new Gone({ type, id }))
        const doc = jsonOf(answer.body)
        if (answer.status !== 200 || doc === undefined) {
          return Effect.fail(new Rejected({ reason: `read ${type}/${id} answered ${answer.status}` }))
        }
        if (typeof doc["resourceType"] !== "string") {
          return Effect.fail(new Rejected({ reason: `read ${type}/${id} carried no resource type` }))
        }
        return Effect.succeed(doc as FhirResource)
      })
    )

  const complaint = (doc: Record<string, unknown> | undefined): string | undefined => {
    if (doc === undefined || doc["resourceType"] !== "OperationOutcome") return undefined
    const issues = doc["issue"]
    if (!Array.isArray(issues) || issues.length === 0) return undefined
    const first = issues[0] as Record<string, unknown>
    return typeof first["diagnostics"] === "string" ? first["diagnostics"] : undefined
  }

  const bundleOf = (type: string, answer: Answer): Effect.Effect<SearchPage, Failure> => {
    const doc = jsonOf(answer.body)
    if (answer.status !== 200) {
      const said = complaint(doc)
      return Effect.fail(
        new Rejected({
          reason:
            `search ${type} answered ${answer.status}` + (said === undefined ? "" : `: ${said}`)
        })
      )
    }
    if (doc === undefined) {
      return Effect.fail(new Rejected({ reason: "the answer was not json" }))
    }
    if (doc["resourceType"] !== "Bundle") {
      return Effect.fail(new Rejected({ reason: "the answer was not a bundle" }))
    }
    return Effect.succeed(doc as unknown as SearchPage)
  }

  const nextOf = (page: SearchPage): string | undefined =>
    (page.link ?? []).find((one) => one.relation === "next")?.url

  const search = (query: SearchQuery) =>
    Effect.gen(function* () {
      const offset = query.offset ?? 0
      const params = new URLSearchParams()
      for (const [name, value] of query.parameters) params.append(name, value)
      if (query.limit !== undefined) params.set("_count", String(offset + query.limit))
      const queryString = params.toString()
      const first = yield* bundleOf(
        query.type,
        yield* call("GET", queryString.length > 0 ? `${query.type}?${queryString}` : query.type)
      )
      const wanted = query.limit === undefined ? undefined : offset + query.limit
      const entries = [...(first.entry ?? [])]
      let page = first
      let pages = 1
      while (pages < MOST_PAGES && (wanted === undefined || entries.length < wanted)) {
        const next = nextOf(page)
        if (next === undefined) break
        page = yield* bundleOf(query.type, yield* call("GET", next))
        entries.push(...(page.entry ?? []))
        pages += 1
      }
      const kept = wanted === undefined ? entries.slice(offset) : entries.slice(offset, wanted)
      return {
        resourceType: "Bundle",
        type: "searchset",
        total: first.total ?? entries.length,
        entry: kept
      } satisfies Bundle
    })

  let known: CapabilityStatement | undefined

  const metadata = () =>
    known !== undefined
      ? Effect.succeed(known)
      : call("GET", "metadata").pipe(
          Effect.flatMap((answer): Effect.Effect<CapabilityStatement, Failure> => {
            const doc = jsonOf(answer.body)
            if (answer.status !== 200 || doc === undefined) {
              return Effect.fail(new Rejected({ reason: "the capability statement was refused" }))
            }
            if (doc["resourceType"] !== "CapabilityStatement") {
              return Effect.fail(new Rejected({ reason: "the answer was not a capability statement" }))
            }
            known = doc as unknown as CapabilityStatement
            return Effect.succeed(known)
          })
        )

  const definedTypes = (doc: CapabilityStatement): ReadonlyArray<string> =>
    (doc.rest ?? []).flatMap((rest) =>
      (rest.resource ?? []).map((r) => r.type).filter((t): t is string => t !== undefined)
    )

  const resourceTypes = () =>
    metadata().pipe(Effect.map((doc) => [...new Set(definedTypes(doc))]))

  const searchParameters = (type: string) =>
    metadata().pipe(
      Effect.map((doc) => {
        const declared = (doc.rest ?? []).flatMap((rest) => rest.resource ?? [])
        const matching = declared.find((r) => r.type === type)
        if (matching === undefined) return []
        return (matching.searchParam ?? [])
          .map((p) => named(p.name, ""))
          .filter((name) => name.length > 0)
      })
    )

  return { read, search, resourceTypes, searchParameters }
}