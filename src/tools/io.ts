import { Effect } from "effect"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"

const failing = (what: string, path: string) => (): Failure =>
  new Rejected({ reason: `cannot ${what} ${path}` })

export const readText = (path: string): Effect.Effect<string, Failure> =>
  Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: failing("read", path) })

export const writeText = (path: string, body: string): Effect.Effect<void, Failure> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body, "utf8")
    },
    catch: failing("write", path)
  })

export const exists = (path: string): Effect.Effect<boolean, Failure> =>
  Effect.tryPromise({
    try: () => stat(path).then(() => true, () => false),
    catch: failing("reach", path)
  })

export const listNames = (dir: string): Effect.Effect<ReadonlyArray<string>, Failure> =>
  Effect.tryPromise({
    try: () => readdir(dir).then((names) => [...names].sort(), () => [] as Array<string>),
    catch: failing("list", dir)
  })
