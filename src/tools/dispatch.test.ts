import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { USAGE, dispatch, runTools, writers } from "./dispatch.js"

interface Recorded {
  readonly out: Array<string>
  readonly err: Array<string>
}

const recorder = (): Recorded & { readonly out: Array<string> } => ({ out: [], err: [] })

const io = (recorded: Recorded) => ({
  out: (line: string) => recorded.out.push(line),
  err: (line: string) => recorded.err.push(line)
})

describe("dispatch", () => {
  it("runs a command and writes its report", async () => {
    const recorded = recorder()
    const status = await runTools(["migrate", "version"], {}, io(recorded))
    expect(status).toBe(0)
    expect(JSON.parse(recorded.out[0] ?? "")).toMatchObject({ action: "version" })
    expect(recorded.err).toEqual([])
  })

  it("names every command it carries", () => {
    for (const command of ["migrate", "data", "bench", "scaffold", "health"]) {
      expect(USAGE.join("\n")).toContain(command)
    }
  })

  it("shows what it takes when nothing is asked of it", async () => {
    const recorded = recorder()
    expect(await runTools([], {}, io(recorded))).toBe(1)
    expect(recorded.err.join("\n")).toContain("usage")
  })

  it("shows what it takes when asked for help", async () => {
    const recorded = recorder()
    expect(await runTools(["--help"], {}, io(recorded))).toBe(0)
    expect(recorded.out.join("\n")).toContain("usage")
  })

  it("refuses a command it does not carry", async () => {
    const recorded = recorder()
    expect(await runTools(["deploy"], {}, io(recorded))).toBe(1)
    expect(recorded.err.join("\n")).toContain("unknown command: deploy")
    expect(recorded.err.join("\n")).toContain("usage")
  })

  it("explains a refused argument list", async () => {
    const recorded = recorder()
    expect(await runTools(["migrate", "sideways"], {}, io(recorded))).toBe(1)
    expect(recorded.err.join("\n")).toContain("arguments rejected")
  })

  it("explains a refused destructive run", async () => {
    const recorded = recorder()
    expect(await runTools(["data", "rebuild"], {}, io(recorded))).toBe(1)
    expect(recorded.err.join("\n")).toContain("--force")
  })

  it("explains a store that could not answer", async () => {
    const recorded = recorder()
    const status = await runTools(["data", "import", "--in", "absent.ndjson"], {}, io(recorded))
    expect(status).toBe(1)
    expect(recorded.err.join("\n")).toContain("absent.ndjson")
  })

  it("carries a failing status out of a command", async () => {
    const recorded = recorder()
    const status = await Effect.runPromise(
      dispatch(["health"], { FHIR_TRANSPORT: "carrier-pigeon" }, io(recorded))
    )
    expect(status).toBe(1)
    expect(JSON.parse(recorded.out[0] ?? "")).toMatchObject({ status: "failing" })
  })

  it("writes to the standard streams by default", async () => {
    const lines: Array<string> = []
    const stdout = process.stdout.write
    const stderr = process.stderr.write
    process.stdout.write = ((chunk: string) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      writers.out("first")
      writers.err("second")
    } finally {
      process.stdout.write = stdout
      process.stderr.write = stderr
    }
    expect(lines).toEqual(["first\n", "second\n"])
  })
})
