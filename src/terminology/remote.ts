import { Effect } from "effect"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { Rejected, Unavailable } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { reasonFor } from "./system.js"
import type { Absence, Designation } from "./system.js"
import type {
  Contains,
  ExpandRequest,
  Expansion,
  Lookup,
  LookupRequest,
  Match,
  PairRequest,
  Parameter,
  Subsumption,
  Terminology
} from "./port.js"

export interface RemoteSource {
  readonly name: string
  readonly baseUrl: string
  readonly bearer: string
  readonly timeoutMs: number
  readonly retryAfterMs: number
  readonly maxBytes: number
}

export interface Reply {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export type ResponseEntity = Reply

export interface Fetcher {
  readonly get: (
    url: string,
    headers: Readonly<Record<string, string>>
  ) => Effect.Effect<Reply, Failure>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const SUBSET: ReadonlySet<string> = new Set([
  "equivalent",
  "subsumes",
  "subsumed-by",
  "not-subsumed",
  "unknown"
])

const qs = (pairs: ReadonlyArray<readonly [string, string | undefined]>): string =>
  pairs
    .filter((pair) => pair[1] !== undefined)
    .map(([name, value]) => `${name}=${encodeURIComponent(value as string)}`)
    .join("&")

const refused = (name: string, status: number): Rejected =>
  status === 401 || status === 403
    ? new Rejected({ reason: `remote source ${name} refused at ${status}: authentication` })
    : new Rejected({ reason: `remote source ${name} refused at ${status}` })

const rejected = (name: string, reason: string): Rejected =>
  new Rejected({ reason: `remote source ${name}: ${reason}` })

const designationsOf = (raw: unknown): ReadonlyArray<Designation> | undefined => {
  if (!Array.isArray(raw)) return undefined
  const mapped = raw.map((item): Designation | undefined => {
    if (!isRecord(item) || typeof item["value"] !== "string") return undefined
    return {
      value: item["value"],
      ...(typeof item["language"] === "string" ? { language: item["language"] } : {}),
      ...(typeof item["use"] === "string" ? { use: item["use"] } : {})
    }
  })
  return mapped.some((one) => one === undefined) ? undefined : (mapped as ReadonlyArray<Designation>)
}

const containsOf = (raw: unknown): Contains | undefined => {
  if (!isRecord(raw) || typeof raw["code"] !== "string" || typeof raw["system"] !== "string") {
    return undefined
  }
  const children = Array.isArray(raw["contains"]) ? raw["contains"].map(containsOf) : undefined
  if (children !== undefined && children.some((one) => one === undefined)) return undefined
  return {
    system: raw["system"],
    version: typeof raw["version"] === "string" ? raw["version"] : undefined,
    code: raw["code"],
    display: typeof raw["display"] === "string" ? raw["display"] : undefined,
    inactive: typeof raw["inactive"] === "boolean" ? raw["inactive"] : undefined,
    designation: designationsOf(raw["designation"]),
    contains: children as ReadonlyArray<Contains> | undefined,
    ...(typeof raw["rank"] === "number" ? { rank: raw["rank"] } : {}),
    ...(typeof raw["score"] === "number" ? { score: raw["score"] } : {})
  }
}

const parametersOf = (raw: unknown, ranking: string): Parameter[] | undefined => {
  const out: Array<Parameter> = []
  if (Array.isArray(raw)) {
    for (const one of raw) {
      if (
        !isRecord(one) ||
        typeof one["name"] !== "string" ||
        (typeof one["value"] !== "string" &&
          typeof one["value"] !== "number" &&
          typeof one["value"] !== "boolean")
      ) {
        return undefined
      }
      out.push({ name: one["name"], value: one["value"] })
    }
  }
  const at = out.findIndex((one) => one.name === "ranking")
  const named = { name: "ranking", value: ranking }
  if (at >= 0) out[at] = named
  else out.push(named)
  return out
}

const ok = (reply: Reply): boolean => reply.status >= 200 && reply.status < 300

export const remoteTerminology = (source: RemoteSource, fetcher: Fetcher): Terminology => {
  const headers = (): Readonly<Record<string, string>> => ({
    authorization: `Bearer ${source.bearer}`,
    accept: "application/json"
  })

  const endpoint = (
    path: string,
    pairs: ReadonlyArray<readonly [string, string | undefined]>
  ): string => `${source.baseUrl}${path}?${qs(pairs)}`

  const lookup = (request: LookupRequest): Effect.Effect<Lookup, Failure> =>
    Effect.gen(function* () {
      const reply = yield* fetcher.get(
        endpoint("/lookup", [
          ["system", request.system],
          ["code", request.code],
          ["version", request.version]
        ]),
        headers()
      )
      if (!ok(reply)) return yield* Effect.fail(refused(source.name, reply.status))
      const body = jsonOf(reply.body)
      if (!isRecord(body)) {
        return yield* Effect.fail(rejected(source.name, "answered a shape not accepted"))
      }
      if (body["status"] === "empty") {
        const answer: Lookup = {
          _tag: "Unsupplied",
          system: request.system,
          content: (typeof body["content"] === "string" ? body["content"] : "referenced") as Absence,
          reason:
            typeof body["reason"] === "string"
              ? body["reason"]
              : `remote source ${source.name} carries no such code`
        }
        return answer
      }
      if (body["status"] !== "found") {
        return yield* Effect.fail(rejected(source.name, "answered a shape not accepted"))
      }
      const answer: Lookup = {
        _tag: "Found",
        system: request.system,
        version: typeof body["version"] === "string" ? body["version"] : undefined,
        code: typeof body["code"] === "string" ? body["code"] : request.code,
        display: typeof body["display"] === "string" ? body["display"] : undefined,
        inactive: body["inactive"] === true,
        designation: designationsOf(body["designation"]) ?? []
      }
      return answer
    })

  const subsumes = (request: PairRequest): Effect.Effect<Subsumption, Failure> =>
    Effect.gen(function* () {
      const reply = yield* fetcher.get(
        endpoint("/subsumes", [
          ["system", request.system],
          ["left", request.left],
          ["right", request.right],
          ["version", request.version]
        ]),
        headers()
      )
      if (!ok(reply)) return yield* Effect.fail(refused(source.name, reply.status))
      const body = jsonOf(reply.body)
      if (!isRecord(body) || typeof body["answer"] !== "string" || !SUBSET.has(body["answer"])) {
        return yield* Effect.fail(rejected(source.name, "answered a shape not accepted"))
      }
      return body["answer"] as Subsumption
    })

  const compare = (request: PairRequest): Effect.Effect<Match, Failure> =>
    Effect.gen(function* () {
      const reply = yield* fetcher.get(
        endpoint("/compare", [
          ["system", request.system],
          ["left", request.left],
          ["right", request.right],
          ["version", request.version]
        ]),
        headers()
      )
      if (!ok(reply)) return yield* Effect.fail(refused(source.name, reply.status))
      const body = jsonOf(reply.body)
      if (
        !isRecord(body) ||
        (body["match"] !== "codes" && body["match"] !== "text") ||
        typeof body["equal"] !== "boolean"
      ) {
        return yield* Effect.fail(rejected(source.name, "answered a shape not accepted"))
      }
      const equal = body["equal"]
      if (body["match"] === "codes") return { _tag: "Codes", equal }
      return {
        _tag: "Text",
        equal,
        reason: typeof body["reason"] === "string" ? body["reason"] : reasonFor("referenced")
      }
    })

  const expand = (request: ExpandRequest): Effect.Effect<Expansion, Failure> =>
    Effect.gen(function* () {
      const reply = yield* fetcher.get(
        endpoint("/expand", [
          ["url", request.url],
          ["filter", request.filter],
          ["count", request.count === undefined ? undefined : String(request.count)],
          ["offset", request.offset === undefined ? undefined : String(request.offset)],
          ["activeOnly", request.activeOnly === undefined ? undefined : String(request.activeOnly)],
          [
            "designations",
            request.designations === undefined ? undefined : String(request.designations)
          ],
          ["displayLanguage", request.displayLanguage]
        ]),
        headers()
      )
      if (!ok(reply)) return yield* Effect.fail(refused(source.name, reply.status))
      const body = jsonOf(reply.body)
      if (
        !isRecord(body) ||
        body["resourceType"] !== "ValueSet" ||
        typeof body["url"] !== "string" ||
        !isRecord(body["expansion"])
      ) {
        return yield* Effect.fail(rejected(source.name, "answered a shape not accepted"))
      }
      const expansion = body["expansion"] as Record<string, unknown>
      if (
        typeof expansion["timestamp"] !== "string" ||
        typeof expansion["total"] !== "number" ||
        !Array.isArray(expansion["contains"])
      ) {
        return yield* Effect.fail(rejected(source.name, "answered a shape not accepted"))
      }
      const contains = expansion["contains"].map(containsOf)
      if (contains.some((one) => one === undefined)) {
        return yield* Effect.fail(rejected(source.name, "answered a shape not accepted"))
      }
      const ranking = typeof expansion["ranking"] === "string" ? expansion["ranking"] : "none"
      const parameter = parametersOf(expansion["parameter"], ranking)
      if (parameter === undefined) {
        return yield* Effect.fail(rejected(source.name, "answered a shape not accepted"))
      }
      const answer: Expansion = {
        resourceType: "ValueSet",
        url: body["url"],
        version: typeof body["version"] === "string" ? body["version"] : undefined,
        expansion: {
          timestamp: expansion["timestamp"],
          total: expansion["total"],
          offset: typeof expansion["offset"] === "number" ? expansion["offset"] : undefined,
          parameter,
          contains: contains as ReadonlyArray<Contains>
        }
      }
      return answer
    })

  return { lookup, subsumes, compare, expand }
}

interface Fault {
  readonly _tag: "large" | "refused" | "address" | "total" | "timeout" | "transport"
}

const flat = (headers: import("node:http").IncomingHttpHeaders): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out[name] = Array.isArray(value) ? value.join(", ") : String(value)
  }
  return out
}

const getReply = (url: string, headers: Readonly<Record<string, string>>, source: RemoteSource): Promise<Reply> =>
  new Promise((resolve, reject) => {
    let held: URL
    try {
      held = new URL(url)
    } catch {
      reject({ _tag: "address" } satisfies Fault)
      return
    }
    const mod =
      held.protocol === "https:"
        ? httpsRequest
        : held.protocol === "http:"
          ? httpRequest
          : undefined
    if (mod === undefined) {
      reject({ _tag: "refused" } satisfies Fault)
      return
    }
    const req = mod(held, { method: "GET", headers }, (res) => {
      const status = res.statusCode ?? 0
      const body: Array<string> = []
      let total = 0
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        total += chunk.length
        if (total > source.maxBytes) {
          res.destroy()
          reject({ _tag: "total" } satisfies Fault)
          return
        }
        body.push(chunk)
      })
      res.on("end", () => {
        resolve({ status, headers: flat(res.headers), body: body.join("") })
      })
      res.on("error", () => reject({ _tag: "transport" } satisfies Fault))
    })
    req.setTimeout(source.timeoutMs, () => {
      req.destroy()
      reject({ _tag: "timeout" } satisfies Fault)
    })
    req.on("error", () => reject({ _tag: "transport" } satisfies Fault))
    req.end()
  })

const faultTo = (fault: unknown, source: RemoteSource): Failure => {
  if (typeof fault === "object" && fault !== null && "_tag" in fault) {
    const tag = (fault as Fault)._tag
    if (tag === "total") {
      return new Rejected({
        reason: `remote source ${source.name} answered beyond the byte bound of ${source.maxBytes}`
      })
    }
    if (tag === "refused" || tag === "address") {
      return new Rejected({ reason: `remote source ${source.name} refused the address` })
    }
  }
  return new Unavailable({
    dependency: `${source.name} (retry after ${source.retryAfterMs}ms)`
  })
}

export const nodeFetcher = (source: RemoteSource): Fetcher => ({
  get: (url, headers) =>
    Effect.tryPromise({
      try: () => getReply(url, headers, source),
      catch: (cause) => faultTo(cause, source)
    })
})

const referrals = (reason: string): boolean =>
  reason.includes("unknown code system") ||
  reason.includes("carries no content") ||
  reason.includes("no content for")

export const hybrid = (local: Terminology, remote: Terminology): Terminology => ({
  lookup: (request) =>
    Effect.flatMap(local.lookup(request), (answer) =>
      answer._tag === "Found" || answer.content !== "referenced"
        ? Effect.succeed(answer)
        : remote.lookup(request)
    ),
  subsumes: (request) =>
    Effect.flatMap(local.subsumes(request), (answer) =>
      answer === "unknown" ? remote.subsumes(request) : Effect.succeed(answer)
    ),
  compare: (request) =>
    Effect.flatMap(local.compare(request), (answer) =>
      answer._tag === "Codes" || answer.reason !== reasonFor("referenced")
        ? Effect.succeed(answer)
        : remote.compare(request)
    ),
  expand: (request) =>
    local.expand(request).pipe(
      Effect.catchAll((failure) =>
        failure instanceof Rejected && referrals(failure.reason)
          ? remote.expand(request)
          : Effect.fail(failure)
      )
    )
})