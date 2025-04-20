import { describe, expect, it } from "vitest"
import { NotFound, Rejected, statusOf } from "../core/outcome.js"
import {
  DEFAULT,
  FHIR_JSON,
  FHIR_XML,
  NOT_ACCEPTABLE,
  NOT_MODIFIED,
  answerOf,
  choose,
  freshnessOf,
  notModifiedOf,
  outcomeOf,
  refusedOf,
  tagsOf
} from "./negotiate.js"
import type { Ask, Choice, Refusal, Representation } from "./negotiate.js"

const ask = (accept?: string, format?: string, pretty?: string): Ask => ({
  accept,
  format,
  pretty
})

const served = (choice: Choice): Representation => {
  if (choice.kind !== "serve") throw new Error(`expected serve, got ${choice.kind}`)
  return choice.rep
}

const deferred = (choice: Choice): Representation => {
  if (choice.kind !== "defer") throw new Error(`expected defer, got ${choice.kind}`)
  return choice.rep
}

const refused = (choice: Choice): Refusal => {
  if (choice.kind !== "refuse") throw new Error(`expected refuse, got ${choice.kind}`)
  return choice.refusal
}

const stamp = { versionId: 3, lastUpdated: "2024-05-01T10:00:00.000Z" }

const conditions = (match?: string, since?: string) => ({
  ifNoneMatch: match,
  ifModifiedSince: since
})

describe("representation", () => {
  it("answers the default json when nothing is asked", () => {
    const rep = served(choose(ask()))
    expect(rep).toEqual(DEFAULT)
    expect(rep.mediaType).toBe(FHIR_JSON)
    expect(rep.pretty).toBe(false)
    expect(rep.served).toBe(true)
  })

  it("treats an empty accept header as no preference", () => {
    expect(served(choose(ask("   ")))).toEqual(DEFAULT)
  })

  it("answers the default json for a full wildcard", () => {
    expect(served(choose(ask("*/*"))).mediaType).toBe(FHIR_JSON)
  })

  it("resolves a subtype wildcard to a json type it can serve", () => {
    expect(served(choose(ask("application/*"))).mediaType).toBe(FHIR_JSON)
    expect(served(choose(ask("text/*"))).mediaType).toBe("text/json")
  })

  it("answers in the json media type that was asked for", () => {
    expect(served(choose(ask("application/json"))).mediaType).toBe("application/json")
    expect(served(choose(ask("application/json+fhir"))).mediaType).toBe(
      "application/json+fhir"
    )
  })

  it("takes the candidate with the highest quality", () => {
    const choice = choose(ask("application/fhir+xml;q=0.9, application/fhir+json;q=1.0"))
    expect(served(choice).format).toBe("json")
  })

  it("prefers a lower placed candidate when its quality is higher", () => {
    const choice = choose(ask("application/fhir+json;q=0.2, application/fhir+xml;q=0.8"))
    expect(deferred(choice).format).toBe("xml")
  })

  it("drops a candidate the caller refused with a zero quality", () => {
    const choice = choose(ask("application/fhir+json;q=0, application/fhir+xml"))
    expect(deferred(choice).mediaType).toBe(FHIR_XML)
  })

  it("prefers an exact media type over a wildcard of equal quality", () => {
    expect(deferred(choose(ask("*/*, application/fhir+xml"))).format).toBe("xml")
  })

  it("keeps the order given when quality and specificity tie", () => {
    expect(served(choose(ask("text/json, application/json"))).mediaType).toBe("text/json")
  })

  it("passes over a media type it cannot name and takes the next", () => {
    expect(served(choose(ask("text/csv, application/fhir+json"))).mediaType).toBe(FHIR_JSON)
  })

  it("refuses rather than substituting when nothing asked for can be named", () => {
    const refusal = refused(choose(ask("text/csv")))
    expect(refusal.status).toBe(NOT_ACCEPTABLE)
    expect(refusal.failure._tag).toBe("Rejected")
  })

  it("refuses an accept header it cannot parse", () => {
    expect(refused(choose(ask("application"))).status).toBe(400)
    expect(refused(choose(ask("application/json;q=high"))).status).toBe(400)
    expect(refused(choose(ask("application/json;q=4"))).status).toBe(400)
    expect(refused(choose(ask("application/json;q=-1"))).status).toBe(400)
  })

  it("reads a media type that carries other parameters beside quality", () => {
    const choice = choose(ask("application/fhir+json;charset=utf-8;q=0.9"))
    expect(served(choice).mediaType).toBe(FHIR_JSON)
  })

  it("names an xml representation instead of answering json under it", () => {
    const rep = deferred(choose(ask("application/fhir+xml")))
    expect(rep.format).toBe("xml")
    expect(rep.mediaType).toBe(FHIR_XML)
    expect(rep.served).toBe(false)
  })

  it("names every xml media type the specifications use", () => {
    for (const type of ["application/xml", "text/xml", "application/xml+fhir"]) {
      const rep = deferred(choose(ask(type)))
      expect(rep.mediaType).toBe(type)
      expect(rep.served).toBe(false)
    }
  })

  it("lets the format parameter override the accept header", () => {
    expect(deferred(choose(ask(FHIR_JSON, "xml"))).format).toBe("xml")
    expect(served(choose(ask(FHIR_XML, "json"))).mediaType).toBe(FHIR_JSON)
  })

  it("reads the format parameter as a short token or a media type", () => {
    expect(served(choose(ask(undefined, " JSON "))).mediaType).toBe(FHIR_JSON)
    expect(served(choose(ask(undefined, "application/json"))).mediaType).toBe(
      "application/json"
    )
    expect(deferred(choose(ask(undefined, "text/xml"))).mediaType).toBe("text/xml")
  })

  it("refuses a format parameter it does not know", () => {
    const refusal = refused(choose(ask(undefined, "yaml")))
    expect(refusal.status).toBe(400)
    expect(statusOf(refusal.failure)).toBe(400)
  })

  it("reads the pretty parameter as a flag", () => {
    expect(served(choose(ask(undefined, undefined, "true"))).pretty).toBe(true)
    expect(served(choose(ask(undefined, undefined, "false"))).pretty).toBe(false)
    expect(served(choose(ask())).pretty).toBe(false)
  })

  it("refuses a pretty parameter it does not know", () => {
    expect(refused(choose(ask(undefined, "json", "maybe"))).status).toBe(400)
  })

  it("carries the pretty flag onto a representation it defers", () => {
    expect(deferred(choose(ask(undefined, "xml", "true"))).pretty).toBe(true)
  })
})

describe("validators", () => {
  it("derives a weak tag and an http date from a version", () => {
    const tags = tagsOf(stamp)
    expect(tags.etag).toBe('W/"3"')
    expect(tags.lastModified).toBe("Wed, 01 May 2024 10:00:00 GMT")
  })

  it("omits the date when the stamp cannot be read as one", () => {
    expect(tagsOf({ versionId: 1, lastUpdated: "never" }).lastModified).toBeUndefined()
  })
})

describe("conditional requests", () => {
  it("answers not modified when a tag matches", () => {
    const fresh = freshnessOf(tagsOf(stamp), conditions('W/"3"'))
    expect(fresh.notModified).toBe(true)
    expect(fresh.status).toBe(NOT_MODIFIED)
  })

  it("matches a strong tag against a weak one", () => {
    expect(freshnessOf(tagsOf(stamp), conditions('"3"')).notModified).toBe(true)
  })

  it("answers not modified for a wildcard tag", () => {
    expect(freshnessOf(tagsOf(stamp), conditions("*")).notModified).toBe(true)
  })

  it("reads a list of candidate tags", () => {
    const fresh = freshnessOf(tagsOf(stamp), conditions('W/"1", W/"3"'))
    expect(fresh.notModified).toBe(true)
  })

  it("answers with the resource when no tag matches", () => {
    const fresh = freshnessOf(tagsOf(stamp), conditions('W/"2"'))
    expect(fresh.notModified).toBe(false)
    expect(fresh.status).toBe(200)
  })

  it("lets the tag decide over the date when both are given", () => {
    const fresh = freshnessOf(
      tagsOf(stamp),
      conditions('W/"2"', "Wed, 01 May 2024 12:00:00 GMT")
    )
    expect(fresh.notModified).toBe(false)
  })

  it("answers not modified when the date is at or after the last change", () => {
    expect(
      freshnessOf(tagsOf(stamp), conditions(undefined, "Wed, 01 May 2024 10:00:00 GMT"))
        .notModified
    ).toBe(true)
  })

  it("answers with the resource when the date is older than the last change", () => {
    expect(
      freshnessOf(tagsOf(stamp), conditions(undefined, "Wed, 01 May 2024 09:00:00 GMT"))
        .notModified
    ).toBe(false)
  })

  it("ignores a date it cannot read", () => {
    expect(
      freshnessOf(tagsOf(stamp), conditions(undefined, "yesterday")).notModified
    ).toBe(false)
  })

  it("answers with the resource when nothing is asked", () => {
    expect(freshnessOf(tagsOf(stamp), conditions()).status).toBe(200)
  })

  it("answers with the resource when no date can be derived", () => {
    const tags = tagsOf({ versionId: 1, lastUpdated: "never" })
    expect(
      freshnessOf(tags, conditions(undefined, "Wed, 01 May 2024 10:00:00 GMT"))
        .notModified
    ).toBe(false)
  })
})

describe("answers", () => {
  it("honours the negotiated representation on a resource", () => {
    const rep = served(choose(ask("application/json")))
    const answer = answerOf(rep, 200, { resourceType: "Patient", id: "p1" })
    expect(answer.status).toBe(200)
    expect(answer.headers["content-type"]).toBe("application/json; charset=utf-8")
    expect(answer.headers["content-length"]).toBe(String(answer.body.length))
    expect(answer.body).not.toContain("\n")
  })

  it("indents the body when the caller asked it to", () => {
    const rep = served(choose(ask(undefined, undefined, "true")))
    const answer = answerOf(rep, 200, { resourceType: "Bundle", type: "searchset" })
    expect(answer.body).toContain("\n")
    expect(answer.headers["content-type"]).toBe(`${FHIR_JSON}; charset=utf-8`)
  })

  it("carries the validators when they are given", () => {
    const answer = answerOf(DEFAULT, 200, { resourceType: "Patient" }, tagsOf(stamp))
    expect(answer.headers["etag"]).toBe('W/"3"')
    expect(answer.headers["last-modified"]).toBe("Wed, 01 May 2024 10:00:00 GMT")
  })

  it("leaves out a date it could not derive", () => {
    const tags = tagsOf({ versionId: 2, lastUpdated: "never" })
    const answer = answerOf(DEFAULT, 200, { resourceType: "Patient" }, tags)
    expect(answer.headers["etag"]).toBe('W/"2"')
    expect(answer.headers["last-modified"]).toBeUndefined()
  })

  it("refuses rather than serving json under a representation it cannot write", () => {
    const rep = deferred(choose(ask(FHIR_XML)))
    const answer = answerOf(rep, 200, { resourceType: "Patient" })
    expect(answer.status).toBe(NOT_ACCEPTABLE)
    expect(answer.headers["content-type"]).toBe(`${FHIR_JSON}; charset=utf-8`)
    expect(answer.body).toContain("OperationOutcome")
    expect(answer.body).not.toContain("Patient")
  })

  it("honours the representation on an error as well as a success", () => {
    const rep = served(choose(ask("application/json", undefined, "true")))
    const answer = outcomeOf(rep, new NotFound({ type: "Patient", id: "p1" }))
    expect(answer.status).toBe(404)
    expect(answer.headers["content-type"]).toBe("application/json; charset=utf-8")
    expect(answer.body).toContain("\n")
    expect(JSON.parse(answer.body)).toMatchObject({ resourceType: "OperationOutcome" })
  })

  it("renders a refusal as an outcome under the status it carries", () => {
    const refusal = refused(choose(ask("text/csv")))
    const answer = refusedOf(refusal)
    expect(answer.status).toBe(NOT_ACCEPTABLE)
    expect(answer.headers["content-type"]).toBe(`${FHIR_JSON}; charset=utf-8`)
    expect(JSON.parse(answer.body)).toMatchObject({ resourceType: "OperationOutcome" })
  })

  it("keeps the outcome status of a refusal that is not about the accept header", () => {
    const failure = new Rejected({ reason: "format not supported: yaml" })
    expect(refusedOf({ status: 400, failure }).status).toBe(400)
  })

  it("answers not modified with the validators and no body", () => {
    const answer = notModifiedOf(DEFAULT, tagsOf(stamp))
    expect(answer.status).toBe(NOT_MODIFIED)
    expect(answer.body).toBe("")
    expect(answer.headers["etag"]).toBe('W/"3"')
    expect(answer.headers["last-modified"]).toBe("Wed, 01 May 2024 10:00:00 GMT")
    expect(answer.headers["content-length"]).toBeUndefined()
  })
})
