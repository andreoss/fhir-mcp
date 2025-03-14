type Value = unknown

const isObject = (value: Value): value is Record<string, Value> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const merge = (into: Record<string, Value>, from: Record<string, Value>): Record<string, Value> => {
  for (const [name, value] of Object.entries(from)) {
    const existing = into[name]
    if (Array.isArray(existing) && Array.isArray(value)) {
      into[name] = existing.map((item, index) =>
        isObject(item) && isObject(value[index]) ? merge({ ...item }, value[index]) : (value[index] ?? item)
      )
    } else if (isObject(existing) && isObject(value)) {
      into[name] = merge({ ...existing }, value)
    } else {
      into[name] = value
    }
  }
  return into
}

const pick = (value: Value, path: ReadonlyArray<string>): Value | undefined => {
  if (path.length === 0) return value
  if (Array.isArray(value)) {
    const kept = value.map((item) => pick(item, path)).filter((item) => item !== undefined)
    return kept.length === 0 ? undefined : kept
  }
  if (!isObject(value)) return undefined
  const [head, ...rest] = path
  const name = head as string
  const inner = pick(value[name], rest)
  return inner === undefined ? undefined : { [name]: inner }
}

export const keep = (
  resource: Record<string, Value>,
  paths: ReadonlyArray<string>
): Record<string, Value> => {
  if (paths.length === 0) return resource
  const base: Record<string, Value> = { resourceType: resource["resourceType"] }
  if (resource["id"] !== undefined) base["id"] = resource["id"]
  for (const path of paths) {
    const part = pick(resource, path.split("."))
    if (isObject(part)) merge(base, part)
  }
  return base
}
