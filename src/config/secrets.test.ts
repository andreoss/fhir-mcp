import { describe, expect, it } from "vitest"
import { open, seal, unseal } from "./secrets.js"
import { SecretRefused, isSealed } from "./secrets.js"

const KEY = "never-committed-test-key-9f8e"

describe("secrets at rest", () => {
  it("stores a secret as ciphertext that hides the plain value", () => {
    const stored = seal("bearer-token", KEY)
    expect(stored.startsWith("enc:v1:")).toBe(true)
    expect(stored).not.toContain("bearer-token")
  })

  it("decrypts the stored value only with the sealing key", () => {
    const stored = seal("bearer-token", KEY)
    expect(unseal(stored, KEY)).toBe("bearer-token")
  })

  it("refuses the wrong key instead of guessing", () => {
    const stored = seal("bearer-token", KEY)
    expect(() => unseal(stored, "another-key")).toThrow(SecretRefused)
  })

  it("refuses to open a sealed value with no key set", () => {
    const stored = seal("bearer-token", KEY)
    expect(() => open(stored, undefined)).toThrow(SecretRefused)
  })

  it("passes an unsealed value through untouched", () => {
    expect(open("plain-token", KEY)).toBe("plain-token")
    expect(isSealed("plain-token")).toBe(false)
  })

  it("refuses a sealed value that is malformed", () => {
    expect(() => unseal("enc:v1:not-a-real-seal", KEY)).toThrow(SecretRefused)
  })
})