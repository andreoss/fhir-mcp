import { describe, expect, it } from "vitest"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js"
import { PINNED_REVISION, capabilities, negotiate } from "./revision.js"

describe("protocol revision", () => {
  it("is pinned to the revision the documents name", () => {
    expect(PINNED_REVISION).toBe("2025-03-26")
  })

  it("is a revision the transport layer can actually speak", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(PINNED_REVISION)
  })

  it("answers a client asking for the pinned revision with that revision", () => {
    expect(negotiate(PINNED_REVISION)).toEqual({ agreed: PINNED_REVISION, asked: PINNED_REVISION })
  })

  it("answers a client asking for another revision with what is served", () => {
    expect(negotiate("2024-11-05")).toEqual({ agreed: PINNED_REVISION, asked: "2024-11-05" })
  })

  it("answers a client that names no revision", () => {
    expect(negotiate(undefined)).toEqual({ agreed: PINNED_REVISION, asked: undefined })
  })

  it("declares only capabilities that are served", () => {
    expect(capabilities()).toEqual({ tools: { listChanged: false } })
  })

  it("declares no capability this build does not implement", () => {
    const declared = Object.keys(capabilities())
    expect(declared).not.toContain("resources")
    expect(declared).not.toContain("prompts")
    expect(declared).not.toContain("logging")
  })
})
