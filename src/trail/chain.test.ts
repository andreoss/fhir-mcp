import { describe, expect, it } from "vitest"
import { GENESIS, audit, digestOf, read, write } from "./chain.js"
import type { Entry, Held, Line } from "./chain.js"
import { anchorOf, sealOf } from "./seal.js"

const KEY = "a-key-kept-outside-the-trail"

const entry = (n: number): Entry => ({
  actor: `actor-${n}`,
  action: "read",
  resource: `Patient/${n}`,
  outcome: "success",
  correlation: `c-${n}`
})

const chain = (count: number): Array<Line> => {
  const lines: Array<Line> = []
  let prev = GENESIS
  for (let n = 1; n <= count; n += 1) {
    const held = entry(n)
    const at = n * 1000
    const digest = digestOf(held, at, prev)
    lines.push({ ...held, seq: n, at, prev, digest })
    prev = digest
  }
  return lines
}

const held = (lines: ReadonlyArray<Line>): Held => ({
  lines,
  anchor: undefined,
  seals: []
})

const at = (lines: ReadonlyArray<Line>, seq: number): Line => {
  const found = lines.find((line) => line.seq === seq)
  if (found === undefined) throw new Error(`no record ${seq}`)
  return found
}

describe("chain digest", () => {
  it("is stable for the same content and predecessor", () => {
    expect(digestOf(entry(1), 10, GENESIS)).toBe(
      digestOf(entry(1), 10, GENESIS)
    )
  })

  it("moves when the predecessor moves", () => {
    expect(digestOf(entry(1), 10, GENESIS)).not.toBe(
      digestOf(entry(1), 10, digestOf(entry(2), 10, GENESIS))
    )
  })

  it("moves when the recorded moment moves", () => {
    expect(digestOf(entry(1), 10, GENESIS)).not.toBe(
      digestOf(entry(1), 11, GENESIS)
    )
  })

  it("keeps a separator inside a field from posing as a boundary", () => {
    const left: Entry = { ...entry(1), actor: "a", resource: "b|c" }
    const right: Entry = { ...entry(1), actor: "a|b", resource: "c" }
    expect(digestOf(left, 10, GENESIS)).not.toBe(digestOf(right, 10, GENESIS))
  })
})

describe("chain audit", () => {
  it("passes an untouched chain", () => {
    const report = audit(KEY, held(chain(4)))
    expect(report.ok).toBe(true)
    expect(report.checked).toBe(4)
    expect(report.head).toBe(4)
    expect(report.broke).toBeUndefined()
  })

  it("passes an empty trail", () => {
    const report = audit(KEY, held([]))
    expect(report.ok).toBe(true)
    expect(report.head).toBeUndefined()
  })

  it("names the record whose content was altered", () => {
    const lines = chain(4)
    const target = at(lines, 2)
    const report = audit(
      KEY,
      held(lines.map((line) =>
        line.seq === 2 ? { ...target, resource: "Patient/999" } : line
      ))
    )
    expect(report.ok).toBe(false)
    expect(report.broke?.seq).toBe(2)
    expect(report.broke?.cause).toBe("content")
    expect(report.broke?.detail).toContain("2")
  })

  it("names the record left without its predecessor", () => {
    const lines = chain(4).filter((line) => line.seq !== 2)
    const report = audit(KEY, held(lines))
    expect(report.broke?.seq).toBe(3)
    expect(report.broke?.cause).toBe("missing")
  })

  it("names both records when two are reordered", () => {
    const lines = chain(4)
    const swapped = [at(lines, 1), at(lines, 3), at(lines, 2), at(lines, 4)]
      .map((line, index) => ({ ...line, seq: index + 1 }))
    const report = audit(KEY, held(swapped))
    expect(report.broke?.cause).toBe("order")
    expect(report.broke?.seq).toBe(2)
    expect(report.broke?.detail).toContain("3")
  })

  it("does not see a truncation with nothing pinning the head", () => {
    expect(audit(KEY, held(chain(4).slice(0, 2))).ok).toBe(true)
  })

  it("sees a truncation past a sealed head", () => {
    const lines = chain(4)
    const seal = sealOf(KEY, 4, at(lines, 4).digest, 4000)
    const report = audit(KEY, {
      lines: lines.slice(0, 3),
      anchor: undefined,
      seals: [seal]
    })
    expect(report.broke?.seq).toBe(4)
    expect(report.broke?.cause).toBe("truncated")
  })

  it("refuses a seal that was not made with the key", () => {
    const lines = chain(4)
    const seal = sealOf("another-key", 4, at(lines, 4).digest, 4000)
    const report = audit(KEY, { lines, anchor: undefined, seals: [seal] })
    expect(report.broke?.cause).toBe("seal")
    expect(report.broke?.seq).toBe(4)
  })

  it("sees a sealed record rewritten with its chain rebuilt", () => {
    const lines = chain(4)
    const seal = sealOf(KEY, 3, "0".repeat(63) + "1", 3000)
    const report = audit(KEY, { lines, anchor: undefined, seals: [seal] })
    expect(report.broke?.cause).toBe("seal")
    expect(report.broke?.detail).toContain("sealed digest")
  })

  it("accepts a purged prefix that a signed anchor covers", () => {
    const lines = chain(4)
    const kept = lines.slice(2)
    const first = kept[0]
    const report = audit(KEY, {
      lines: kept,
      anchor: anchorOf(KEY, first!.seq, first!.prev, 2),
      seals: []
    })
    expect(report.ok).toBe(true)
    expect(report.checked).toBe(2)
  })

  it("refuses an anchor that was not made with the key", () => {
    const lines = chain(4)
    const kept = lines.slice(2)
    const first = kept[0]
    const report = audit(KEY, {
      lines: kept,
      anchor: anchorOf("another-key", first!.seq, first!.prev, 2),
      seals: []
    })
    expect(report.broke?.cause).toBe("anchor")
  })

  it("refuses an anchor that names another predecessor", () => {
    const kept = chain(4).slice(2)
    const first = kept[0]
    const report = audit(KEY, {
      lines: kept,
      anchor: anchorOf(KEY, first!.seq, GENESIS, 2),
      seals: []
    })
    expect(report.broke?.cause).toBe("missing")
    expect(report.broke?.seq).toBe(3)
  })
})

describe("chain export", () => {
  it("round trips lines, seals and an anchor", () => {
    const lines = chain(3)
    const first = lines[0]
    const source: Held = {
      lines,
      anchor: anchorOf(KEY, first!.seq, GENESIS, 0),
      seals: [sealOf(KEY, 3, at(lines, 3).digest, 3000)]
    }
    const back = read(write(source))
    expect(back.lines).toEqual(source.lines)
    expect(back.seals).toEqual(source.seals)
    expect(back.anchor).toEqual(source.anchor)
  })

  it("carries enough for an audit away from the store", () => {
    const source = held(chain(3))
    expect(audit(KEY, read(write(source))).ok).toBe(true)
  })

  it("shows an export edited after it left the store", () => {
    const text = write(held(chain(3))).replace("Patient/2", "Patient/222")
    expect(audit(KEY, read(text)).broke?.cause).toBe("content")
  })

  it("ignores blank lines in an export", () => {
    const text = `${write(held(chain(2)))}\n\n`
    expect(read(text).lines).toHaveLength(2)
  })
})
