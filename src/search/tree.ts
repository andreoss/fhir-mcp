export type Prefix = "eq" | "ne" | "gt" | "lt" | "ge" | "le" | "sa" | "eb" | "ap"

export type ValueType =
  | "number"
  | "date"
  | "string"
  | "token"
  | "quantity"
  | "reference"
  | "composite"
  | "uri"

export type Modifier =
  | "missing"
  | "exact"
  | "contains"
  | "not"
  | "text"
  | "in"
  | "not-in"
  | "below"
  | "above"
  | "type"
  | "identifier"
  | "of-type"

export type Precision = "year" | "month" | "day" | "minute" | "second" | "instant"

export interface Component {
  readonly name: string
  readonly valueType: ValueType
}

export interface NumberValue {
  readonly kind: "number"
  readonly prefix: Prefix
  readonly value: number
  readonly text: string
}

export interface DateValue {
  readonly kind: "date"
  readonly prefix: Prefix
  readonly precision: Precision
  readonly start: string
  readonly end: string
  readonly text: string
}

export interface StringValue {
  readonly kind: "string"
  readonly text: string
}

export interface TokenValue {
  readonly kind: "token"
  readonly system: string | undefined
  readonly code: string | undefined
  readonly anySystem: boolean
  readonly text: string
}

export interface OfTypeValue {
  readonly kind: "of-type"
  readonly system: string
  readonly code: string
  readonly value: string
  readonly text: string
}

export interface QuantityValue {
  readonly kind: "quantity"
  readonly prefix: Prefix
  readonly value: number
  readonly system: string | undefined
  readonly code: string | undefined
  readonly text: string
}

export type Ref =
  | { readonly form: "id"; readonly id: string }
  | { readonly form: "typed"; readonly type: string; readonly id: string }
  | { readonly form: "url"; readonly url: string }
  | {
      readonly form: "identifier"
      readonly system: string | undefined
      readonly code: string | undefined
      readonly anySystem: boolean
    }

export interface ReferenceValue {
  readonly kind: "reference"
  readonly ref: Ref
  readonly text: string
}

export interface UriValue {
  readonly kind: "uri"
  readonly value: string
  readonly text: string
}

export interface CompositeValue {
  readonly kind: "composite"
  readonly parts: ReadonlyArray<Value>
  readonly text: string
}

export type Value =
  | NumberValue
  | DateValue
  | StringValue
  | TokenValue
  | OfTypeValue
  | QuantityValue
  | ReferenceValue
  | UriValue
  | CompositeValue

export interface Compare {
  readonly kind: "compare"
  readonly type: string
  readonly param: string
  readonly valueType: ValueType
  readonly modifier: Modifier | undefined
  readonly target: string | undefined
  readonly value: Value
}

export interface Missing {
  readonly kind: "missing"
  readonly type: string
  readonly param: string
  readonly present: boolean
}

export interface Chain {
  readonly kind: "chain"
  readonly type: string
  readonly param: string
  readonly target: string
  readonly next: Expr
}

export interface Has {
  readonly kind: "has"
  readonly type: string
  readonly source: string
  readonly ref: string
  readonly next: Expr
}

export interface And {
  readonly kind: "and"
  readonly terms: ReadonlyArray<Expr>
}

export interface Or {
  readonly kind: "or"
  readonly terms: ReadonlyArray<Expr>
}

export type Expr = And | Or | Compare | Missing | Chain | Has

export const KINDS = ["and", "or", "compare", "missing", "chain", "has"] as const

export interface Visitor<A> {
  readonly and: (terms: ReadonlyArray<A>, node: And) => A
  readonly or: (terms: ReadonlyArray<A>, node: Or) => A
  readonly compare: (node: Compare) => A
  readonly missing: (node: Missing) => A
  readonly chain: (next: A, node: Chain) => A
  readonly has: (next: A, node: Has) => A
}

export const fold = <A>(expr: Expr, visitor: Visitor<A>): A => {
  switch (expr.kind) {
    case "and":
      return visitor.and(expr.terms.map((term) => fold(term, visitor)), expr)
    case "or":
      return visitor.or(expr.terms.map((term) => fold(term, visitor)), expr)
    case "compare":
      return visitor.compare(expr)
    case "missing":
      return visitor.missing(expr)
    case "chain":
      return visitor.chain(fold(expr.next, visitor), expr)
    case "has":
      return visitor.has(fold(expr.next, visitor), expr)
  }
}

export const every = (terms: ReadonlyArray<Expr>): Expr | undefined => {
  const [first, ...rest] = terms
  if (first === undefined) return undefined
  return rest.length === 0 ? first : { kind: "and", terms }
}

export const some = (terms: ReadonlyArray<Expr>): Expr | undefined => {
  const [first, ...rest] = terms
  if (first === undefined) return undefined
  return rest.length === 0 ? first : { kind: "or", terms }
}
