import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { writeText } from "../tools/io.js"
import { collect, exportsOf, importsOf, survey } from "./gaps.js"
import type { Source } from "./gaps.js"

const DIR = fileURLToPath(new URL("record/", import.meta.url))

const ENTRY = /(cli|index).ts$/

const sources: ReadonlyArray<Source> = [
  {
    path: "a/one.ts",
    text:
      'import { two } from "../b/two.js"\n' +
      'export const one = () => two()\nexport const spare = () => 1\n'
  },
  {
    path: "a/one.test.ts",
    text: 'import { one } from "./one.js"\nimport { two } from "../b/two.js"\none()\ntwo()\n'
  },
  { path: "b/two.ts", text: "export const two = (): number => 2\n" },
  { path: "c/three.ts", text: "export function three(): number {\n  return 3\n}\n" }
]

const reasons = (paths: ReadonlyArray<string>) => new Set(paths)

describe("what a module offers", () => {
  it("names the values a module exports", () => {
    const text = 'export const a = 1\nexport function b() {}\nexport class C {}\n'
    expect(exportsOf(text)).toEqual(["a", "b", "C"])
  })

  it("leaves out the types, which carry no path to run", () => {
    const text =
      "export type A = string\nexport interface B { a: string }\n" + "export const c = 1\n"
    expect(exportsOf(text)).toEqual(["c"])
  })

  it("takes an export the line wraps or annotates", () => {
    const text = "export const a: number =\n  1\nexport async function b() {}\n"
    expect(exportsOf(text)).toEqual(["a", "b"])
  })
})

describe("what a module reaches", () => {
  it("resolves a relative import back to its source", () => {
    expect(importsOf("a/one.ts", 'import { x } from "../b/two.js"')).toEqual(["b/two.ts"])
  })

  it("resolves a re-export the same way", () => {
    expect(importsOf("a/one.ts", 'export { x } from "./two.js"')).toEqual(["a/two.ts"])
  })

  it("ignores a package that is not part of this tree", () => {
    expect(importsOf("a/one.ts", 'import { Effect } from "effect"')).toEqual([])
  })

  it("takes a type-only import as a reach as well", () => {
    expect(importsOf("a/one.ts", 'import type { X } from "./two.js"')).toEqual(["a/two.ts"])
  })
})

describe("the survey of a tree", () => {
  it("separates modules with a unit test from those without", () => {
    const found = survey(sources)
    expect(found.tested).toEqual(["a/one.ts"])
    expect(found.untested).toEqual(["b/two.ts", "c/three.ts"])
    expect(found.modules).toEqual(["a/one.ts", "b/two.ts", "c/three.ts"])
  })

  it("names a module no test reaches at any tier", () => {
    const found = survey(sources)
    const unreached = found.gaps.filter((gap) => gap.reason === "unreached")
    expect(reasons(unreached.map((gap) => gap.path))).toEqual(new Set(["c/three.ts"]))
  })

  it("names an export that is reached but never called out by a test", () => {
    const found = survey(sources)
    const unnamed = found.gaps.filter((gap) => gap.reason === "unnamed")
    expect(unnamed.map((gap) => `${gap.path}#${gap.name ?? ""}`)).toEqual(["a/one.ts#spare"])
  })

  it("blames an unreached module once, not once per export", () => {
    const found = survey(sources)
    expect(found.gaps.filter((gap) => gap.path === "c/three.ts")).toHaveLength(1)
  })

  it("does not blame a module whose exports a test names", () => {
    const found = survey(sources)
    expect(found.gaps.map((gap) => gap.path)).not.toContain("b/two.ts")
  })

  it("counts what it looked at", () => {
    const found = survey(sources)
    expect(found.tests).toBe(1)
  })
})

describe("the survey of this tree", () => {
  it("reads every source under the root it is given", async () => {
    const found = await Effect.runPromise(collect("src/suite"))
    expect(found.map((source) => source.path)).toContain("src/suite/gaps.ts")
    expect(found.map((source) => source.path)).toContain("src/suite/gaps.test.ts")
    expect(found.every((source) => source.text.length > 0)).toBe(true)
  })

  it("reports nothing for a root that holds no source", async () => {
    const found = await Effect.runPromise(collect("src/suite/record"))
    expect(found).toEqual([])
  })
})

describe("the survey of the source tree", () => {
  it("names every path no test reaches at any tier", async () => {
    const found = survey(await Effect.runPromise(collect("src")))
    expect(found.modules.length).toBeGreaterThan(80)
    expect(found.tests).toBeGreaterThan(60)
    expect(found.tested.length + found.untested.length).toBe(found.modules.length)
    await Effect.runPromise(
      writeText(join(DIR, "gaps.json"), `${JSON.stringify(found, undefined, 2)}\n`)
    )
    const unreached = found.gaps
      .filter((gap) => gap.reason === "unreached")
      .map((gap) => gap.path)
    expect(unreached).toContain("src/tools/cli.ts")
    expect(unreached.filter((path) => !ENTRY.test(path))).toEqual([])
  })
})

describe("a root that is not there", () => {
  it("says which root it could not survey", async () => {
    const exit = await Effect.runPromiseExit(collect("src/suite/nowhere"))
    expect(exit._tag).toBe("Failure")
  })
})
