import { describe, expect, it } from "vitest"
import { Effect, Either, Exit } from "effect"
import { emit, generate } from "./generate.js"
import type { SpecElement, Structure } from "./generate.js"
import type { Definition, Group, Leaf } from "../model/shape.js"

const spec = (
  path: string,
  min: number,
  max: string,
  ...codes: ReadonlyArray<string>
): SpecElement =>
  codes.length === 0
    ? { path, min, max }
    : { path, min, max, type: codes.map((code) => ({ code })) }

const structure = (
  kind: "resource" | "complex-type",
  type: string,
  element: ReadonlyArray<SpecElement>
): Structure => ({
  resourceType: "StructureDefinition",
  kind,
  type,
  snapshot: { element: [spec(type, 0, "*"), ...element] }
})

const resource = (
  type: string,
  ...element: ReadonlyArray<SpecElement>
): Structure => structure("resource", type, element)

const complex = (
  type: string,
  ...element: ReadonlyArray<SpecElement>
): Structure => structure("complex-type", type, element)

const PERIOD = complex(
  "Period",
  spec("Period.start", 0, "1", "dateTime"),
  spec("Period.end", 0, "1", "dateTime")
)

const CODING = complex(
  "Coding",
  spec("Coding.system", 0, "1", "uri"),
  spec("Coding.code", 0, "1", "code")
)

const CONCEPT = complex(
  "CodeableConcept",
  spec("CodeableConcept.coding", 0, "*", "Coding"),
  spec("CodeableConcept.text", 0, "1", "string")
)

const REFERENCE = complex(
  "Reference",
  spec("Reference.reference", 0, "1", "string"),
  spec("Reference.identifier", 0, "1", "Identifier")
)

const IDENTIFIER = complex(
  "Identifier",
  spec("Identifier.value", 0, "1", "string"),
  spec("Identifier.assigner", 0, "1", "Reference")
)

const SUPPORT = [PERIOD, CODING, CONCEPT, REFERENCE, IDENTIFIER]

const OBSERVATION = resource(
  "Observation",
  spec("Observation.id", 0, "1", "id"),
  spec("Observation.contained", 0, "*", "Resource"),
  spec("Observation.extension", 0, "*", "Extension"),
  spec("Observation.status", 1, "1", "code"),
  spec("Observation.note", 0, "1", "markdown"),
  spec("Observation.sequence", 0, "1", "positiveInt"),
  spec("Observation.instantiates", 0, "1", "canonical"),
  spec("Observation.code", 1, "1", "CodeableConcept"),
  spec("Observation.subject", 0, "1", "Reference"),
  spec("Observation.effective[x]", 0, "1", "dateTime", "Period"),
  spec("Observation.component", 0, "*", "BackboneElement"),
  spec("Observation.component.code", 1, "1", "CodeableConcept"),
  spec("Observation.component.value[x]", 0, "*", "string"),
  spec("Observation.withdrawn", 0, "0", "boolean")
)

const INPUT = [...SUPPORT, OBSERVATION]

const right = (input: ReadonlyArray<Structure>): Definition => {
  const made = emit(input)
  if (Either.isLeft(made)) throw new Error(made.left)
  const held = made.right["Observation"]
  if (held === undefined) throw new Error("no Observation")
  return held
}

const left = (input: ReadonlyArray<Structure>): string => {
  const made = emit(input)
  if (Either.isRight(made)) throw new Error("expected a refusal")
  return made.left
}

const leaf = (definition: Definition, name: string): Leaf => {
  const held = definition.elements[name]
  if (held === undefined || held.kind === "group" || held.kind === "open") {
    throw new Error(`${name} is not a leaf`)
  }
  return held
}

const nested = (definition: Definition, name: string): Group => {
  const held = definition.elements[name]
  if (held === undefined || held.kind !== "group") {
    throw new Error(`${name} is not a group`)
  }
  return held
}

describe("the generator emits element definitions from a structure", () => {
  it("names the resource it emitted", () => {
    expect(right(INPUT).type).toBe("Observation")
  })

  it("emits a leaf carrying the declared cardinality", () => {
    expect(leaf(right(INPUT), "status")).toEqual({
      kind: "code",
      card: "1..1"
    })
    expect(leaf(right(INPUT), "id").card).toBe("0..1")
  })

  it("emits a required repeating element", () => {
    const made = emit([
      resource("Observation", spec("Observation.name", 1, "*", "string"))
    ])
    if (Either.isLeft(made)) throw new Error(made.left)
    expect(made.right["Observation"]?.elements["name"]).toEqual({
      kind: "string",
      card: "1..*"
    })
  })

  it("maps a specification primitive onto the model primitive", () => {
    expect(leaf(right(INPUT), "note").kind).toBe("string")
    expect(leaf(right(INPUT), "sequence").kind).toBe("integer")
    expect(leaf(right(INPUT), "instantiates").kind).toBe("uri")
  })

  it("expands a named complex type into a group", () => {
    const held = nested(right(INPUT), "code")
    expect(held.card).toBe("1..1")
    expect(Object.keys(held.children)).toEqual(["coding", "text"])
    expect(held.children["text"]).toEqual({ kind: "string", card: "0..1" })
  })

  it("expands a complex type through its own complex children", () => {
    const coding = nested(right(INPUT), "code").children["coding"]
    expect(coding?.kind).toBe("group")
    expect(coding?.card).toBe("0..*")
  })

  it("expands a backbone element into a group of its children", () => {
    const held = nested(right(INPUT), "component")
    expect(held.card).toBe("0..*")
    expect(Object.keys(held.children)).toEqual(["code", "valueString"])
  })

  it("groups an element that names no type but declares children", () => {
    const made = emit([
      resource(
        "Observation",
        spec("Observation.range", 0, "*"),
        spec("Observation.range.low", 0, "1", "decimal")
      )
    ])
    if (Either.isLeft(made)) throw new Error(made.left)
    expect(made.right["Observation"]?.elements["range"]).toEqual({
      kind: "group",
      card: "0..*",
      children: { low: { kind: "decimal", card: "0..1" } }
    })
  })

  it("expands a choice element into one entry per named type", () => {
    const made = right(INPUT)
    expect(made.elements["effectiveDateTime"]).toEqual({
      kind: "dateTime",
      card: "0..1"
    })
    expect(made.elements["effectivePeriod"]?.kind).toBe("group")
    expect(made.elements["effective[x]"]).toBeUndefined()
  })

  it("keeps a repeating choice repeating and never required", () => {
    const held = nested(right(INPUT), "component")
    expect(held.children["valueString"]).toEqual({
      kind: "string",
      card: "0..*"
    })
  })

  it("emits an open element for a type it does not model", () => {
    const made = right(INPUT)
    expect(made.elements["contained"]).toEqual({ kind: "open", card: "0..*" })
    expect(made.elements["extension"]).toEqual({ kind: "open", card: "0..*" })
  })

  it("breaks a type cycle with an open element", () => {
    const held = nested(right(INPUT), "subject")
    const identifier = held.children["identifier"]
    if (identifier === undefined || identifier.kind !== "group") {
      throw new Error("identifier is not a group")
    }
    expect(identifier.children["assigner"]).toEqual({
      kind: "open",
      card: "0..1"
    })
  })

  it("drops an element the structure forbids", () => {
    expect(right(INPUT).elements["withdrawn"]).toBeUndefined()
  })

  it("emits resources only, never the complex types they use", () => {
    const made = emit(INPUT)
    if (Either.isLeft(made)) throw new Error(made.left)
    expect(Object.keys(made.right)).toEqual(["Observation"])
  })

  it("emits every resource in the input, named by type", () => {
    const made = emit([...SUPPORT, OBSERVATION, resource("Patient")])
    if (Either.isLeft(made)) throw new Error(made.left)
    expect(Object.keys(made.right)).toEqual(["Observation", "Patient"])
  })
})

describe("the generator refuses input it cannot model", () => {
  it("refuses an element that is not under the structure it declares", () => {
    expect(
      left([
        complex("Period", spec("Range.low", 0, "1", "decimal")),
        resource("Observation", spec("Observation.when", 0, "1", "Period"))
      ])
    ).toContain("Range.low")
  })

  it("refuses an element whose parent is not declared", () => {
    expect(
      left([resource("Observation", spec("Observation.a.b", 0, "1", "code"))])
    ).toContain("parent is not declared")
  })

  it("refuses an unknown type", () => {
    expect(
      left([resource("Observation", spec("Observation.x", 0, "1", "Money"))])
    ).toContain("Money")
  })

  it("refuses an element carrying more than one type", () => {
    expect(
      left([
        resource("Observation", spec("Observation.x", 0, "1", "code", "uri"))
      ])
    ).toContain("more than one type")
  })

  it("refuses an element with neither a type nor children", () => {
    expect(left([resource("Observation", spec("Observation.x", 0, "1"))]))
      .toContain("names no type")
  })

  it("refuses a choice element that names no type", () => {
    expect(left([resource("Observation", spec("Observation.x[x]", 0, "1"))]))
      .toContain("names no type")
  })

  it("refuses a choice element naming a type it cannot model", () => {
    expect(
      left([
        resource("Observation", spec("Observation.x[x]", 0, "1", "Money"))
      ])
    ).toContain("Money")
  })

  it("reports the refusal from within a nested structure", () => {
    expect(
      left([
        complex("Period", spec("Period.low", 0, "1", "Money")),
        resource("Observation", spec("Observation.when", 0, "1", "Period"))
      ])
    ).toContain("Period.low")
  })
})

describe("the generator is deterministic", () => {
  it("emits byte-identical output across runs", () => {
    const one = JSON.stringify(emit(INPUT))
    const two = JSON.stringify(emit(INPUT))
    expect(one).toBe(two)
    expect(one.length).toBeGreaterThan(0)
  })

  it("emits byte-identical output whatever order the input arrives", () => {
    const shuffled = [
      OBSERVATION,
      IDENTIFIER,
      CONCEPT,
      REFERENCE,
      CODING,
      PERIOD
    ]
    expect(JSON.stringify(emit(shuffled))).toBe(JSON.stringify(emit(INPUT)))
  })

  it("orders resources by name, not by position in the input", () => {
    const made = emit([resource("Patient"), ...SUPPORT, OBSERVATION])
    if (Either.isLeft(made)) throw new Error(made.left)
    expect(Object.keys(made.right)).toEqual(["Observation", "Patient"])
  })
})

describe("the generator answers in the failure channel", () => {
  it("succeeds with the emitted models", async () => {
    const made = await Effect.runPromise(generate(INPUT))
    expect(Object.keys(made)).toEqual(["Observation"])
  })

  it("fails with the refusal reason", async () => {
    const result = await Effect.runPromiseExit(
      generate([
        resource("Observation", spec("Observation.x", 0, "1", "Money"))
      ])
    )
    if (!Exit.isFailure(result) || result.cause._tag !== "Fail") {
      throw new Error("expected a failure")
    }
    expect(result.cause.error._tag).toBe("Rejected")
    expect((result.cause.error as { readonly reason: string }).reason)
      .toContain("Money")
  })
})
