import { createHash, timingSafeEqual } from "node:crypto"

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest()

export const digest = (value: string): string => sha256(value).toString("hex")

export const same = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b))
