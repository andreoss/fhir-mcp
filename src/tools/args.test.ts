import { describe, expect, it } from "vitest"
import { Effect, Exit, Schema } from "effect"
import { ArgsError, Count, Flag, Ratio, Whole, oneOf, parse } from "./args.js"

const spec = {
  verbs: ["version", "next", "latest"] as const,
  flags: ["force", "dryRun"] as const,
  fields: {
    store: Schema.optional(Schema.String),
    shape: Schema.optionalWith(oneOf("patient", "mixed"), {
      default: () => "patient" as const
    }),
    size: Schema.optionalWith(Count, { default: () => 10 }),
    force: Flag,
    dryRun: Flag
  }
}

const run = (argv: ReadonlyArray<string>) => Effect.runSyncExit(parse(spec, argv))

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected success")
}

const problems = <A>(exit: Exit.Exit<A, ArgsError>): ReadonlyArray<string> => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error.problems
  throw new Error("expected failure")
}

describe("args", () => {
  it("reads a verb and its options", () => {
    const parsed = value(run(["next", "--store", "state.duckdb", "--size", "5"]))
    expect(parsed.verb).toBe("next")
    expect(parsed.options.store).toBe("state.duckdb")
    expect(parsed.options.size).toBe(5)
    expect(parsed.options.force).toBe(false)
  })

  it("applies defaults for options left out", () => {
    const parsed = value(run(["version"]))
    expect(parsed.options.size).toBe(10)
    expect(parsed.options.shape).toBe("patient")
    expect(parsed.options.store).toBeUndefined()
  })

  it("accepts an option joined by an equals sign", () => {
    const parsed = value(run(["next", "--store=state.duckdb"]))
    expect(parsed.options.store).toBe("state.duckdb")
  })

  it("treats a bare toggle as on", () => {
    const parsed = value(run(["next", "--force"]))
    expect(parsed.options.force).toBe(true)
  })

  it("accepts a toggle given a value", () => {
    expect(value(run(["next", "--force=false"])).options.force).toBe(false)
    expect(value(run(["next", "--force=true"])).options.force).toBe(true)
  })

  it("maps a dashed option onto its field", () => {
    expect(value(run(["next", "--dry-run"])).options.dryRun).toBe(true)
  })

  it("names the accepted verbs when none is given", () => {
    const found = problems(run([]))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain("version")
    expect(found[0]).toContain("latest")
  })

  it("names the accepted verbs when one is unknown", () => {
    const found = problems(run(["upgrade"]))
    expect(found[0]).toContain("upgrade")
    expect(found[0]).toContain("next")
  })

  it("names the known options when one is unknown", () => {
    const found = problems(run(["next", "--nope", "x"]))
    expect(found[0]).toContain("--nope")
    expect(found[0]).toContain("--store")
  })

  it("refuses a camel spelling of a dashed option", () => {
    expect(problems(run(["next", "--dryRun"]))[0]).toContain("--dryRun")
  })

  it("refuses an option left without a value", () => {
    expect(problems(run(["next", "--store"]))[0]).toContain("--store")
    expect(problems(run(["next", "--store"]))[0]).toContain("value")
  })

  it("refuses an option given twice", () => {
    const found = problems(run(["next", "--store", "a", "--store", "b"]))
    expect(found[0]).toContain("--store")
    expect(found[0]).toContain("twice")
  })

  it("refuses a stray argument", () => {
    expect(problems(run(["next", "leftover"]))[0]).toContain("leftover")
  })

  it("refuses a number that is not a number", () => {
    const found = problems(run(["next", "--size", "many"]))
    expect(found[0]).toContain("--size")
    expect(found[0]).toContain("whole number")
  })

  it("refuses a choice outside the accepted set", () => {
    const found = problems(run(["next", "--shape", "cube"]))
    expect(found[0]).toContain("--shape")
    expect(found[0]).toContain("patient")
  })

  it("reports every problem at once", () => {
    expect(problems(run(["next", "--size", "many", "--shape", "cube"]))).toHaveLength(2)
  })

  it("reads with no verbs declared", () => {
    const parsed = value(
      Effect.runSyncExit(
        parse({ flags: [], fields: { store: Schema.optional(Schema.String) } }, [
          "--store",
          "a"
        ])
      )
    )
    expect(parsed.verb).toBe("")
    expect(parsed.options.store).toBe("a")
  })

  it("states that arguments were rejected", () => {
    const error = new ArgsError({ problems: ["--size: expected a positive whole number"] })
    expect(error.message).toContain("arguments rejected")
    expect(error.message).toContain("--size")
  })
})

describe("numbers", () => {
  const numbers = {
    flags: [] as ReadonlyArray<string>,
    fields: {
      seed: Schema.optionalWith(Whole, { default: () => 0 }),
      tolerance: Schema.optionalWith(Ratio, { default: () => 0.1 })
    }
  }

  const read = (argv: ReadonlyArray<string>) => Effect.runSyncExit(parse(numbers, argv))

  it("accepts zero for a whole number", () => {
    expect(value(read(["--seed", "0"])).options.seed).toBe(0)
  })

  it("refuses a negative whole number", () => {
    const found = problems(read(["--seed", "-1"]))
    expect(found[0]).toContain("--seed")
    expect(found[0]).toContain("whole number")
  })

  it("accepts a fractional ratio", () => {
    expect(value(read(["--tolerance", "0.25"])).options.tolerance).toBe(0.25)
  })

  it("refuses a ratio above one", () => {
    expect(problems(read(["--tolerance", "2"]))[0]).toContain("ratio")
  })

  it("applies ratio and seed defaults", () => {
    const parsed = value(read([]))
    expect(parsed.options.seed).toBe(0)
    expect(parsed.options.tolerance).toBe(0.1)
  })
})
