import { afterEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { createServer } from "node:net"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { request } from "node:https"
import type { TLSSocket } from "node:tls"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Effect, Exit, Scope } from "effect"
import { start } from "./main.js"
import type { Running } from "./main.js"
import { asConfigured, modeOf } from "./tls.js"

const ORIGIN = "https://client.example"
const CONFIG_FILE = "openssl.cnf"
const CONFIG = "[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=localhost\n"

const run = promisify(execFile)

const issued = async (): Promise<{ readonly dir: string; readonly cert: string; readonly key: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "fhir-terminus-"))
  const conf = join(dir, CONFIG_FILE)
  await writeFile(conf, CONFIG, "utf8")
  const key = join(dir, "key.pem")
  const cert = join(dir, "cert.pem")
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "2",
    "-subj",
    "/CN=localhost",
    "-config",
    conf,
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-addext",
    "basicConstraints=critical,CA:TRUE"
  ])
  return { dir, cert, key }
}

const free = async (): Promise<number> => {
  const probe = createServer()
  const port = await new Promise<number>((done) => {
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      done(typeof address === "object" && address !== null ? address.port : 0)
    })
  })
  await new Promise<void>((done) => probe.close(() => done()))
  return port
}

const live: Array<{ readonly running: Running; readonly stop: () => Promise<void> }> = []

const started = async (env: Record<string, string | undefined>) => {
  const scope = Effect.runSync(Scope.make())
  const exit = await Effect.runPromiseExit(
    start(env).pipe(Effect.provideService(Scope.Scope, scope))
  )
  if (Exit.isFailure(exit)) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    const failure = exit.cause
    if (failure._tag !== "Fail") throw new Error("the start died")
    throw failure.error
  }
  const held = {
    running: exit.value,
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void))
  }
  live.push(held)
  return held
}

afterEach(async () => {
  while (live.length > 0) {
    const held = live.pop()
    if (held !== undefined) await held.stop()
  }
})

const spoken = (
  port: number,
  cert: string,
  body: unknown
): Promise<{ readonly text: string; readonly subject: string }> =>
  new Promise((resolve, reject) => {
    const sent = JSON.stringify(body)
    const asked = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        ca: cert,
        headers: {
          origin: ORIGIN,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(sent))
        }
      },
      (answer) => {
        const held = answer.socket as unknown as TLSSocket | null
        const subject = held === null ? "" : String(held.getPeerCertificate().subject.CN)
        let text = ""
        answer.setEncoding("utf8")
        answer.on("data", (chunk: string) => {
          text += chunk
        })
        answer.on("end", () => resolve({ text, subject }))
      }
    )
    asked.on("error", reject)
    asked.end(sent)
  })

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "probe", version: "0" }
  }
}

describe("HOST-09 a transport mode that terminates encryption", () => {
  it("answers an exchange over tls with the certificate it was given", async () => {
    const { dir, cert, key } = await issued()
    const held = await started({
      FHIR_TRANSPORT: "https",
      FHIR_HTTP_ORIGINS: ORIGIN,
      FHIR_HTTP_PORT: String(await free()),
      FHIR_TLS_CERT_FILE: cert,
      FHIR_TLS_KEY_FILE: key
    })
    expect(held.running.mode).toBe("https")
    const port = held.running.endpoint?.port ?? 0
    const answered = await spoken(port, await readFile(cert, "utf8"), INITIALIZE)
    expect(answered.subject).toBe("localhost")
    expect(JSON.parse(answered.text).result.serverInfo.name).toBe("fhir-mcp")
    await rm(dir, { recursive: true, force: true })
  })

  it("refuses a plaintext request on a listener that terminates tls", async () => {
    const { dir, cert, key } = await issued()
    const held = await started({
      FHIR_TRANSPORT: "https",
      FHIR_HTTP_ORIGINS: ORIGIN,
      FHIR_HTTP_PORT: String(await free()),
      FHIR_TLS_CERT_FILE: cert,
      FHIR_TLS_KEY_FILE: key
    })
    const port = held.running.endpoint?.port ?? 0
    await expect(
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(INITIALIZE)
      })
    ).rejects.toBeDefined()
    await rm(dir, { recursive: true, force: true })
  })

  it("says what is missing when https is asked for without a key", async () => {
    const { dir, cert } = await issued()
    await expect(
      started({
        FHIR_TRANSPORT: "https",
        FHIR_HTTP_ORIGINS: ORIGIN,
        FHIR_HTTP_PORT: String(await free()),
        FHIR_TLS_CERT_FILE: cert
      })
    ).rejects.toThrow("FHIR_TLS_KEY_FILE")
    await rm(dir, { recursive: true, force: true })
  })

  it("reads the mode from the transport it was asked for", () => {
    expect(modeOf({ FHIR_TRANSPORT: "https" })).toBe("https")
    expect(modeOf({ FHIR_TRANSPORT: "http" })).toBe("http")
    expect(modeOf({})).toBe("stdio")
    expect(asConfigured({ FHIR_TRANSPORT: "https" }, "https")["FHIR_TRANSPORT"]).toBe("http")
    expect(asConfigured({ FHIR_TRANSPORT: "stdio" }, "stdio")["FHIR_TRANSPORT"]).toBe("stdio")
  })
})
