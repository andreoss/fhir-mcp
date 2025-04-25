import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PINNED_REVISION } from "../protocol/revision.js"
import { defaultEntry, ensure } from "./build.js"

export interface Spawned {
  readonly entry?: string
  readonly store?: string
  readonly write?: boolean
  readonly budget?: number
}

export interface Content {
  readonly type: string
  readonly text: string
}

export interface Refusal {
  readonly code: number
  readonly message: string
}

export interface Answer {
  readonly result: Record<string, unknown> | undefined
  readonly refused: Refusal | undefined
}

export type Called =
  | { readonly kind: "answered"; readonly isError: boolean; readonly body: unknown }
  | { readonly kind: "refused"; readonly code: number; readonly message: string }

export interface Listed {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations: Record<string, boolean>
}

export interface Session {
  readonly greeting: Record<string, unknown>
  readonly ask: (method: string, params?: unknown) => Promise<Answer>
  readonly listTools: () => Promise<ReadonlyArray<Listed>>
  readonly callTool: (name: string, args: unknown) => Promise<Called>
  readonly noise: () => ReadonlyArray<string>
  readonly notes: () => ReadonlyArray<Record<string, unknown>>
  readonly close: () => Promise<void>
}

const BUDGET = 20000

const FAREWELL = 2000

export const frame = (
  id: number | undefined,
  method: string,
  params?: unknown
): string =>
  `${JSON.stringify({
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    method,
    ...(params === undefined ? {} : { params })
  })}\n`

export const parsed = (line: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export const envOf = (
  store: string,
  write: boolean,
  base: Record<string, string | undefined>
): Record<string, string> => ({
  ...(base["PATH"] === undefined ? {} : { PATH: base["PATH"] }),
  ...(base["HOME"] === undefined ? {} : { HOME: base["HOME"] }),
  FHIR_TRANSPORT: "stdio",
  FHIR_STORE_PATH: store,
  FHIR_ALLOW_WRITE: write ? "true" : "false",
  FHIR_LOG_LEVEL: "error"
})

export const bodyOf = (content: ReadonlyArray<Content>): unknown => {
  const first = content[0]
  if (first === undefined) return undefined
  try {
    return JSON.parse(first.text)
  } catch {
    return first.text
  }
}

const ended = (child: ChildProcessWithoutNullStreams): Promise<void> =>
  new Promise((resolve) => {
    const done = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, FAREWELL)
    child.on("exit", () => {
      clearTimeout(done)
      resolve()
    })
    child.kill("SIGTERM")
  })

export const open = async (options: Spawned = {}): Promise<Session> => {
  const entry = await ensure({ entry: options.entry ?? defaultEntry() })
  const dir = options.store === undefined
    ? await mkdtemp(join(tmpdir(), "fhir-suite-"))
    : undefined
  const store = options.store ?? join(dir as string, "state.duckdb")
  const child = spawn(process.execPath, [entry], {
    env: envOf(store, options.write === true, process.env),
    stdio: ["pipe", "pipe", "pipe"]
  })
  const waiting = new Map<number, (answer: Answer) => void>()
  const noise: Array<string> = []
  const notes: Array<Record<string, unknown>> = []
  let rest = ""
  let next = 0
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    rest += chunk
    const lines = rest.split("\n")
    rest = lines.pop() ?? ""
    for (const line of lines) {
      if (line.trim().length === 0) continue
      const message = parsed(line)
      if (message === undefined) {
        noise.push(line)
        continue
      }
      const id = message["id"]
      const settle = typeof id === "number" ? waiting.get(id) : undefined
      if (settle === undefined) continue
      waiting.delete(id as number)
      settle({
        result: message["result"] as Record<string, unknown> | undefined,
        refused: message["error"] as Refusal | undefined
      })
    }
  })
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
    const lines = stderr.split("\n")
    stderr = lines.pop() ?? ""
    for (const line of lines) {
      const note = parsed(line)
      if (note !== undefined) notes.push(note)
    }
  })

  const budget = options.budget ?? BUDGET
  const ask = (method: string, params?: unknown): Promise<Answer> => {
    next += 1
    const id = next
    return new Promise<Answer>((resolve, reject) => {
      const late = setTimeout(() => {
        waiting.delete(id)
        reject(new Error(`no answer to ${method} within ${budget}ms`))
      }, budget)
      waiting.set(id, (answer) => {
        clearTimeout(late)
        resolve(answer)
      })
      child.stdin.write(frame(id, method, params))
    })
  }

  const tell = (method: string, params?: unknown): void => {
    child.stdin.write(frame(undefined, method, params))
  }

  const abandon = async (reason: string): Promise<never> => {
    child.kill("SIGKILL")
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    throw new Error(reason)
  }

  const greeted = await ask("initialize", {
    protocolVersion: PINNED_REVISION,
    capabilities: {},
    clientInfo: { name: "suite", version: "0" }
  }).catch((cause: unknown) => abandon(String((cause as Error).message)))
  if (greeted.result === undefined) {
    return abandon(`initialize refused: ${greeted.refused?.message ?? "no answer"}`)
  }
  tell("notifications/initialized")

  const listTools = async (): Promise<ReadonlyArray<Listed>> => {
    const tools: Array<Listed> = []
    let cursor: string | undefined
    do {
      const answer = await ask("tools/list", cursor === undefined ? undefined : { cursor })
      const page = (answer.result?.["tools"] ?? []) as ReadonlyArray<Listed>
      tools.push(...page)
      const after = answer.result?.["nextCursor"]
      cursor = typeof after === "string" ? after : undefined
    } while (cursor !== undefined)
    return tools
  }

  const callTool = async (name: string, args: unknown): Promise<Called> => {
    const answer = await ask("tools/call", { name, arguments: args })
    if (answer.result === undefined) {
      return {
        kind: "refused",
        code: answer.refused?.code ?? 0,
        message: answer.refused?.message ?? "no answer"
      }
    }
    return {
      kind: "answered",
      isError: answer.result["isError"] === true,
      body: bodyOf((answer.result["content"] ?? []) as ReadonlyArray<Content>)
    }
  }

  const close = async (): Promise<void> => {
    child.stdin.end()
    await ended(child)
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }

  return {
    greeting: greeted.result,
    ask,
    listTools,
    callTool,
    noise: () => noise,
    notes: () => notes,
    close
  }
}
