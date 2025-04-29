import { Data, Effect } from "effect"

export class Refused extends Data.TaggedError("Refused")<{
  readonly action: string
}> {
  override get message(): string {
    return `refusing to ${this.action} without --force`
  }
}

export const guard = (
  destructive: boolean,
  force: boolean,
  action: string
): Effect.Effect<void, Refused> =>
  destructive && !force ? Effect.fail(new Refused({ action })) : Effect.void
