import type { ToolSpec } from "../agent/tools.js"
import type { SamplingUse } from "./sampling.js"

export interface PromptArgument {
  readonly name: string
  readonly description: string
  readonly required?: boolean
  readonly domain?: "types" | "tools"
}

export interface PromptUse {
  readonly tool: string
  readonly arguments: ReadonlyArray<string>
}

export interface Workflow {
  readonly name: string
  readonly description: string
  readonly arguments: ReadonlyArray<PromptArgument>
  readonly uses: ReadonlyArray<PromptUse>
  readonly script: ReadonlyArray<string>
  readonly sampling?: SamplingUse
}

export const workflows: ReadonlyArray<Workflow> = [
  {
    name: "chart-review-v1",
    description: "Review one record and recent findings before a care decision.",
    arguments: [
      {
        name: "type",
        description: "Resource type name of the record.",
        required: true,
        domain: "types"
      },
      { name: "id", description: "Logical id of the record.", required: true },
      { name: "max", description: "Largest number of entries to fetch." }
    ],
    uses: [
      { tool: "read", arguments: ["type", "id"] },
      { tool: "search", arguments: ["type", "max"] }
    ],
    script: [
      "chart-review-v1 step 1: call the read tool with type and id to fetch the record.",
      "chart-review-v1 step 2: call the search tool with type and max, bounded, to gather findings.",
      "chart-review-v1 step 3: restate the record id and version, list what supports the decision and what remains unknown."
    ]
  },
  {
    name: "note-summary-v1",
    description: "Draft a summary note of one record.",
    arguments: [
      {
        name: "type",
        description: "Resource type name of the record.",
        required: true,
        domain: "types"
      },
      { name: "id", description: "Logical id of the record.", required: true }
    ],
    uses: [{ tool: "summarize", arguments: ["type", "id"] }],
    script: [
      "note-summary-v1: call the summarize tool with type and id to draft the note.",
      "note-summary-v1: keep the summary to the record and name which model drafted it."
    ]
  },
  {
    name: "record-brief-v1",
    description: "Draft a short brief of one record with the client's model.",
    arguments: [
      {
        name: "type",
        description: "Resource type name of the record.",
        required: true,
        domain: "types"
      },
      { name: "id", description: "Logical id of the record.", required: true },
      { name: "focus", description: "What the brief should attend to." }
    ],
    uses: [{ tool: "read", arguments: ["type", "id"] }],
    sampling: {
      system:
        "Draft clinical briefs from records only. State what the record does not say rather than guessing it.",
      maxTokens: 512
    },
    script: [
      "record-brief-v1 step 1: call the read tool with type and id to fetch the record.",
      "record-brief-v1 step 2: ask the client's model for a short brief of the record.",
      "record-brief-v1 step 3: say which sentences the model drafted and which the record carries."
    ]
  },
  {
    name: "medication-check-v1",
    description: "Check a person's active medications for interactions before prescribing.",
    arguments: [
      { name: "id", description: "Logical id of the person.", required: true },
      {
        name: "type",
        description: "Resource type name of the person.",
        required: true,
        domain: "types"
      }
    ],
    uses: [
      { tool: "read", arguments: ["type", "id"] },
      { tool: "search", arguments: ["type", "parameters"] }
    ],
    script: [
      "medication-check-v1 step 1: call the read tool with type and id for the person.",
      "medication-check-v1 step 2: call the search tool with type and the medication parameters, bounded.",
      "medication-check-v1 step 3: list the medications and check them for interactions."
    ]
  }
]

export interface Violation {
  readonly prompt: string
  readonly reason: string
}

export const validate = (
  offered: ReadonlyArray<ToolSpec>,
  prompts: ReadonlyArray<Workflow> = workflows
): ReadonlyArray<Violation> => {
  const byName = new Map(offered.map((tool) => [tool.name, tool]))
  const flaws: Violation[] = []
  for (const prompt of prompts) {
    for (const use of prompt.uses) {
      const tool = byName.get(use.tool)
      if (tool === undefined) {
        flaws.push({ prompt: prompt.name, reason: `tool not served: ${use.tool}` })
        continue
      }
      const known = new Set(Object.keys(tool.inputSchema.properties))
      for (const argument of use.arguments) {
        if (!known.has(argument)) {
          flaws.push({ prompt: prompt.name, reason: `argument not on ${use.tool}: ${argument}` })
        }
      }
    }
  }
  return flaws
}

export interface Rendered {
  readonly role: "user"
  readonly content: { readonly type: "text"; readonly text: string }
}

export interface Asked {
  readonly name: string
  readonly args: Readonly<Record<string, string>>
}

export const render = (
  asked: Asked,
  prompts: ReadonlyArray<Workflow> = workflows
): ReadonlyArray<Rendered> | undefined => {
  const found = prompts.find((prompt) => prompt.name === asked.name)
  if (found === undefined) return undefined
  const missing = found.arguments.some((a) => a.required === true && asked.args[a.name] === undefined)
  if (missing) return undefined
  const note =
    Object.keys(asked.args).length === 0 ? "" : `\nArguments: ${JSON.stringify(asked.args)}`
  return found.script.map((text) => ({
    role: "user" as const,
    content: { type: "text" as const, text: text + note }
  }))
}

export interface CompletionAsk {
  readonly name: string
  readonly argument: string
  readonly value: string
  readonly tools: ReadonlyArray<string>
  readonly types: ReadonlyArray<string>
}

export const completeArgument = (
  asked: CompletionAsk,
  prompts: ReadonlyArray<Workflow> = workflows
): ReadonlyArray<string> => {
  const prompt = prompts.find((one) => one.name === asked.name)
  if (prompt === undefined) return []
  const argument = prompt.arguments.find((one) => one.name === asked.argument)
  if (argument?.domain === "types") return asked.types.filter((one) => one.startsWith(asked.value))
  if (argument?.domain === "tools") return asked.tools.filter((one) => one.startsWith(asked.value))
  return []
}