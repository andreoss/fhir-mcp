import { Effect } from "effect"
import { readFile, readdir } from "node:fs/promises"
import { posix } from "node:path"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

export interface Source {
  readonly path: string
  readonly text: string
}

export interface Gap {
  readonly path: string
  readonly reason: "unreached" | "unnamed"
  readonly name?: string
}

export interface Survey {
  readonly modules: ReadonlyArray<string>
  readonly tests: number
  readonly tested: ReadonlyArray<string>
  readonly untested: ReadonlyArray<string>
  readonly gaps: ReadonlyArray<Gap>
}

const VALUE = /^export\s+(?:async\s+)?(?:const|function|class)\s+([A-Za-z_$][\w$]*)/gm

const SPECIFIER = /(?:^|[\s;}])(?:import|export)[\s\S]*?from\s+"(\.[^"]*)"/gm

const WORD = /[A-Za-z_$][\w$]*/g

const isTest = (path: string): boolean => path.endsWith(".test.ts")

export const exportsOf = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(VALUE)].map((found) => found[1] as string)

export const importsOf = (path: string, text: string): ReadonlyArray<string> =>
  [...text.matchAll(SPECIFIER)].map((found) =>
    posix.normalize(
      posix.join(posix.dirname(path), (found[1] as string).replace(/\.js$/, ".ts"))
    )
  )

export const survey = (sources: ReadonlyArray<Source>): Survey => {
  const byPath = new Map(sources.map((source) => [source.path, source]))
  const modules = sources.map((source) => source.path).filter((path) => !isTest(path)).sort()
  const tests = sources.filter((source) => isTest(source.path))
  const reached = new Set<string>()
  const front = tests.flatMap((source) => importsOf(source.path, source.text))
  while (front.length > 0) {
    const path = front.pop() as string
    if (reached.has(path)) continue
    reached.add(path)
    const source = byPath.get(path)
    if (source !== undefined) front.push(...importsOf(path, source.text))
  }
  const spoken = new Set(
    tests.flatMap((source) => [...source.text.matchAll(WORD)].map((found) => found[0]))
  )
  const tested = modules.filter((path) => byPath.has(path.replace(/\.ts$/, ".test.ts")))
  const untested = modules.filter((path) => !byPath.has(path.replace(/\.ts$/, ".test.ts")))
  const gaps = modules.flatMap((path): ReadonlyArray<Gap> => {
    if (!reached.has(path)) return [{ path, reason: "unreached" }]
    const source = byPath.get(path)
    if (source === undefined) return []
    return exportsOf(source.text)
      .filter((name) => !spoken.has(name))
      .map((name): Gap => ({ path, reason: "unnamed", name }))
  })
  return { modules, tests: tests.length, tested, untested, gaps }
}

const walk = async (root: string): Promise<ReadonlyArray<Source>> => {
  const found: Array<Source> = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const path = posix.join(root, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await walk(path)))
      continue
    }
    if (!entry.name.endsWith(".ts")) continue
    found.push({ path, text: await readFile(path, "utf8") })
  }
  return found
}

export const collect = (root: string): Effect.Effect<ReadonlyArray<Source>, Failure> =>
  Effect.tryPromise({
    try: () => walk(root),
    catch: () => new Rejected({ reason: `cannot survey ${root}` })
  })
