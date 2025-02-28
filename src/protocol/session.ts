import type { ClientCapabilities, LoggingLevel } from "@modelcontextprotocol/sdk/types.js"

export type RequestId = string | number

const SEVERITY: Readonly<Record<LoggingLevel, number>> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7
}

export class Session {
  private cancelled = new Set<RequestId>()

  private subscribed = new Set<string>()

  private level: LoggingLevel = "debug"

  sampling = false

  adopt(capabilities: ClientCapabilities): void {
    this.sampling = capabilities.sampling !== undefined
  }

  setLogLevel(level: LoggingLevel): void {
    this.level = level
  }

  canLog(level: LoggingLevel): boolean {
    return (SEVERITY[level] ?? 7) >= SEVERITY[this.level]
  }

  cancel(id: RequestId): void {
    this.cancelled.add(id)
  }

  isCancelled(id: RequestId): boolean {
    return this.cancelled.has(id)
  }

  subscribe(uri: string): void {
    this.subscribed.add(uri)
  }

  unsubscribe(uri: string): void {
    this.subscribed.delete(uri)
  }

  isSubscribed(uri: string): boolean {
    return this.subscribed.has(uri)
  }
}