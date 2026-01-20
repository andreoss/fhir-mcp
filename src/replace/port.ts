import { Context, Effect } from "effect"
import type { Scope } from "effect"
import type { Failure } from "../core/outcome.js"
import type { Incumbent } from "./incumbent.js"

export type Opening = (path: string) => Effect.Effect<Incumbent, Failure, Scope.Scope>

export class Incumbency extends Context.Tag("Incumbency")<Incumbency, Opening>() {}
