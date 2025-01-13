import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { tools } from "../agent/tools.js"
import { Audit } from "./audit.js"
import type { Event } from "./audit.js"
import type { Denial } from "./failure.js"
import { status } from "./failure.js"
import { action, listed, permit } from "./guard.js"
import type { Call } from "./guard.js"
import { grant } from "./scope.js"

const surface = [
  { name: "read" },
  { name: "search" },
  { name: "create" },
  { name: "export" },
  { name: "bulk-delete" },
  { name: "search-parameter" }
]

const trailed = () => {
  const seen: Array<Event> = []
  return {
    seen,
    layer: Layer.succeed(Audit, { write: (entry: Event) => { seen.push(entry) } })
  }
}

const call = (extra: Partial<Call> & Pick<Call, "tool" | "type">): Call => ({
  correlation: "c1",
  ...extra
})

const run = (scopes: ReadonlyArray<string>, made: Call) => {
  const trail = trailed()
  const exit = Effect.runSyncExit(Effect.provide(permit(grant(scopes), made), trail.layer))
  return { exit, seen: trail.seen }
}

const denial = <A>(exit: Exit.Exit<A, Denial>): Denial => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected a refusal")
}

describe("tool boundary, MCPA-07", () => {
  it("maps every tool of the surface to a data action", () => {
    expect(action("read")).toBe("read")
    expect(action("search")).toBe("read")
    expect(action("create")).toBe("write")
    expect(action("export")).toBe("export")
    expect(action("bulk-delete")).toBe("bulk-delete")
    expect(action("search-parameter")).toBe("parameter-management")
    expect(action("invented")).toBeUndefined()
  })

  it("does not list a tool the grant does not cover", () => {
    const shown = listed(surface, grant(["user/Patient.read"])).map((tool) => tool.name)
    expect(shown).toEqual(["read", "search"])
    expect(shown).not.toContain("create")
    expect(shown).not.toContain("export")
  })

  it("does not let a tool the grant does not cover be called", () => {
    const refused = run(["user/Patient.read"], call({ tool: "create", type: "Patient" }))
    expect(status(denial(refused.exit))).toBe(403)
    expect(denial(refused.exit)._tag).toBe("Forbidden")
  })

  it("both lists and permits a tool the grant covers", () => {
    const shown = listed(surface, grant(["system/*.export"])).map((tool) => tool.name)
    expect(shown).toContain("export")
    const allowed = run(["system/*.export"], call({ tool: "export", type: "Patient", kind: "system" }))
    expect(Exit.isSuccess(allowed.exit)).toBe(true)
  })

  it("lists nothing at all when nothing was granted", () => {
    expect(listed(surface, grant([]))).toHaveLength(0)
  })

  it("lists the tools the agent surface actually serves", () => {
    const shown = listed(tools, grant(["user/Patient.read"])).map((tool) => tool.name)
    expect(shown).toEqual(["read", "search", "capabilities"])
    expect(listed(tools, grant(["user/Patient.write"]))).toHaveLength(0)
  })

  it("refuses a tool name the surface does not serve", () => {
    const refused = run(["system/*.*"], call({ tool: "invented", type: "Patient" }))
    expect(status(denial(refused.exit))).toBe(400)
    expect(refused.seen).toHaveLength(0)
  })

  it("checks the compartment and the search parameters at the boundary", () => {
    const scopes = ["patient:p1/Observation.read?category"]
    const inside = run(scopes, call({
      tool: "search",
      type: "Observation",
      kind: "patient",
      compartment: "p1",
      parameters: ["category"]
    }))
    expect(Exit.isSuccess(inside.exit)).toBe(true)
    const outside = run(scopes, call({
      tool: "search",
      type: "Observation",
      kind: "patient",
      compartment: "p2",
      parameters: ["category"]
    }))
    expect(status(denial(outside.exit))).toBe(403)
    const other = run(scopes, call({
      tool: "search",
      type: "Observation",
      kind: "patient",
      compartment: "p1",
      parameters: ["subject"]
    }))
    expect(status(denial(other.exit))).toBe(403)
  })
})

describe("tool boundary audit, SEC-06", () => {
  it("records the read it permitted", () => {
    const allowed = run(["user/Patient.read"], call({ tool: "read", type: "Patient", id: "p1", token: "bearer" }))
    expect(Exit.isSuccess(allowed.exit)).toBe(true)
    expect(allowed.seen).toHaveLength(1)
    expect(allowed.seen[0]?.action).toBe("read")
    expect(allowed.seen[0]?.resource).toBe("Patient/p1")
    expect(allowed.seen[0]?.outcome).toBe("success")
    expect(allowed.seen[0]?.actor).not.toBe("anonymous")
    expect(JSON.stringify(allowed.seen)).not.toContain("bearer")
  })

  it("records the write it refused", () => {
    const refused = run(["user/Patient.read"], call({ tool: "create", type: "Patient", token: "bearer" }))
    expect(refused.seen).toHaveLength(1)
    expect(refused.seen[0]?.action).toBe("write")
    expect(refused.seen[0]?.outcome).toBe("refused")
    expect(refused.seen[0]?.resource).toBe("Patient")
  })
})
