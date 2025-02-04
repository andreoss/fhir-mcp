import { Effect, Either } from "effect"
import { Rejected } from "../core/outcome.js"
import type { Failure } from "../core/outcome.js"
import { el, group, open } from "../model/shape.js"
import type {
  Card,
  Definition,
  Element,
  Elements,
  Primitive
} from "../model/shape.js"

export interface SpecType {
  readonly code: string
}

export interface SpecElement {
  readonly path: string
  readonly min: number
  readonly max: string
  readonly type?: ReadonlyArray<SpecType>
}

export interface Snapshot {
  readonly element: ReadonlyArray<SpecElement>
}

export interface Structure {
  readonly resourceType: "StructureDefinition"
  readonly kind: "resource" | "complex-type"
  readonly type: string
  readonly snapshot: Snapshot
}

export type Models = Readonly<Record<string, Definition>>

const PRIMITIVES: Readonly<Record<string, Primitive>> = {
  base64Binary: "string",
  boolean: "boolean",
  canonical: "uri",
  code: "code",
  date: "date",
  dateTime: "dateTime",
  decimal: "decimal",
  id: "id",
  instant: "instant",
  integer: "integer",
  integer64: "integer",
  markdown: "string",
  oid: "uri",
  positiveInt: "integer",
  string: "string",
  time: "string",
  unsignedInt: "integer",
  uri: "uri",
  url: "uri",
  uuid: "uri",
  xhtml: "string"
}

const OPENED: ReadonlySet<string> = new Set([
  "Any",
  "DomainResource",
  "Extension",
  "Resource"
])

const NESTED: ReadonlySet<string> = new Set(["BackboneElement", "Element"])

interface Node {
  readonly spec: SpecElement
  readonly children: Map<string, Node>
}

interface Ctx {
  readonly index: ReadonlyMap<string, Structure>
  readonly seen: ReadonlySet<string>
}

const card = (min: number, max: string): Card => {
  const many = max === "*" || Number(max) > 1
  if (min > 0) return many ? "1..*" : "1..1"
  return many ? "0..*" : "0..1"
}

const titled = (code: string): string =>
  code.charAt(0).toUpperCase() + code.slice(1)

const insert = (
  root: Map<string, Node>,
  parts: ReadonlyArray<string>,
  spec: SpecElement
): boolean => {
  let level = root
  const last = parts.length - 1
  for (let at = 0; at < last; at += 1) {
    const held = level.get(parts[at] as string)
    if (held === undefined) return false
    level = held.children
  }
  level.set(parts[last] as string, { spec, children: new Map() })
  return true
}

const rooted = (
  structure: Structure
): Either.Either<Map<string, Node>, string> => {
  const root = new Map<string, Node>()
  for (const spec of structure.snapshot.element) {
    const parts = spec.path.split(".")
    if (parts[0] !== structure.type) {
      return Either.left(`${spec.path}: not an element of ${structure.type}`)
    }
    if (parts.length === 1) continue
    if (!insert(root, parts.slice(1), spec)) {
      return Either.left(`${spec.path}: parent is not declared`)
    }
  }
  return Either.right(root)
}

const children = (
  nodes: ReadonlyMap<string, Node>,
  ctx: Ctx
): Either.Either<Elements, string> => {
  const out: Record<string, Element> = {}
  for (const [name, node] of nodes) {
    const made = fragment(name, node, ctx)
    if (Either.isLeft(made)) return made
    Object.assign(out, made.right)
  }
  return Either.right(out)
}

const borrowed = (
  code: string,
  path: string,
  ctx: Ctx
): Either.Either<Elements, string> => {
  const held = ctx.index.get(code)
  if (held === undefined) {
    return Either.left(`${path}: unknown type ${code}`)
  }
  const deeper = { index: ctx.index, seen: new Set([...ctx.seen, code]) }
  return Either.flatMap(rooted(held), (nodes) => children(nodes, deeper))
}

const one = (
  code: string,
  held: Card,
  node: Node,
  ctx: Ctx
): Either.Either<Element, string> => {
  const primitive = PRIMITIVES[code]
  if (primitive !== undefined) return Either.right(el(primitive, held))
  if (OPENED.has(code)) return Either.right(open(held))
  if (NESTED.has(code)) {
    return Either.map(children(node.children, ctx), (kids) => group(kids, held))
  }
  if (ctx.seen.has(code)) return Either.right(open(held))
  return Either.map(borrowed(code, node.spec.path, ctx), (kids) =>
    group(kids, held)
  )
}

const chosen = (
  name: string,
  node: Node,
  ctx: Ctx,
  types: ReadonlyArray<SpecType>
): Either.Either<Elements, string> => {
  const stem = name.slice(0, -3)
  const held = card(0, node.spec.max)
  const out: Record<string, Element> = {}
  for (const { code } of types) {
    const made = one(code, held, node, ctx)
    if (Either.isLeft(made)) return Either.left(made.left)
    out[`${stem}${titled(code)}`] = made.right
  }
  return Either.right(out)
}

const fragment = (
  name: string,
  node: Node,
  ctx: Ctx
): Either.Either<Elements, string> => {
  const { max, min, path, type } = node.spec
  if (max === "0") return Either.right({})
  const types = type ?? []
  if (name.endsWith("[x]")) {
    if (types.length === 0) return Either.left(`${path}: names no type`)
    return chosen(name, node, ctx, types)
  }
  if (types.length === 0) {
    if (node.children.size === 0) return Either.left(`${path}: names no type`)
    return Either.map(children(node.children, ctx), (kids) => ({
      [name]: group(kids, card(min, max))
    }))
  }
  const only = types.length === 1 ? types[0] : undefined
  if (only === undefined) {
    return Either.left(`${path}: names more than one type`)
  }
  return Either.map(one(only.code, card(min, max), node, ctx), (made) => ({
    [name]: made
  }))
}

const emitOne = (
  structure: Structure,
  index: ReadonlyMap<string, Structure>
): Either.Either<Definition, string> =>
  Either.map(
    Either.flatMap(rooted(structure), (nodes) =>
      children(nodes, { index, seen: new Set([structure.type]) })
    ),
    (elements) => ({ type: structure.type, elements })
  )

export const emit = (
  input: ReadonlyArray<Structure>
): Either.Either<Models, string> => {
  const index = new Map(input.map((held) => [held.type, held] as const))
  const wanted = input
    .filter((held) => held.kind === "resource")
    .sort((left, right) => (left.type < right.type ? -1 : 1))
  const out: Record<string, Definition> = {}
  for (const structure of wanted) {
    const made = emitOne(structure, index)
    if (Either.isLeft(made)) return Either.left(made.left)
    out[structure.type] = made.right
  }
  return Either.right(out)
}

export const generate = (
  input: ReadonlyArray<Structure>
): Effect.Effect<Models, Failure> =>
  Either.match(emit(input), {
    onLeft: (reason) => Effect.fail<Failure>(new Rejected({ reason })),
    onRight: (made) => Effect.succeed(made)
  })
