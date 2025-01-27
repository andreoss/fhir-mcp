import { fault, isFault, scan, write } from "./tree.js"
import type { Elem, Fault, Limits, Node } from "./tree.js"

export const XHTML = "http://www.w3.org/1999/xhtml"

const BANNED: ReadonlySet<string> = new Set([
  "script",
  "style",
  "form",
  "iframe",
  "object",
  "embed",
  "applet",
  "frame",
  "frameset",
  "base",
  "link",
  "meta",
  "head",
  "body",
  "html",
  "input",
  "button",
  "select",
  "textarea"
])

const URLS: ReadonlySet<string> = new Set(["href", "src", "xlink:href"])

const ACTIVE = /^\s*(javascript|vbscript):/i

const guard = (node: Node, path: string): Fault | undefined => {
  if (node.kind === "text") return undefined
  if (BANNED.has(node.name.toLowerCase())) {
    return fault(path, `<${node.name}> is not accepted in narrative`)
  }
  for (const [name, value] of node.attrs) {
    const lower = name.toLowerCase()
    const scripted = URLS.has(lower) && ACTIVE.test(value)
    if (lower.startsWith("on") || scripted) {
      return fault(path, `attribute "${name}" is not accepted in narrative`)
    }
  }
  for (const kid of node.children) {
    const found = guard(kid, path)
    if (found !== undefined) return found
  }
  return undefined
}

const namespaced = (node: Elem): boolean =>
  node.attrs.some(([name, value]) => name === "xmlns" && value === XHTML)

export const divText = (node: Elem, path: string): string | Fault => {
  if (!namespaced(node)) return fault(path, "expected the xhtml namespace")
  return guard(node, path) ?? write(node)
}

export const textDiv = (
  value: unknown,
  path: string,
  limits: Partial<Limits>
): Elem | Fault => {
  if (typeof value !== "string") return fault(path, "expected string")
  const node = scan(value, limits)
  if (isFault(node)) return fault(path, node.detail)
  if (node.name !== "div") return fault(path, "expected a div element")
  if (!namespaced(node)) return fault(path, "expected the xhtml namespace")
  return guard(node, path) ?? node
}
