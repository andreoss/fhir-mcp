import { describe, expect, it } from "vitest"
import { elem, isFault, render, scan, text, write } from "./tree.js"
import type { Elem, Fault } from "./tree.js"

const tree = (source: string): Elem => {
  const held = scan(source)
  if (isFault(held)) throw new Error(render(held))
  return held
}

const refused = (source: string): string => {
  const held = scan(source)
  if (!isFault(held)) throw new Error("expected a refusal")
  return render(held)
}

describe("scanning", () => {
  it("reads an empty element with attributes", () => {
    const node = tree('<a b="1" c="2"/>')
    expect(node.name).toBe("a")
    expect(node.attrs).toEqual([["b", "1"], ["c", "2"]])
    expect(node.children).toEqual([])
  })

  it("reads children and text in order", () => {
    const node = tree("<a>one<b/>two<c/></a>")
    expect(node.children.map((kid) => kid.kind)).toEqual([
      "text",
      "elem",
      "text",
      "elem"
    ])
  })

  it("accepts single quoted attribute values", () => {
    expect(tree("<a b='1'/>").attrs).toEqual([["b", "1"]])
  })

  it("accepts names with a colon", () => {
    expect(tree("<a xml:lang='en'/>").attrs).toEqual([["xml:lang", "en"]])
  })

  it("resolves the predefined entities", () => {
    const node = tree("<a>&lt;&gt;&amp;&quot;&apos;</a>")
    expect(node.children[0]).toEqual(text("<>&\"'"))
  })

  it("resolves numeric character references", () => {
    expect(tree("<a>&#65;&#x42;</a>").children[0]).toEqual(text("AB"))
  })

  it("refuses a malformed numeric character reference", () => {
    expect(refused("<a>&#12zz;</a>")).toBe(
      "a: unknown entity reference &#12zz;"
    )
  })

  it("refuses a character reference outside the code point range", () => {
    expect(refused("<a>&#1114112;</a>")).toBe(
      "a: unknown entity reference &#1114112;"
    )
  })

  it("refuses an unclosed element", () => {
    expect(refused("<a><b/>")).toBe("a: <a> is not closed")
  })

  it("refuses an end tag that does not match", () => {
    expect(refused("<a><b></c></a>")).toBe("a.b: </c> does not close <b>")
  })

  it("refuses a missing closing angle bracket", () => {
    expect(refused("<a b='1'")).toBe("a: expected \">\" in <a>")
  })

  it("refuses a missing closing angle bracket on an end tag", () => {
    expect(refused("<a></a")).toBe("a: expected \">\" in </a>")
  })

  it("refuses an attribute with no value", () => {
    expect(refused("<a b/>")).toBe('a: expected "=" after b')
  })

  it("refuses an unquoted attribute value", () => {
    expect(refused("<a b=1/>")).toBe("a: expected a quoted value for b")
  })

  it("refuses an attribute value that is never closed", () => {
    expect(refused('<a b="1/>')).toBe("a: the value of b is not closed")
  })

  it("refuses a duplicate attribute", () => {
    expect(refused('<a b="1" b="2"/>')).toBe("a: duplicate attribute b")
  })

  it("refuses a name that does not start a tag", () => {
    expect(refused("<1/>")).toBe("document: expected an element name")
  })

  it("refuses an unclosed comment", () => {
    expect(refused("<!-- open <a/>")).toBe("document: a comment is not closed")
  })

  it("refuses an unclosed comment inside an element", () => {
    expect(refused("<a><!-- open </a>")).toBe("a: a comment is not closed")
  })

  it("refuses an unclosed xml declaration", () => {
    expect(refused("<?xml version='1.0'")).toBe(
      "document: the xml declaration is not closed"
    )
  })

  it("refuses a declaration that is not a comment", () => {
    expect(refused("<!ATTLIST a b CDATA>")).toBe(
      "document: a declaration is not accepted"
    )
  })

  it("names only the head of a very deep path", () => {
    const source = "<a>".repeat(20) + "&bad;" + "</a>".repeat(20)
    expect(refused(source)).toContain("a.a.a.a.a.a.a.a...:")
  })

  it("keeps comments out of the tree", () => {
    expect(tree("<a><!-- x --><b/></a>").children).toEqual([elem("b", [], [])])
  })
})

describe("writing", () => {
  it("writes an empty element closed on itself", () => {
    expect(write(elem("a", [], []))).toBe("<a/>")
  })

  it("writes attributes in the order they are held", () => {
    expect(write(elem("a", [["b", "1"], ["c", "2"]], []))).toBe(
      '<a b="1" c="2"/>'
    )
  })

  it("escapes reserved characters in attributes and text", () => {
    const node = elem("a", [["b", '<&">']], [text("<&>")])
    expect(write(node)).toBe('<a b="&lt;&amp;&quot;&gt;">&lt;&amp;&gt;</a>')
  })

  it("writes nested elements", () => {
    expect(write(elem("a", [], [elem("b", [], [text("x")])]))).toBe(
      "<a><b>x</b></a>"
    )
  })
})

describe("faults", () => {
  it("renders the path and the detail", () => {
    const fault: Fault = { fault: true, path: "Patient.name", detail: "gone" }
    expect(render(fault)).toBe("Patient.name: gone")
  })

  it("recognises a fault and nothing else", () => {
    expect(isFault({ fault: true, path: "a", detail: "b" })).toBe(true)
    expect(isFault(elem("a", [], []))).toBe(false)
    expect(isFault(null)).toBe(false)
  })
})

describe("scanning trivia before the root", () => {
  it("skips a comment and the whitespace that follows it", () => {
    expect(tree("<!-- a -->  <b/>").name).toBe("b")
  })
})
