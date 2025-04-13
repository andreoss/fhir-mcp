import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { generateKeyPairSync } from "node:crypto"
import { Unavailable } from "../core/outcome.js"
import type { Denial } from "./failure.js"
import { discover, keys, origin, WELL_KNOWN } from "./discovery.js"
import type { Metadata, Pin } from "./discovery.js"
import type { Jwk } from "./jwk.js"
import { thumbprint } from "./jwk.js"
import { Net } from "./ports.js"
import type { Answer } from "./ports.js"

const ISSUER = "https://issuer.example"
const SERVER = "https://issuer.example/v1/mcp"
const METADATA = `${ISSUER}${WELL_KNOWN}`
const JWKS = `${ISSUER}/jwks`

const net = (map: Readonly<Record<string, Answer>>) =>
  Layer.succeed(Net, {
    get: (url: string) => {
      const found = map[url]
      return found === undefined
        ? Effect.fail(new Unavailable({ dependency: "issuer" }))
        : Effect.succeed(found)
    }
  })

const value = <A>(exit: Exit.Exit<A, Denial>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected a value, got ${JSON.stringify(exit)}`)
}

const denial = <A>(exit: Exit.Exit<A, Denial>): Denial => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error
  throw new Error("expected a refusal")
}

const published = (): Jwk =>
  generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" }) as Jwk

const printed = (jwk: Jwk): string => {
  const exit = Effect.runSyncExit(thumbprint(jwk))
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error("expected a thumbprint")
}

const one = published()
const other = published()
const pin: Pin = { issuer: ISSUER, thumbprints: [printed(one)] }

const document = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  jwks_uri: JWKS,
  code_challenge_methods_supported: ["S256"]
}

const served = (url: string, body: unknown, status = 200): Answer => ({ status, url, body })

const found = (map: Readonly<Record<string, Answer>>, server = SERVER) =>
  Effect.runSyncExit(Effect.provide(discover(server, pin), net(map)))

const shape = (jwks: string | undefined): Metadata => ({
  issuer: ISSUER,
  authorization: `${ISSUER}/authorize`,
  token: `${ISSUER}/token`,
  registration: undefined,
  jwks,
  methods: ["S256"]
})

const keyed = (map: Readonly<Record<string, Answer>>, jwks: string | undefined = JWKS) =>
  Effect.runSyncExit(Effect.provide(keys(shape(jwks), pin), net(map)))

describe("authorization base address", () => {
  it("discards the path of the server address", () => {
    expect(value(Effect.runSyncExit(origin(SERVER)))).toBe(ISSUER)
  })

  it("keeps a port that is not the default one", () => {
    expect(value(Effect.runSyncExit(origin("https://issuer.example:8443/mcp")))).toBe("https://issuer.example:8443")
  })

  it("refuses a plain address", () => {
    expect(denial(Effect.runSyncExit(origin("http://issuer.example/mcp")))._tag).toBe("Rejected")
  })

  it("refuses text that is not an address", () => {
    expect(denial(Effect.runSyncExit(origin("issuer.example")))._tag).toBe("Rejected")
  })
})

describe("issuer metadata discovery", () => {
  it("takes the endpoints from the document the issuer serves", () => {
    const metadata = value(found({ [METADATA]: served(METADATA, document) }))
    expect(metadata.issuer).toBe(ISSUER)
    expect(metadata.authorization).toBe(`${ISSUER}/authorize`)
    expect(metadata.token).toBe(`${ISSUER}/token`)
    expect(metadata.registration).toBe(`${ISSUER}/register`)
    expect(metadata.jwks).toBe(JWKS)
  })

  it("falls back to the paths the revision defines when there is no document", () => {
    const metadata = value(found({ [METADATA]: served(METADATA, undefined, 404) }))
    expect(metadata.authorization).toBe(`${ISSUER}/authorize`)
    expect(metadata.token).toBe(`${ISSUER}/token`)
    expect(metadata.registration).toBe(`${ISSUER}/register`)
    expect(metadata.jwks).toBeUndefined()
  })

  it("refuses a plain discovery address", () => {
    const plain = "http://issuer.example/.well-known/oauth-authorization-server"
    const refusal = denial(found({ [plain]: served(plain, document) }, "http://issuer.example/v1/mcp"))
    expect(refusal._tag).toBe("Rejected")
  })

  it("refuses a document that names another issuer", () => {
    const refusal = denial(found({
      [METADATA]: served(METADATA, { ...document, issuer: "https://elsewhere.example" })
    }))
    expect(refusal._tag).toBe("Rejected")
  })

  it("refuses a document carrying a plain endpoint", () => {
    const refusal = denial(found({
      [METADATA]: served(METADATA, { ...document, token_endpoint: "http://issuer.example/token" })
    }))
    expect(refusal._tag).toBe("Rejected")
  })

  it("refuses a document that does not offer the required proof key method", () => {
    const refusal = denial(found({
      [METADATA]: served(METADATA, { ...document, code_challenge_methods_supported: ["plain"] })
    }))
    expect(refusal._tag).toBe("Rejected")
  })

  it("refuses a document answered from another origin", () => {
    const refusal = denial(found({
      [METADATA]: served("https://elsewhere.example/.well-known/oauth-authorization-server", document)
    }))
    expect(refusal._tag).toBe("Rejected")
  })

  it("refuses a document that is not the shape the standard states", () => {
    const refusal = denial(found({ [METADATA]: served(METADATA, { issuer: ISSUER }) }))
    expect(refusal._tag).toBe("Rejected")
  })

  it("reports the issuer unavailable when the address does not answer", () => {
    expect(denial(found({}))._tag).toBe("Unavailable")
  })

  it("reports the issuer unavailable when the answer is neither served nor absent", () => {
    expect(denial(found({ [METADATA]: served(METADATA, undefined, 500) }))._tag).toBe("Unavailable")
  })
})

describe("issuer key discovery", () => {
  it("takes the keys the pin allows, named by their identifier", () => {
    const set = value(keyed({ [JWKS]: served(JWKS, { keys: [{ ...one, kid: "k1" }] }) }))
    expect([...set.keys()]).toEqual(["k1"])
    expect(set.get("k1")?.asymmetricKeyType).toBe("rsa")
  })

  it("names a key by its thumbprint when the issuer gave it no identifier", () => {
    const set = value(keyed({ [JWKS]: served(JWKS, { keys: [one] }) }))
    expect([...set.keys()]).toEqual([printed(one)])
  })

  it("refuses a key that was not pinned", () => {
    const refusal = denial(keyed({ [JWKS]: served(JWKS, { keys: [{ ...other, kid: "k2" }] }) }))
    expect(refusal._tag).toBe("Rejected")
  })

  it("refuses the whole set when one key was not pinned", () => {
    const refusal = denial(keyed({
      [JWKS]: served(JWKS, { keys: [{ ...one, kid: "k1" }, { ...other, kid: "k2" }] })
    }))
    expect(refusal._tag).toBe("Rejected")
  })

  it("refuses a symmetric key the issuer offers", () => {
    const refusal = denial(keyed({
      [JWKS]: served(JWKS, { keys: [{ kty: "oct", k: "c2VjcmV0", kid: "k1", alg: "HS256" }] })
    }))
    expect(refusal._tag).toBe("Rejected")
  })

  it("refuses a key set at a plain address", () => {
    const plain = "http://issuer.example/jwks"
    const refusal = denial(keyed({ [plain]: served(plain, { keys: [one] }) }, plain))
    expect(refusal._tag).toBe("Rejected")
  })

  it("refuses a key set at another origin than the issuer", () => {
    const away = "https://keys.elsewhere.example/jwks"
    const refusal = denial(keyed({ [away]: served(away, { keys: [one] }) }, away))
    expect(refusal._tag).toBe("Rejected")
  })

  it("refuses a key set answered from another origin", () => {
    const refusal = denial(keyed({ [JWKS]: served("https://elsewhere.example/jwks", { keys: [one] }) }))
    expect(refusal._tag).toBe("Rejected")
  })

  it("refuses an issuer that publishes no key set", () => {
    const exit = Effect.runSyncExit(Effect.provide(keys(shape(undefined), pin), net({})))
    expect(denial(exit)._tag).toBe("Rejected")
  })

  it("refuses a key set that is empty or not the stated shape", () => {
    expect(denial(keyed({ [JWKS]: served(JWKS, { keys: [] }) }))._tag).toBe("Rejected")
    expect(denial(keyed({ [JWKS]: served(JWKS, { key: one }) }))._tag).toBe("Rejected")
  })

  it("reports the key set unavailable when it does not answer", () => {
    expect(denial(keyed({}))._tag).toBe("Unavailable")
    expect(denial(keyed({ [JWKS]: served(JWKS, undefined, 404) }))._tag).toBe("Unavailable")
  })
})
