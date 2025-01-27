import { matches, repeats } from "../model/shape.js"
import type {
  Definition,
  Element,
  Elements,
  Primitive
} from "../model/shape.js"
import { EXTENSION, FHIR } from "./defs.js"
import { divText, textDiv } from "./narrative.js"
import { elem, fault, isFault } from "./tree.js"
import type { Attr, Elem, Fault, Limits, Node } from "./tree.js"

export type Find = (type: string) => Definition | undefined

interface Led {
  held: Fault | undefined
  readonly find: Find
  readonly limits: Limits
}

interface Mode {
  readonly root: boolean
  readonly ext: boolean
  readonly outer: boolean
}

const OUTER: Mode = { root: true, ext: false, outer: true }
const INNER: Mode = { root: true, ext: false, outer: false }
const NESTED: Mode = { root: false, ext: false, outer: false }
const EXT: Mode = { root: false, ext: true, outer: false }

const NONE: ReadonlySet<string> = new Set()
const ID: ReadonlySet<string> = new Set(["id"])
const ID_URL: ReadonlySet<string> = new Set(["id", "url"])
const SHADOW: ReadonlySet<string> = new Set([
  "id",
  "extension",
  "modifierExtension"
])

const INT = /^-?\d+$/
const DEC = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/

const carried = (mode: Mode): ReadonlySet<string> =>
  mode.root ? NONE : mode.ext ? ID_URL : ID

const stop = (led: Led, path: string, detail: string): undefined => {
  if (led.held === undefined) led.held = fault(path, detail)
  return undefined
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const at = (
  path: string,
  name: string,
  index: number,
  many: boolean
): string => (many ? `${path}.${name}[${index}]` : `${path}.${name}`)

const isExt = (name: string): boolean =>
  name === "extension" || name === "modifierExtension"

const narrative = (elements: Elements): boolean =>
  elements["div"] !== undefined && elements["status"] !== undefined

const cast = (
  kind: Primitive,
  raw: string,
  path: string,
  led: Led
): unknown => {
  if (kind === "boolean") {
    if (raw === "true") return true
    if (raw === "false") return false
    return stop(led, path, "expected boolean")
  }
  if (kind === "integer") {
    return INT.test(raw) ? Number(raw) : stop(led, path, "expected integer")
  }
  if (kind === "decimal") {
    return DEC.test(raw) ? Number(raw) : stop(led, path, "expected decimal")
  }
  return matches(kind, raw) ? raw : stop(led, path, `expected ${kind}`)
}

interface Held {
  readonly value: unknown
  readonly shadow: Record<string, unknown> | null
}

const primitive = (
  node: Elem,
  kind: Primitive,
  path: string,
  led: Led
): Held | undefined => {
  let raw: string | undefined
  const shadow: Record<string, unknown> = {}
  for (const [name, value] of node.attrs) {
    if (name === "value") {
      raw = value
      continue
    }
    if (name === "id") {
      shadow["id"] = value
      continue
    }
    return stop(led, path, `attribute "${name}" is not accepted`)
  }
  const found: Record<string, Array<Elem>> = {
    extension: [],
    modifierExtension: []
  }
  for (const kid of node.children) {
    if (kid.kind === "text") {
      if (kid.text.trim().length > 0) {
        return stop(led, path, "text content is not accepted")
      }
      continue
    }
    const bucket = found[kid.name]
    if (bucket === undefined) {
      return stop(led, `${path}.${kid.name}`, "element is not declared")
    }
    bucket.push(kid)
  }
  for (const [name, nodes] of Object.entries(found)) {
    if (nodes.length === 0) continue
    shadow[name] = nodes.map((held, index) =>
      object(held, EXTENSION, `${path}.${name}[${index}]`, EXT, led)
    )
  }
  if (led.held !== undefined) return undefined
  const bare = Object.keys(shadow).length === 0
  if (raw === undefined && bare) {
    return stop(led, path, "an element must carry a value or an extension")
  }
  const value = raw === undefined ? null : cast(kind, raw, path, led)
  if (led.held !== undefined) return undefined
  return { value, shadow: bare ? null : shadow }
}

const contained = (
  node: Elem,
  path: string,
  led: Led
): Record<string, unknown> | undefined => {
  const first = node.attrs[0]
  if (first !== undefined) {
    return stop(led, path, `attribute "${first[0]}" is not accepted`)
  }
  const kids: Array<Elem> = []
  for (const kid of node.children) {
    if (kid.kind === "elem") kids.push(kid)
    else if (kid.text.trim().length > 0) {
      return stop(led, path, "text content is not accepted")
    }
  }
  const only = kids[0]
  if (only === undefined || kids.length !== 1) {
    return stop(led, path, "expected one resource element")
  }
  return resource(only, path, false, led)
}

const place = (
  out: Record<string, unknown>,
  name: string,
  element: Element,
  nodes: ReadonlyArray<Elem>,
  path: string,
  elements: Elements,
  led: Led
): void => {
  const many = repeats(element.card)
  if (element.kind === "group" || element.kind === "open") {
    const kids = nodes.map((node, index) => {
      const spot = at(path, name, index, many)
      if (element.kind === "group") {
        return object(node, element.children, spot, NESTED, led)
      }
      return isExt(name)
        ? object(node, EXTENSION, spot, EXT, led)
        : contained(node, spot, led)
    })
    if (led.held !== undefined) return
    out[name] = many ? kids : kids[0]
    return
  }
  const first = nodes[0]
  if (name === "div" && narrative(elements) && first !== undefined) {
    const held = divText(first, `${path}.${name}`)
    if (isFault(held)) {
      led.held = led.held ?? held
      return
    }
    out[name] = held
    return
  }
  const values: Array<unknown> = []
  const shadows: Array<Record<string, unknown> | null> = []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node === undefined) continue
    const held = primitive(node, element.kind, at(path, name, index, many), led)
    if (held === undefined) return
    values.push(held.value)
    shadows.push(held.shadow)
  }
  if (values.some((value) => value !== null)) {
    out[name] = many ? values : values[0]
  }
  if (shadows.some((shadow) => shadow !== null)) {
    out[`_${name}`] = many ? shadows : shadows[0]
  }
}

const object = (
  node: Elem,
  elements: Elements,
  path: string,
  mode: Mode,
  led: Led
): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {}
  const attrs = carried(mode)
  for (const [name, value] of node.attrs) {
    if (name === "xmlns" && mode.outer) continue
    const element = elements[name]
    const usable = element !== undefined &&
      element.kind !== "group" &&
      element.kind !== "open"
    if (!attrs.has(name) || !usable) {
      return stop(led, path, `attribute "${name}" is not accepted`)
    }
    out[name] = cast(element.kind as Primitive, value, `${path}.${name}`, led)
    if (led.held !== undefined) return undefined
  }
  if (mode.ext && out["url"] === undefined) {
    return stop(led, `${path}.url`, "required element is absent")
  }
  const names = Object.keys(elements)
  const runs: Array<{ readonly name: string; readonly nodes: Array<Elem> }> = []
  let cursor = -1
  for (const kid of node.children) {
    if (kid.kind === "text") {
      if (kid.text.trim().length > 0) {
        return stop(led, path, "text content is not accepted")
      }
      continue
    }
    const index = names.indexOf(kid.name)
    if (index < 0) {
      return stop(led, `${path}.${kid.name}`, "element is not declared")
    }
    if (attrs.has(kid.name)) {
      return stop(
        led,
        `${path}.${kid.name}`,
        `${kid.name} is carried as an attribute`
      )
    }
    const last = runs[runs.length - 1]
    if (last !== undefined && last.name === kid.name) {
      last.nodes.push(kid)
      continue
    }
    if (index <= cursor) {
      return stop(led, `${path}.${kid.name}`, "elements are out of order")
    }
    cursor = index
    runs.push({ name: kid.name, nodes: [kid] })
  }
  for (const run of runs) {
    const element = elements[run.name]
    if (element === undefined) continue
    if (!repeats(element.card) && run.nodes.length > 1) {
      return stop(led, `${path}.${run.name}`, "element does not repeat")
    }
    place(out, run.name, element, run.nodes, path, elements, led)
    if (led.held !== undefined) return undefined
  }
  return out
}

const resource = (
  node: Elem,
  path: string,
  outer: boolean,
  led: Led
): Record<string, unknown> | undefined => {
  const named = node.attrs.some(
    ([name, value]) => name === "xmlns" && value === FHIR
  )
  if (outer && !named) return stop(led, path, "expected the fhir namespace")
  const definition = led.find(node.name)
  if (definition === undefined) {
    return stop(led, path, `unknown resource type ${node.name}`)
  }
  const spot = outer ? definition.type : path
  const mode = outer ? OUTER : INNER
  const held = object(node, definition.elements, spot, mode, led)
  return held === undefined
    ? undefined
    : { resourceType: definition.type, ...held }
}

export const toObject = (
  node: Elem,
  find: Find,
  limits: Limits
): Record<string, unknown> | Fault => {
  const led: Led = { held: undefined, find, limits }
  const held = resource(node, "document", true, led)
  return led.held ?? held ?? fault("document", "expected a resource object")
}

const written = (
  value: unknown,
  kind: Primitive,
  path: string,
  led: Led
): string | undefined => {
  if (!matches(kind, value)) return stop(led, path, `expected ${kind}`)
  return typeof value === "string" ? value : String(value)
}

const listed = (
  value: unknown,
  many: boolean,
  path: string,
  led: Led
): Array<unknown> | undefined => {
  if (many) {
    return Array.isArray(value)
      ? [...value]
      : stop(led, path, "expected an array")
  }
  return Array.isArray(value)
    ? stop(led, path, "expected a single value")
    : [value]
}

const leafNode = (
  kind: Primitive,
  value: unknown,
  shadow: unknown,
  name: string,
  spot: string,
  shade: string,
  depth: number,
  led: Led
): Elem | undefined => {
  const attrs: Array<Attr> = []
  const children: Array<Node> = []
  if (shadow !== undefined && shadow !== null) {
    if (!isObject(shadow)) return stop(led, shade, "expected an object")
    for (const key of Object.keys(shadow)) {
      if (SHADOW.has(key)) continue
      return stop(led, `${shade}.${key}`, "element is not declared")
    }
    const id = shadow["id"]
    if (id !== undefined) {
      const raw = written(id, "string", `${shade}.id`, led)
      if (raw === undefined) return undefined
      attrs.push(["id", raw])
    }
    for (const key of ["extension", "modifierExtension"]) {
      const held = shadow[key]
      if (held === undefined) continue
      if (!Array.isArray(held)) {
        return stop(led, `${shade}.${key}`, "expected an array")
      }
      for (let index = 0; index < held.length; index += 1) {
        const made = groupNode(
          held[index],
          EXTENSION,
          key,
          `${shade}.${key}[${index}]`,
          EXT,
          depth + 1,
          led
        )
        if (made === undefined) return undefined
        children.push(made)
      }
    }
  }
  if (value !== undefined && value !== null) {
    const raw = written(value, kind, spot, led)
    if (raw === undefined) return undefined
    attrs.push(["value", raw])
  } else if (attrs.length === 0 && children.length === 0) {
    return stop(led, spot, "an element must carry a value or an extension")
  }
  return elem(name, attrs, children)
}

const branch = (
  name: string,
  element: Element,
  held: unknown,
  shade: unknown,
  path: string,
  elements: Elements,
  depth: number,
  led: Led
): Array<Node> | undefined => {
  const many = repeats(element.card)
  const made: Array<Node> = []
  if (element.kind === "group" || element.kind === "open") {
    const items = listed(held, many, `${path}.${name}`, led)
    if (items === undefined) return undefined
    for (let index = 0; index < items.length; index += 1) {
      const spot = at(path, name, index, many)
      const item = items[index]
      const node = element.kind === "group"
        ? groupNode(item, element.children, name, spot, NESTED, depth + 1, led)
        : isExt(name)
          ? groupNode(item, EXTENSION, name, spot, EXT, depth + 1, led)
          : containerNode(item, name, spot, depth + 1, led)
      if (node === undefined) return undefined
      made.push(node)
    }
    return made
  }
  if (name === "div" && narrative(elements)) {
    const node = textDiv(held, `${path}.${name}`, led.limits)
    if (isFault(node)) {
      led.held = led.held ?? node
      return undefined
    }
    return [node]
  }
  const values = held === undefined
    ? []
    : listed(held, many, `${path}.${name}`, led)
  if (values === undefined) return undefined
  const shadows = shade === undefined
    ? []
    : listed(shade, many, `${path}._${name}`, led)
  if (shadows === undefined) return undefined
  const count = Math.max(values.length, shadows.length)
  for (let index = 0; index < count; index += 1) {
    const shade1 = many
      ? `${path}._${name}[${index}]`
      : `${path}._${name}`
    const node = leafNode(
      element.kind,
      values[index],
      shadows[index],
      name,
      at(path, name, index, many),
      shade1,
      depth,
      led
    )
    if (node === undefined) return undefined
    made.push(node)
  }
  return made
}

const groupNode = (
  value: unknown,
  elements: Elements,
  name: string,
  path: string,
  mode: Mode,
  depth: number,
  led: Led
): Elem | undefined => {
  if (depth > led.limits.depth) {
    return stop(led, path, `nesting deeper than ${led.limits.depth} elements`)
  }
  if (!isObject(value)) return stop(led, path, "expected an object")
  const attrs: Array<Attr> = []
  if (mode.outer) attrs.push(["xmlns", FHIR])
  const holds = carried(mode)
  for (const key of holds) {
    const element = elements[key]
    const held = value[key]
    if (element === undefined || held === undefined) continue
    if (element.kind === "group" || element.kind === "open") continue
    const raw = written(held, element.kind, `${path}.${key}`, led)
    if (raw === undefined) return undefined
    attrs.push([key, raw])
  }
  if (mode.ext && value["url"] === undefined) {
    return stop(led, `${path}.url`, "required element is absent")
  }
  for (const key of Object.keys(value)) {
    if (mode.root && key === "resourceType") continue
    if (elements[key] !== undefined) continue
    const shadowed = key.startsWith("_") ? elements[key.slice(1)] : undefined
    if (
      shadowed !== undefined &&
      shadowed.kind !== "group" &&
      shadowed.kind !== "open"
    ) {
      continue
    }
    return stop(led, `${path}.${key}`, "element is not declared")
  }
  const children: Array<Node> = []
  for (const [key, element] of Object.entries(elements)) {
    if (holds.has(key)) continue
    const held = value[key]
    const shade = value[`_${key}`]
    if (held === undefined && shade === undefined) continue
    const made = branch(key, element, held, shade, path, elements, depth, led)
    if (made === undefined) return undefined
    children.push(...made)
  }
  return elem(name, attrs, children)
}

const containerNode = (
  value: unknown,
  name: string,
  path: string,
  depth: number,
  led: Led
): Elem | undefined => {
  const inner = resourceNode(value, path, false, depth, led)
  return inner === undefined ? undefined : elem(name, [], [inner])
}

const resourceNode = (
  value: unknown,
  path: string,
  outer: boolean,
  depth: number,
  led: Led
): Elem | undefined => {
  if (!isObject(value)) return stop(led, path, "expected a resource object")
  const type = value["resourceType"]
  if (typeof type !== "string") {
    return stop(led, path, "expected a resource type")
  }
  const definition = led.find(type)
  if (definition === undefined) {
    return stop(led, path, `unknown resource type ${type}`)
  }
  return groupNode(
    value,
    definition.elements,
    definition.type,
    outer ? definition.type : path,
    outer ? OUTER : INNER,
    depth,
    led
  )
}

export const toTree = (
  value: unknown,
  find: Find,
  limits: Limits
): Elem | Fault => {
  const led: Led = { held: undefined, find, limits }
  const node = resourceNode(value, "document", true, 0, led)
  return led.held ?? node ?? fault("document", "expected a resource object")
}
