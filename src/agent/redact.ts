import { ParseResult } from "effect"

const ACTUAL = /, actual [\s\S]*$/

const NOISE = new Set(["Expected undefined", "Expected never"])

export const clean = (message: string): string => message.replace(ACTUAL, "").trim()

export const reasons = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((problem) => ({ path: problem.path.join("."), message: clean(problem.message) }))
    .filter((problem) => !NOISE.has(problem.message))
    .map((problem) =>
      problem.path.length > 0 ? `${problem.path}: ${problem.message}` : problem.message
    )
    .join("; ")
