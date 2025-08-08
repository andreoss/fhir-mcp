import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { DepotPort } from "../bulk/depot.js"
import type { Depot, Fault, Sheet } from "../bulk/depot.js"
import { Jobs } from "../jobs/service.js"
import type { Desk, Status, Ticket } from "../jobs/service.js"
import { Journal } from "./audit.js"
import type { Entry, Ledger } from "./audit.js"
import { callJob, jobTools } from "./jobs.js"
import { JOB_RULES } from "./rules.js"
import type { ToolResult } from "./tools.js"

const TICKET: Ticket = { id: "j1", location: "/jobs/j1", retryAfter: 5 }

const STATUS: Status = {
  id: "j1",
  kind: "reindex",
  state: "queued",
  location: "/jobs/j1",
  retryAfter: 5,
  total: 1,
  pending: 1,
  done: 0,
  failed: 0,
  cancelled: 0,
  detail: undefined
}

interface Seen {
  readonly calls: Array<string>
  readonly notes: Array<Entry>
}

const depotOf = (
  files: Readonly<Record<string, ReadonlyArray<string>>> = {},
  faults: ReadonlyArray<Fault> = []
): Depot => {
  const held = new Map(Object.entries(files))
  return {
    put: (path, lines) =>
      Effect.sync(() => {
        held.set(path, lines)
      }),
    get: (path) => Effect.succeed(held.get(path) ?? []),
    list: (prefix) =>
      Effect.succeed(
        [...held.entries()]
          .filter(([path]) => path.startsWith(prefix))
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([path, lines]) => ({ path, rows: lines.length } satisfies Sheet))
      ),
    note: () => Effect.void,
    noted: () => Effect.succeed(undefined),
    mark: () => Effect.void,
    marks: () => Effect.succeed([]),
    fault: () => Effect.void,
    faults: () => Effect.succeed(faults),
    ids: () => Effect.succeed([]),
    targets: () => Effect.succeed([]),
    refresh: () => Effect.succeed(0)
  } satisfies Depot
}

const faked = (
  seen: Seen,
  over: Partial<Desk> = {},
  depot: Depot = depotOf()
): Layer.Layer<Jobs | Journal | DepotPort> =>
  Layer.mergeAll(
    Layer.succeed(DepotPort, depot),
    Layer.succeed(Jobs, {
      submit: (kind, request) => {
        seen.calls.push(`submit:${kind}:${request}`)
        return Effect.succeed(TICKET)
      },
      status: (id) => {
        seen.calls.push(`status:${id}`)
        return Effect.succeed({ ...STATUS, id })
      },
      cancel: (id) => {
        seen.calls.push(`cancel:${id}`)
        return Effect.void
      },
      ...over
    } satisfies Desk),
    Layer.succeed(Journal, {
      note: (entry) =>
        Effect.sync(() => {
          seen.notes.push(entry)
        })
    } satisfies Ledger)
  )

const answered = (
  seen: Seen,
  name: string,
  args: unknown,
  over: Partial<Desk> = {},
  depot?: Depot
): Promise<ToolResult> =>
  Effect.runPromise(
    Effect.provide(callJob(name, args), faked(seen, over, depot ?? depotOf()))
  )

const first = (result: ToolResult): Record<string, unknown> =>
  JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>

describe("JOB-02 job tools on the served surface", () => {
  it("serves one tool per step of an asynchronous job", () => {
    expect(jobTools.map((tool) => tool.name)).toEqual([
      "job-submit",
      "job-status",
      "job-cancel",
      "job-output"
    ])
  })

  it("carries the operating rules in every description", () => {
    for (const tool of jobTools) {
      expect(tool.description).toContain(JOB_RULES)
      expect(tool.description).toContain(tool.name)
    }
  })

  it("names the kinds a submission may ask for", () => {
    const submit = jobTools.find((tool) => tool.name === "job-submit")
    const kind = (submit?.inputSchema.properties["kind"] ?? {}) as { enum?: ReadonlyArray<string> }
    expect(kind.enum).toEqual(["import", "export", "bulk-delete", "bulk-update", "reindex"])
    expect(submit?.inputSchema.required).toEqual(["kind", "request"])
  })

  it("annotates a submission as destructive and a poll as read only", () => {
    const submit = jobTools.find((tool) => tool.name === "job-submit")
    const poll = jobTools.find((tool) => tool.name === "job-status")
    expect(submit?.annotations.destructiveHint).toBe(true)
    expect(submit?.annotations.idempotentHint).toBe(false)
    expect(poll?.annotations.destructiveHint).toBe(false)
    expect(poll?.annotations.idempotentHint).toBe(true)
  })

  it("answers a submission with a status location and a retry hint", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-submit", {
      kind: "reindex",
      request: '{"type":"Patient"}'
    })
    expect(result.isError).toBe(false)
    expect(first(result)).toEqual({ ...TICKET })
    expect(seen.calls).toEqual(['submit:reindex:{"type":"Patient"}'])
  })

  it("answers a poll with the state of the job", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-status", { id: "j1" })
    expect(result.isError).toBe(false)
    expect(first(result)).toEqual({ ...STATUS })
    expect(seen.calls).toEqual(["status:j1"])
  })

  it("answers a cancellation with the state it left behind", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-cancel", { id: "j1" }, {
      status: (id) => {
        seen.calls.push(`status:${id}`)
        return Effect.succeed({ ...STATUS, id, state: "cancelled", retryAfter: undefined })
      }
    })
    expect(result.isError).toBe(false)
    expect(first(result)["state"]).toBe("cancelled")
    expect(seen.calls).toEqual(["cancel:j1", "status:j1"])
  })

  it("refuses a kind the desk does not carry as an outcome", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-submit", { kind: "explode", request: "{}" })
    expect(result.isError).toBe(true)
    expect(first(result)["resourceType"]).toBe("OperationOutcome")
    expect(JSON.stringify(result.content)).toContain("kind")
    expect(seen.calls).toEqual([])
  })

  it("refuses a poll without a job id as an outcome", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-status", {})
    expect(result.isError).toBe(true)
    expect(first(result)["resourceType"]).toBe("OperationOutcome")
    expect(seen.calls).toEqual([])
  })

  it("reports a refusal of the desk as an outcome, not as a crash", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-submit", { kind: "import", request: "{}" }, {
      submit: () => Effect.fail(new Rejected({ reason: "import splits into no unit of work" }))
    })
    expect(result.isError).toBe(true)
    expect(first(result)["resourceType"]).toBe("OperationOutcome")
    expect(JSON.stringify(result.content)).toContain("no unit of work")
  })

  it("refuses a tool it does not serve as an outcome", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-explode", {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain("unknown tool")
  })

  it("journals every call with its tool and outcome", async () => {
    const seen: Seen = { calls: [], notes: [] }
    await answered(seen, "job-status", { id: "j1" })
    expect(seen.notes.map((note) => [note.tool, note.outcome])).toEqual([
      ["job-status", "success"]
    ])
    expect(seen.notes[0]?.correlation).toBe("none")
  })

  it("journals the outcome without the diagnostics it answered with", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-submit", { kind: "export", request: "{}" }, {
      submit: (): Effect.Effect<Ticket, Failure> =>
        Effect.fail(new Rejected({ reason: "export splits into no unit of work" }))
    })
    expect(seen.notes.map((note) => note.outcome)).toEqual(["refused"])
    expect(JSON.stringify(seen.notes)).not.toContain("no unit of work")
    expect(JSON.stringify(result.content)).toContain("no unit of work")
  })

  it("needs no journal to answer", async () => {
    const asked: Seen = { calls: [], notes: [] }
    const result = await Effect.runPromise(
      Effect.provide(
        callJob("job-status", { id: "j1" }),
        Layer.merge(
          Layer.succeed(DepotPort, depotOf()),
          Layer.succeed(Jobs, {
            submit: () => Effect.succeed(TICKET),
            status: () => Effect.succeed(STATUS),
            cancel: () => Effect.void
          } satisfies Desk)
        )
      )
    )
    expect(result.isError).toBe(false)
    expect(asked.calls).toEqual([])
  })
})

describe("EXP-04 the output of a job on the served surface", () => {
  const SHEET = "export/j1/Patient-0.ndjson"

  const written = depotOf({
    [SHEET]: ['{"resourceType":"Patient","id":"p1"}', '{"resourceType":"Patient","id":"p2"}']
  })

  it("names the sheets a job wrote with the rows each one holds", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(seen, "job-output", { id: "j1" }, {}, written)
    expect(result.isError).toBe(false)
    const told = first(result)
    expect(told["job"]).toBe("j1")
    expect(told["state"]).toBe("queued")
    expect(told["progress"]).toEqual({ total: 1, done: 0, failed: 0, pending: 1 })
    expect(told["output"]).toEqual([{ path: SHEET, rows: 2 }])
    expect(told["error"]).toBeUndefined()
    expect(seen.calls).toEqual(["status:j1"])
  })

  it("reads the lines of one sheet a job wrote", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(
      seen,
      "job-output",
      { id: "j1", path: SHEET },
      {},
      written
    )
    expect(result.isError).toBe(false)
    expect(first(result)["sheet"]).toEqual({
      path: SHEET,
      rows: 2,
      returned: 2,
      lines: ['{"resourceType":"Patient","id":"p1"}', '{"resourceType":"Patient","id":"p2"}']
    })
  })

  it("reads at most the lines a caller asked for", async () => {
    const many = depotOf({
      [SHEET]: Array.from({ length: 5 }, (_one, at) => `line-${at}`)
    })
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(
      seen,
      "job-output",
      { id: "j1", path: SHEET, limit: 2 },
      {},
      many
    )
    expect(first(result)["sheet"]).toEqual({
      path: SHEET,
      rows: 5,
      returned: 2,
      lines: ["line-0", "line-1"]
    })
  })

  it("refuses a limit above the bound it serves", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(
      seen,
      "job-output",
      { id: "j1", path: SHEET, limit: 5000 },
      {},
      written
    )
    expect(result.isError).toBe(true)
    expect(first(result)["resourceType"]).toBe("OperationOutcome")
    expect(JSON.stringify(result.content)).toContain("limit")
  })

  it("refuses a path the job did not write", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const result = await answered(
      seen,
      "job-output",
      { id: "j1", path: "export/j1/Observation-0.ndjson" },
      {},
      written
    )
    expect(result.isError).toBe(true)
    expect(first(result)["resourceType"]).toBe("OperationOutcome")
    expect(JSON.stringify(result.content)).toContain("no sheet")
  })

  it("names the failure file a job wrote and keeps it out of the output", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const faulted = depotOf(
      { [SHEET]: ["{}"] },
      [{ job: "j1", unit: "u1", type: "Patient", id: "p9", line: 3, reason: "bad row" }]
    )
    const result = await answered(seen, "job-output", { id: "j1" }, {}, faulted)
    const told = first(result)
    expect(told["error"]).toBe("export/j1/error.ndjson")
    expect(told["output"]).toEqual([{ path: SHEET, rows: 1 }])
  })

  it("reads the failure file it named", async () => {
    const seen: Seen = { calls: [], notes: [] }
    const faulted = depotOf(
      { [SHEET]: ["{}"] },
      [{ job: "j1", unit: "u1", type: "Patient", id: "p9", line: 3, reason: "bad row" }]
    )
    const result = await answered(
      seen,
      "job-output",
      { id: "j1", path: "export/j1/error.ndjson" },
      {},
      faulted
    )
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain("bad row")
  })

  it("journals an output call like any other", async () => {
    const seen: Seen = { calls: [], notes: [] }
    await answered(seen, "job-output", { id: "j1" }, {}, written)
    expect(seen.notes.map((note) => [note.tool, note.outcome])).toEqual([
      ["job-output", "success"]
    ])
  })

  it("annotates an output read as read only", () => {
    const output = jobTools.find((tool) => tool.name === "job-output")
    expect(output?.annotations.destructiveHint).toBe(false)
    expect(output?.annotations.readOnlyHint).toBe(true)
    expect(output?.description).toContain("job-output")
    expect(output?.inputSchema.required).toEqual(["id"])
  })
})
