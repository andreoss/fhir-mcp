import type { SpecElement, Structure } from "./generate.js"

const at = (
  path: string,
  min: number,
  max: string,
  ...codes: ReadonlyArray<string>
): SpecElement =>
  codes.length === 0
    ? { path, min, max }
    : { path, min, max, type: codes.map((code) => ({ code })) }

const held = (
  kind: "resource" | "complex-type",
  type: string,
  element: ReadonlyArray<SpecElement>
): Structure => ({
  resourceType: "StructureDefinition",
  kind,
  type,
  snapshot: { element: [at(type, 0, "*"), ...element] }
})

const CODING = held("complex-type", "Coding", [
  at("Coding.system", 0, "1", "uri"),
  at("Coding.version", 0, "1", "string"),
  at("Coding.code", 0, "1", "code"),
  at("Coding.display", 0, "1", "string"),
  at("Coding.userSelected", 0, "1", "boolean")
])

const CONCEPT = held("complex-type", "CodeableConcept", [
  at("CodeableConcept.coding", 0, "*", "Coding"),
  at("CodeableConcept.text", 0, "1", "string")
])

const PERIOD = held("complex-type", "Period", [
  at("Period.start", 0, "1", "dateTime"),
  at("Period.end", 0, "1", "dateTime")
])

const REFERENCE = held("complex-type", "Reference", [
  at("Reference.reference", 0, "1", "string"),
  at("Reference.type", 0, "1", "uri"),
  at("Reference.identifier", 0, "1", "Identifier"),
  at("Reference.display", 0, "1", "string")
])

const IDENTIFIER = held("complex-type", "Identifier", [
  at("Identifier.use", 0, "1", "code"),
  at("Identifier.type", 0, "1", "CodeableConcept"),
  at("Identifier.system", 0, "1", "uri"),
  at("Identifier.value", 0, "1", "string"),
  at("Identifier.period", 0, "1", "Period"),
  at("Identifier.assigner", 0, "1", "Reference")
])

const ANNOTATION = held("complex-type", "Annotation", [
  at("Annotation.author[x]", 0, "1", "Reference", "string"),
  at("Annotation.time", 0, "1", "dateTime"),
  at("Annotation.text", 1, "1", "markdown")
])

const META = held("complex-type", "Meta", [
  at("Meta.versionId", 0, "1", "id"),
  at("Meta.lastUpdated", 0, "1", "instant"),
  at("Meta.source", 0, "1", "uri"),
  at("Meta.profile", 0, "*", "canonical"),
  at("Meta.security", 0, "*", "Coding"),
  at("Meta.tag", 0, "*", "Coding")
])

const NARRATIVE = held("complex-type", "Narrative", [
  at("Narrative.status", 1, "1", "code"),
  at("Narrative.div", 1, "1", "xhtml")
])

const PROCEDURE = held("resource", "Procedure", [
  at("Procedure.id", 0, "1", "id"),
  at("Procedure.meta", 0, "1", "Meta"),
  at("Procedure.implicitRules", 0, "1", "uri"),
  at("Procedure.language", 0, "1", "code"),
  at("Procedure.text", 0, "1", "Narrative"),
  at("Procedure.contained", 0, "*", "Resource"),
  at("Procedure.extension", 0, "*", "Extension"),
  at("Procedure.modifierExtension", 0, "*", "Extension"),
  at("Procedure.identifier", 0, "*", "Identifier"),
  at("Procedure.status", 1, "1", "code"),
  at("Procedure.statusReason", 0, "1", "CodeableConcept"),
  at("Procedure.category", 0, "*", "CodeableConcept"),
  at("Procedure.code", 0, "1", "CodeableConcept"),
  at("Procedure.subject", 1, "1", "Reference"),
  at("Procedure.encounter", 0, "1", "Reference"),
  at("Procedure.occurrence[x]", 0, "1", "dateTime", "Period"),
  at("Procedure.recorded", 0, "1", "dateTime"),
  at("Procedure.performer", 0, "*", "BackboneElement"),
  at("Procedure.performer.id", 0, "1", "string"),
  at("Procedure.performer.function", 0, "1", "CodeableConcept"),
  at("Procedure.performer.actor", 1, "1", "Reference"),
  at("Procedure.performer.period", 0, "1", "Period"),
  at("Procedure.bodySite", 0, "*", "CodeableConcept"),
  at("Procedure.outcome", 0, "1", "CodeableConcept"),
  at("Procedure.note", 0, "*", "Annotation")
])

export const SOURCE: ReadonlyArray<Structure> = [
  ANNOTATION,
  CODING,
  CONCEPT,
  IDENTIFIER,
  META,
  NARRATIVE,
  PERIOD,
  PROCEDURE,
  REFERENCE
]
