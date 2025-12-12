import { Effect } from "effect"
import type { FhirResource } from "../core/engine.js"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { parse, serialize } from "../format/xml.js"

export type Representation = "json" | "xml"

export const REPRESENTATIONS: ReadonlyArray<Representation> = ["json", "xml"]

export interface Block {
  readonly type: "text"
  readonly text: string
}

export const written = (
  value: unknown,
  representation: Representation
): Effect.Effect<string, Failure> =>
  representation === "json" ? Effect.succeed(JSON.stringify(value)) : serialize(value)

export const asResource = (
  body: unknown,
  representation: Representation
): Effect.Effect<FhirResource, Failure> =>
  Effect.suspend(() =>
    representation === "xml"
      ? typeof body === "string"
        ? parse(body)
        : Effect.fail(
            new Rejected({ reason: "body: expected an xml document when format is xml" })
          )
      : typeof body === "string"
        ? Effect.fail(
            new Rejected({ reason: "body: format json takes a resource object" })
          )
        : Effect.succeed(body as FhirResource)
  )
