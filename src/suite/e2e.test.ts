import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PINNED_REVISION, capabilities } from "../protocol/revision.js"
import { defaultEntry, ensure } from "./build.js"
import { envOf, open } from "./harness.js"
import type { Listed, Session } from "./harness.js"

const patient = {
  resourceType: "Patient",
  id: "p1",
  name: [{ family: "Vance", given: ["Ada"] }],
  gender: "female",
  birthDate: "1962-04-02"
}

const named = (listed: ReadonlyArray<Listed>): ReadonlyArray<string> =>
  listed.map((tool) => tool.name)

const record = (called: unknown): Record<string, unknown> =>
  called as Record<string, unknown>

describe("a writable build driven over stdio", () => {
  let session: Session

  beforeAll(async () => {
    session = await open({ write: true })
  }, 120000)

  afterAll(async () => {
    await session.close()
  })

  it("answers the pinned revision and names itself at initialize", () => {
    expect(session.greeting["protocolVersion"]).toBe(PINNED_REVISION)
    expect(session.greeting["capabilities"]).toEqual(capabilities())
    expect(record(session.greeting["serverInfo"])["name"]).toBe("fhir-mcp")
  })

  it("lists the whole surface with schemas and truthful annotations", async () => {
    const listed = await session.listTools()
    expect(named(listed)).toEqual([
      "read",
      "search",
      "capabilities",
      "versions",
      "version",
      "job-submit",
      "job-status",
      "job-cancel",
      "job-output",
      "create",
      "update",
      "delete",
      "patch",
      "transaction",
      "batch"
    ])
    const read = listed.find((tool) => tool.name === "read")
    expect(read?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    })
    expect(record(read?.inputSchema)["required"]).toEqual(["type", "id"])
    const remove = listed.find((tool) => tool.name === "delete")
    expect(remove?.annotations["readOnlyHint"]).toBe(false)
    expect(remove?.annotations["destructiveHint"]).toBe(true)
  })

  it("reports the types and parameters the store actually serves", async () => {
    const called = await session.callTool("capabilities", { type: "Patient" })
    expect(called.kind).toBe("answered")
    if (called.kind !== "answered") return
    const body = record(called.body)
    expect(body["resourceTypes"]).toEqual([
      "Patient",
      "Observation",
      "Condition",
      "Encounter"
    ])
    expect(body["parameters"]).toContain("family")
  })

  it("creates, reads, searches, updates, patches and deletes one record", async () => {
    const created = await session.callTool("create", { type: "Patient", body: patient })
    expect(created.kind).toBe("answered")
    if (created.kind !== "answered") return
    expect(created.isError).toBe(false)
    expect(record(record(created.body)["meta"])["versionId"]).toBe("1")

    const found = await session.callTool("read", { type: "Patient", id: "p1" })
    if (found.kind !== "answered") throw new Error("read was refused")
    expect(found.body).toEqual(created.body)

    const searched = await session.callTool("search", {
      type: "Patient",
      parameters: { family: "Vance" }
    })
    if (searched.kind !== "answered") throw new Error("search was refused")
    const bundle = record(searched.body)
    expect(bundle["resourceType"]).toBe("Bundle")
    expect(bundle["total"]).toBe(1)
    const entries = bundle["entry"] as ReadonlyArray<Record<string, unknown>>
    expect(record(entries[0]?.["resource"])["id"]).toBe("p1")

    const updated = await session.callTool("update", {
      type: "Patient",
      id: "p1",
      body: { ...patient, gender: "other" }
    })
    if (updated.kind !== "answered") throw new Error("update was refused")
    expect(record(updated.body)["gender"]).toBe("other")
    expect(record(record(updated.body)["meta"])["versionId"]).toBe("2")

    const patched = await session.callTool("patch", {
      type: "Patient",
      id: "p1",
      patch: { kind: "json", ops: [{ op: "replace", path: "/gender", value: "male" }] }
    })
    if (patched.kind !== "answered") throw new Error("patch was refused")
    expect(record(patched.body)["gender"]).toBe("male")
    expect(record(record(patched.body)["meta"])["versionId"]).toBe("3")

    const removed = await session.callTool("delete", { type: "Patient", id: "p1" })
    if (removed.kind !== "answered") throw new Error("delete was refused")
    expect(record(removed.body)["mode"]).toBe("soft")
    expect(record(removed.body)["changed"]).toBe(true)

    const gone = await session.callTool("read", { type: "Patient", id: "p1" })
    if (gone.kind !== "answered") throw new Error("read was refused")
    expect(gone.isError).toBe(true)
    const outcome = record(gone.body)
    expect(outcome["resourceType"]).toBe("OperationOutcome")
    const issues = outcome["issue"] as ReadonlyArray<Record<string, unknown>>
    expect(issues[0]?.["code"]).toBe("deleted")

    const empty = await session.callTool("search", {
      type: "Patient",
      parameters: { family: "Vance" }
    })
    if (empty.kind !== "answered") throw new Error("search was refused")
    expect(record(empty.body)["total"]).toBe(0)
  })

  it("pages a larger result set through an opaque continuation token", async () => {
    for (const at of [1, 2, 3]) {
      const made = await session.callTool("create", {
        type: "Observation",
        body: {
          resourceType: "Observation",
          id: `o${at}`,
          status: "final",
          code: { coding: [{ code: "8867-4" }] }
        }
      })
      if (made.kind !== "answered" || made.isError) throw new Error("create was refused")
    }
    const first = await session.callTool("search", {
      type: "Observation",
      parameters: { status: "final" },
      max: 2
    })
    if (first.kind !== "answered") throw new Error("search was refused")
    const page = record(first.body)
    expect(page["total"]).toBe(3)
    const links = page["link"] as ReadonlyArray<Record<string, unknown>>
    const cursor = String(links[0]?.["url"])
    expect(cursor.length).toBeGreaterThan(0)
    const second = await session.callTool("search", {
      type: "Observation",
      parameters: { status: "final" },
      max: 2,
      cursor
    })
    if (second.kind !== "answered") throw new Error("search was refused")
    const rest = record(second.body)["entry"] as ReadonlyArray<Record<string, unknown>>
    expect(rest).toHaveLength(1)
    expect(record(rest[0]?.["resource"])["id"]).toBe("o3")
  })

  it("submits a job from the tool surface and polls it until it settles", async () => {
    const submitted = await session.callTool("job-submit", {
      kind: "reindex",
      request: '{"type":"Patient"}'
    })
    if (submitted.kind !== "answered" || submitted.isError) {
      throw new Error("job-submit was refused")
    }
    const ticket = record(submitted.body)
    const id = String(ticket["id"])
    expect(ticket["location"]).toBe(`/jobs/${id}`)
    expect(ticket["retryAfter"]).toBeGreaterThan(0)

    let state = ""
    for (let attempt = 0; attempt < 60 && state !== "done" && state !== "failed"; attempt++) {
      await new Promise((settled) => setTimeout(settled, 100))
      const polled = await session.callTool("job-status", { id })
      if (polled.kind !== "answered") throw new Error("job-status was refused")
      state = String(record(polled.body)["state"])
    }
    expect(state).toBe("done")

    const cancelled = await session.callTool("job-cancel", { id })
    if (cancelled.kind !== "answered") throw new Error("job-cancel was refused")
    expect(cancelled.isError).toBe(true)
    expect(record(cancelled.body)["resourceType"]).toBe("OperationOutcome")
  })

  it("answers a job it was never given as an outcome, not a crash", async () => {
    const called = await session.callTool("job-status", { id: "no-such-job" })
    if (called.kind !== "answered") throw new Error("job-status was refused")
    expect(called.isError).toBe(true)
    expect(record(called.body)["resourceType"]).toBe("OperationOutcome")
  })

  it("exports through a job and reads back the sheet it wrote", async () => {
    const submitted = await session.callTool("job-submit", {
      kind: "export",
      request: '{"scope":{"kind":"system"},"_type":["Observation"]}'
    })
    if (submitted.kind !== "answered" || submitted.isError) {
      throw new Error("job-submit was refused")
    }
    const id = String(record(submitted.body)["id"])
    let state = ""
    for (let attempt = 0; attempt < 60 && state !== "done" && state !== "failed"; attempt++) {
      await new Promise((settled) => setTimeout(settled, 100))
      const polled = await session.callTool("job-status", { id })
      if (polled.kind !== "answered") throw new Error("job-status was refused")
      state = String(record(polled.body)["state"])
    }
    expect(state).toBe("done")

    const reported = await session.callTool("job-output", { id })
    if (reported.kind !== "answered" || reported.isError) {
      throw new Error("job-output was refused")
    }
    const told = record(reported.body)
    expect(told["state"]).toBe("done")
    expect(told["error"]).toBeUndefined()
    const sheets = told["output"] as ReadonlyArray<Record<string, unknown>>
    expect(sheets.length).toBeGreaterThan(0)
    const path = String(sheets[0]?.["path"])
    expect(path).toBe(`export/${id}/Observation-0.ndjson`)
    expect(Number(sheets[0]?.["rows"])).toBe(3)

    const read = await session.callTool("job-output", { id, path })
    if (read.kind !== "answered" || read.isError) {
      throw new Error("job-output was refused")
    }
    const sheet = record(record(read.body)["sheet"])
    expect(sheet["path"]).toBe(path)
    expect(sheet["returned"]).toBe(3)
    const lines = sheet["lines"] as ReadonlyArray<string>
    const rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows.map((row) => row["id"]).sort()).toEqual(["o1", "o2", "o3"])
  })

  it("refuses to read a sheet the job never wrote", async () => {
    const called = await session.callTool("job-output", {
      id: "no-such-job",
      path: "export/no-such-job/Observation-0.ndjson"
    })
    if (called.kind !== "answered") throw new Error("job-output was refused")
    expect(called.isError).toBe(true)
    expect(record(called.body)["resourceType"]).toBe("OperationOutcome")
  })

  it("invokes an operation on a served resource by name", async () => {
    const made = await session.callTool("create", {
      type: "Patient",
      body: { resourceType: "Patient", id: "pe1" }
    })
    if (made.kind !== "answered" || made.isError) throw new Error("create was refused")
    const seen = await session.callTool("create", {
      type: "Condition",
      body: {
        resourceType: "Condition",
        id: "ce1",
        subject: { reference: "Patient/pe1" }
      }
    })
    if (seen.kind !== "answered" || seen.isError) throw new Error("create was refused")

    const called = await session.callTool("read", {
      type: "Patient",
      id: "pe1",
      operation: "$everything"
    })
    if (called.kind !== "answered") throw new Error("read was refused")
    expect(called.isError).toBe(false)
    const bundle = record(called.body)
    expect(bundle["resourceType"]).toBe("Bundle")
    expect(bundle["type"]).toBe("searchset")
    const entries = bundle["entry"] as ReadonlyArray<Record<string, unknown>>
    expect(entries.map((one) => record(one["resource"])["id"]).sort()).toEqual(["ce1", "pe1"])

    const narrowed = await session.callTool("read", {
      type: "Patient",
      id: "pe1",
      operation: "$everything",
      parameters: { _type: "Condition" }
    })
    if (narrowed.kind !== "answered") throw new Error("read was refused")
    const only = record(narrowed.body)["entry"] as ReadonlyArray<Record<string, unknown>>
    expect(only.map((one) => record(one["resource"])["id"])).toEqual(["ce1"])

    const absent = await session.callTool("read", {
      type: "Patient",
      id: "no-such-patient",
      operation: "$everything"
    })
    if (absent.kind !== "answered") throw new Error("read was refused")
    expect(absent.isError).toBe(true)
    expect(record(absent.body)["resourceType"]).toBe("OperationOutcome")
  })

  it("refuses an unknown tool as a protocol error, not as a result", async () => {
    const called = await session.callTool("explode", {})
    expect(called.kind).toBe("refused")
    if (called.kind !== "refused") return
    expect(called.message).toContain("explode")
  })

  it("answers a bad argument with an outcome rather than a protocol error", async () => {
    const called = await session.callTool("read", { type: "patient", id: "p1" })
    expect(called.kind).toBe("answered")
    if (called.kind !== "answered") return
    expect(called.isError).toBe(true)
    expect(record(called.body)["resourceType"]).toBe("OperationOutcome")
  })

  it("refuses a search parameter the type does not declare", async () => {
    const called = await session.callTool("search", {
      type: "Patient",
      parameters: { colour: "green" }
    })
    if (called.kind !== "answered") throw new Error("search was refused")
    expect(called.isError).toBe(true)
    const issues = record(called.body)["issue"] as ReadonlyArray<Record<string, unknown>>
    expect(String(issues[0]?.["diagnostics"])).toContain("colour")
  })

  it("applies a transaction and a batch through the served surface", async () => {
    const byron = (id: string) => ({
      resource: { resourceType: "Patient", id, name: [{ family: "Byron" }] },
      request: { method: "POST", url: "Patient" }
    })
    const empty = { request: { method: "POST", url: "Patient" } }

    const made = await session.callTool("transaction", {
      entry: [byron("b1"), byron("b2")]
    })
    if (made.kind !== "answered" || made.isError) throw new Error("transaction was refused")
    const sheaf = record(made.body)
    expect(sheaf["type"]).toBe("transaction-response")
    const done = sheaf["entry"] as ReadonlyArray<Record<string, unknown>>
    expect(done.map((one) => record(one["response"])["status"])).toEqual(["201", "201"])

    const found = await session.callTool("read", { type: "Patient", id: "b2" })
    if (found.kind !== "answered") throw new Error("read was refused")
    expect(record(found.body)["id"]).toBe("b2")

    const broken = await session.callTool("transaction", { entry: [byron("b3"), empty] })
    if (broken.kind !== "answered") throw new Error("transaction was refused")
    expect(broken.isError).toBe(true)

    const absent = await session.callTool("read", { type: "Patient", id: "b3" })
    if (absent.kind !== "answered") throw new Error("read was refused")
    expect(absent.isError).toBe(true)
    const why = record(absent.body)["issue"] as ReadonlyArray<Record<string, unknown>>
    expect(why[0]?.["code"]).toBe("not-found")

    const mixed = await session.callTool("batch", { entry: [byron("b4"), empty] })
    if (mixed.kind !== "answered" || mixed.isError) throw new Error("batch was refused")
    const batch = record(mixed.body)
    expect(batch["type"]).toBe("batch-response")
    const answered = batch["entry"] as ReadonlyArray<Record<string, unknown>>
    expect(answered.map((one) => record(one["response"])["status"])).toEqual(["201", "400"])
  })

  it("takes an xml document in and answers one back", async () => {
    const document =
      '<Patient xmlns="http://hl7.org/fhir"><id value="px1"/>' +
      '<name><family value="Lovelace"/></name>' +
      '<gender value="female"/></Patient>'
    const made = await session.callTool("create", {
      type: "Patient",
      body: document,
      format: "xml"
    })
    expect(made.kind).toBe("answered")
    if (made.kind !== "answered") return
    expect(made.isError).toBe(false)

    const xml = await session.callTool("read", {
      type: "Patient",
      id: "px1",
      format: "xml"
    })
    if (xml.kind !== "answered") throw new Error("read was refused")
    expect(String(xml.body).startsWith("<Patient")).toBe(true)
    expect(String(xml.body)).toContain('<family value="Lovelace"/>')

    const json = await session.callTool("read", { type: "Patient", id: "px1" })
    if (json.kind !== "answered") throw new Error("read was refused")
    expect(record(json.body)["gender"]).toBe("female")
  })

  it("serves the versions the build carries and the types each one has", async () => {
    const listed = await session.callTool("versions", {})
    if (listed.kind !== "answered") throw new Error("versions was refused")
    expect(record(listed.body)).toEqual({
      versions: ["4.0.1", "5.0.0"],
      default: "4.0.1"
    })

    const four = await session.callTool("version", { version: "4.0.1", type: "Encounter" })
    if (four.kind !== "answered") throw new Error("version was refused")
    expect(four.isError).toBe(false)
    expect(record(four.body)["version"]).toBe("4.0.1")

    const five = await session.callTool("version", { version: "5.0.0", type: "Procedure" })
    if (five.kind !== "answered") throw new Error("version was refused")
    expect(five.isError).toBe(false)
    const body = record(five.body)
    expect(body["elements"]).toContain("status")
    expect(body["parameters"]).toContain("status")

    const dropped = await session.callTool("version", { version: "5.0.0", type: "Encounter" })
    if (dropped.kind !== "answered") throw new Error("version was refused")
    expect(dropped.isError).toBe(true)
  })

  it("keeps the answer stream clean and journals every write beside it", () => {
    expect(session.noise()).toEqual([])
    const writes = session.notes().filter((note) => note["tool"] === "create")
    expect(writes.length).toBeGreaterThan(0)
    expect(writes[0]?.["outcome"]).toBe("success")
    expect(writes[0]?.["actor"]).toBe("anonymous")
    expect(JSON.stringify(session.notes())).not.toContain("Vance")
  })
})

describe("a read only build driven over stdio", () => {
  let session: Session

  beforeAll(async () => {
    session = await open({ write: false })
  }, 120000)

  afterAll(async () => {
    await session.close()
  })

  it("offers no write tool at all", async () => {
    expect(named(await session.listTools())).toEqual([
      "read",
      "search",
      "capabilities",
      "versions",
      "version"
    ])
  })

  it("refuses a write before it can reach the store", async () => {
    const called = await session.callTool("create", { type: "Patient", body: patient })
    expect(called.kind).toBe("refused")
    if (called.kind !== "refused") return
    expect(called.message).toContain("create")
  })
})

describe("an off the shelf client", () => {
  it("completes the lifecycle and calls a tool against the same build", async () => {
    const entry = await ensure({ entry: defaultEntry() })
    const dir = await mkdtemp(join(tmpdir(), "fhir-suite-sdk-"))
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: envOf(join(dir, "state.duckdb"), true, process.env),
      stderr: "pipe"
    })
    const client = new Client({ name: "suite", version: "0" }, { capabilities: {} })
    await client.connect(transport)
    expect(client.getServerVersion()?.name).toBe("fhir-mcp")
    expect(client.getServerCapabilities()).toEqual(capabilities())
    const paged: Array<string> = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor })
      paged.push(...page.tools.map((tool) => tool.name))
      cursor = page.nextCursor
    } while (cursor !== undefined)
    expect(paged).toContain("create")
    const called = await client.callTool({
      name: "create",
      arguments: { type: "Patient", body: patient }
    })
    expect(called.isError).toBe(false)
    await client.close()
    await rm(dir, { recursive: true, force: true })
  }, 120000)
})
