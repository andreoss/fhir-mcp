export interface Fault {
  readonly fault: true
  readonly path: string
  readonly detail: string
}

export type Attr = readonly [string, string]

export interface Elem {
  readonly kind: "elem"
  readonly name: string
  readonly attrs: ReadonlyArray<Attr>
  readonly children: ReadonlyArray<Node>
}

export interface Text {
  readonly kind: "text"
  readonly text: string
}

export type Node = Elem | Text

export interface Limits {
  readonly depth: number
  readonly nodes: number
  readonly length: number
}

export const LIMITS: Limits = {
  depth: 64,
  nodes: 50000,
  length: 8000000
}

export const fault = (path: string, detail: string): Fault => ({
  fault: true,
  path,
  detail
})

export const isFault = (value: unknown): value is Fault =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly fault?: unknown }).fault === true

export const render = (held: Fault): string => `${held.path}: ${held.detail}`

export const elem = (
  name: string,
  attrs: ReadonlyArray<Attr>,
  children: ReadonlyArray<Node>
): Elem => ({ kind: "elem", name, attrs, children })

export const text = (value: string): Text => ({ kind: "text", text: value })

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: "\"",
  apos: "'"
}

const NUMERIC = /^#(\d+|[xX][0-9a-fA-F]+)$/
const WS = /\s/
const START = /[A-Za-z_]/
const PART = /[-A-Za-z0-9_.:]/

const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const escAttr = (value: string): string =>
  esc(value).replace(/"/g, "&quot;")

export const write = (node: Node): string => {
  if (node.kind === "text") return esc(node.text)
  const attrs = node.attrs
    .map(([name, value]) => ` ${name}="${escAttr(value)}"`)
    .join("")
  if (node.children.length === 0) return `<${node.name}${attrs}/>`
  const inner = node.children.map(write).join("")
  return `<${node.name}${attrs}>${inner}</${node.name}>`
}

interface Cur {
  readonly text: string
  at: number
  nodes: number
  held: Fault | undefined
  readonly path: Array<string>
  readonly limits: Limits
}

const where = (cur: Cur): string => {
  if (cur.path.length === 0) return "document"
  if (cur.path.length <= 8) return cur.path.join(".")
  return `${cur.path.slice(0, 8).join(".")}...`
}

const stop = (cur: Cur, detail: string): undefined => {
  if (cur.held === undefined) cur.held = fault(where(cur), detail)
  return undefined
}

const ahead = (cur: Cur, what: string): boolean =>
  cur.text.startsWith(what, cur.at)

const space = (cur: Cur): void => {
  while (cur.at < cur.text.length && WS.test(cur.text.charAt(cur.at))) {
    cur.at += 1
  }
}

const ident = (cur: Cur): string | undefined => {
  const from = cur.at
  if (!START.test(cur.text.charAt(cur.at))) {
    return stop(cur, "expected an element name")
  }
  cur.at += 1
  while (cur.at < cur.text.length && PART.test(cur.text.charAt(cur.at))) {
    cur.at += 1
  }
  return cur.text.slice(from, cur.at)
}

const comment = (cur: Cur): boolean => {
  const end = cur.text.indexOf("-->", cur.at + 4)
  if (end < 0) {
    stop(cur, "a comment is not closed")
    return false
  }
  cur.at = end + 3
  return true
}

const forbidden = (cur: Cur): boolean => {
  if (ahead(cur, "<!DOCTYPE") || ahead(cur, "<!doctype")) {
    stop(cur, "a document type declaration is not accepted")
    return true
  }
  if (ahead(cur, "<!ENTITY") || ahead(cur, "<!entity")) {
    stop(cur, "an entity declaration is not accepted")
    return true
  }
  if (ahead(cur, "<![CDATA[")) {
    stop(cur, "a marked section is not accepted")
    return true
  }
  if (ahead(cur, "<!")) {
    stop(cur, "a declaration is not accepted")
    return true
  }
  if (ahead(cur, "<?")) {
    stop(cur, "a processing instruction is not accepted")
    return true
  }
  return false
}

const trivia = (cur: Cur): boolean => {
  space(cur)
  while (ahead(cur, "<!--")) {
    if (!comment(cur)) return false
    space(cur)
  }
  return true
}

const unescape = (raw: string, cur: Cur): string | undefined => {
  if (!raw.includes("&")) return raw
  let out = ""
  let at = 0
  while (at < raw.length) {
    const ch = raw.charAt(at)
    if (ch !== "&") {
      out += ch
      at += 1
      continue
    }
    const end = raw.indexOf(";", at)
    if (end < 0) return stop(cur, "an entity reference is not closed")
    const body = raw.slice(at + 1, end)
    if (body.startsWith("#")) {
      if (!NUMERIC.test(body)) {
        return stop(cur, `unknown entity reference &${body};`)
      }
      const code = body.charAt(1).toLowerCase() === "x"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (code < 1 || code > 0x10ffff) {
        return stop(cur, `unknown entity reference &${body};`)
      }
      out += String.fromCodePoint(code)
      at = end + 1
      continue
    }
    const known = ENTITIES[body]
    if (known === undefined) {
      return stop(cur, `unknown entity reference &${body};`)
    }
    out += known
    at = end + 1
  }
  return out
}

const attributes = (cur: Cur): Array<Attr> | undefined => {
  const found: Array<Attr> = []
  const seen = new Set<string>()
  for (;;) {
    space(cur)
    if (ahead(cur, "/>") || ahead(cur, ">")) return found
    if (cur.at >= cur.text.length) return found
    const name = ident(cur)
    if (name === undefined) return undefined
    space(cur)
    if (!ahead(cur, "=")) return stop(cur, `expected "=" after ${name}`)
    cur.at += 1
    space(cur)
    const quote = cur.text.charAt(cur.at)
    if (quote !== "\"" && quote !== "'") {
      return stop(cur, `expected a quoted value for ${name}`)
    }
    cur.at += 1
    const end = cur.text.indexOf(quote, cur.at)
    if (end < 0) return stop(cur, `the value of ${name} is not closed`)
    const raw = cur.text.slice(cur.at, end)
    cur.at = end + 1
    const value = unescape(raw, cur)
    if (value === undefined) return undefined
    if (seen.has(name)) return stop(cur, `duplicate attribute ${name}`)
    seen.add(name)
    found.push([name, value])
  }
}

const content = (cur: Cur, name: string): Array<Node> | undefined => {
  const found: Array<Node> = []
  for (;;) {
    if (cur.at >= cur.text.length) return stop(cur, `<${name}> is not closed`)
    if (ahead(cur, "</")) {
      cur.at += 2
      const end = ident(cur)
      if (end === undefined) return undefined
      space(cur)
      if (!ahead(cur, ">")) return stop(cur, `expected ">" in </${end}>`)
      cur.at += 1
      if (end !== name) return stop(cur, `</${end}> does not close <${name}>`)
      return found
    }
    if (ahead(cur, "<!--")) {
      if (!comment(cur)) return undefined
      continue
    }
    if (forbidden(cur)) return undefined
    if (ahead(cur, "<")) {
      const kid = element(cur)
      if (kid === undefined) return undefined
      found.push(kid)
      continue
    }
    const next = cur.text.indexOf("<", cur.at)
    const upto = next < 0 ? cur.text.length : next
    const raw = cur.text.slice(cur.at, upto)
    cur.at = upto
    const value = unescape(raw, cur)
    if (value === undefined) return undefined
    found.push(text(value))
  }
}

const element = (cur: Cur): Elem | undefined => {
  cur.at += 1
  const name = ident(cur)
  if (name === undefined) return undefined
  cur.path.push(name)
  if (cur.path.length > cur.limits.depth) {
    return stop(cur, `nesting deeper than ${cur.limits.depth} elements`)
  }
  cur.nodes += 1
  if (cur.nodes > cur.limits.nodes) {
    cur.path.length = 0
    return stop(cur, `more than ${cur.limits.nodes} elements`)
  }
  const attrs = attributes(cur)
  if (attrs === undefined) return undefined
  let children: ReadonlyArray<Node> = []
  if (ahead(cur, "/>")) {
    cur.at += 2
  } else if (ahead(cur, ">")) {
    cur.at += 1
    const kids = content(cur, name)
    if (kids === undefined) return undefined
    children = kids
  } else {
    return stop(cur, `expected ">" in <${name}>`)
  }
  cur.path.pop()
  return elem(name, attrs, children)
}

export const scan = (
  source: string,
  limits: Partial<Limits> = {}
): Elem | Fault => {
  const bounds: Limits = { ...LIMITS, ...limits }
  if (source.length > bounds.length) {
    return fault("document", `longer than ${bounds.length} characters`)
  }
  const cur: Cur = {
    text: source,
    at: 0,
    nodes: 0,
    held: undefined,
    path: [],
    limits: bounds
  }
  space(cur)
  if (ahead(cur, "<?xml")) {
    const end = cur.text.indexOf("?>", cur.at)
    if (end < 0) {
      return fault("document", "the xml declaration is not closed")
    }
    cur.at = end + 2
  }
  if (!trivia(cur)) return cur.held ?? fault("document", "expected an element")
  if (forbidden(cur)) {
    return cur.held ?? fault("document", "expected an element")
  }
  if (!ahead(cur, "<")) return fault("document", "expected an element")
  const root = element(cur)
  if (root === undefined) {
    return cur.held ?? fault("document", "expected an element")
  }
  if (!trivia(cur)) return cur.held ?? fault("document", "expected an element")
  if (cur.at < cur.text.length) {
    return fault("document", "content after the root element")
  }
  return root
}
