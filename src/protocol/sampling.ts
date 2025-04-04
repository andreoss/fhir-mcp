import type {
  CreateMessageRequest,
  CreateMessageResult
} from "@modelcontextprotocol/sdk/types.js"
import type { Workflow } from "./prompts.js"

export interface SamplingUse {
  readonly system: string
  readonly maxTokens: number
}

export type Outcome =
  | { readonly kind: "drafted"; readonly text: string; readonly model: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unavailable" }

export type Sampler = (
  params: CreateMessageRequest["params"]
) => Promise<CreateMessageResult>

export interface Brief {
  readonly role: "user" | "assistant"
  readonly content: { readonly type: "text"; readonly text: string }
}

const spoken = (args: Readonly<Record<string, string>>): string => {
  const at = [args["type"], args["id"]].filter((one) => one !== undefined).join("/")
  const focus = args["focus"]
  const bound = focus === undefined ? "" : ` Attend to ${focus}.`
  const held = at.length === 0 ? "the record" : at
  return `Draft a short brief of ${held} from the record it names.${bound} Say what the record does not say.`
}

export const asked = (
  workflow: Workflow,
  args: Readonly<Record<string, string>>
): CreateMessageRequest["params"] | undefined => {
  const use = workflow.sampling
  if (use === undefined) return undefined
  return {
    messages: [
      { role: "user", content: { type: "text", text: spoken(args) } }
    ],
    systemPrompt: use.system,
    maxTokens: use.maxTokens
  }
}

const said = (content: CreateMessageResult["content"]): string => {
  const part = content as { readonly type: string; readonly text?: string }
  return part.type === "text" ? (part.text ?? "") : ""
}

export const draft = async (
  workflow: Workflow,
  args: Readonly<Record<string, string>>,
  advertised: boolean,
  sample: Sampler
): Promise<Outcome> => {
  const params = asked(workflow, args)
  if (params === undefined || !advertised) return { kind: "unavailable" }
  try {
    const answer = await sample(params)
    return { kind: "drafted", text: said(answer.content), model: answer.model }
  } catch (cause) {
    return {
      kind: "refused",
      reason: cause instanceof Error ? cause.message : "the client did not answer"
    }
  }
}

export const briefed = (outcome: Outcome): Brief =>
  outcome.kind === "drafted"
    ? { role: "assistant", content: { type: "text", text: outcome.text } }
    : {
        role: "user",
        content: {
          type: "text",
          text:
            outcome.kind === "refused"
              ? `no model drafted this: the client refused to sample (${outcome.reason}).`
              : "no model drafted this: the client does not offer sampling."
        }
      }
