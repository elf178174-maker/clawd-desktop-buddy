// Validates tool arguments against the JSON-schema subset the tools use. Unknown properties are
// rejected so a confused model gets a precise error instead of silently ignored input.

import type { JsonSchema } from './types'

export function validateArgs(schema: JsonSchema, value: unknown, path = 'arguments'): string[] {
  const errors: string[] = []
  const t = schema.type
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path} must be an object`]
    const obj = value as Record<string, unknown>
    for (const r of schema.required ?? []) if (obj[r] === undefined || obj[r] === null) errors.push(`${path}.${r} is required`)
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k]
      if (!sub) {
        if (schema.additionalProperties === false || schema.properties) errors.push(`${path}.${k} is not a known parameter`)
        continue
      }
      if (v === undefined || v === null) continue
      errors.push(...validateArgs(sub, v, `${path}.${k}`))
    }
    return errors
  }
  if (t === 'string') {
    if (typeof value !== 'string') return [`${path} must be a string`]
    if (schema.maxLength && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength} characters`)
  } else if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path} must be a number`]
    if (t === 'integer' && !Number.isInteger(value)) errors.push(`${path} must be an integer`)
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`)
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') return [`${path} must be true or false`]
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    if (schema.maxItems && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`)
    if (schema.items) value.forEach((v, i) => errors.push(...validateArgs(schema.items!, v, `${path}[${i}]`)))
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) errors.push(`${path} must be one of: ${schema.enum.join(', ')}`)
  return errors
}

/** Lenient coercion for common model mistakes ("5" for 5, "true" for true) before validation. */
export function coerceArgs(schema: JsonSchema, value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value }
  for (const [k, sub] of Object.entries(schema.properties ?? {})) {
    const v = out[k]
    if (typeof v === 'string') {
      if ((sub.type === 'number' || sub.type === 'integer') && v.trim() !== '' && Number.isFinite(Number(v))) out[k] = Number(v)
      else if (sub.type === 'boolean' && (v === 'true' || v === 'false')) out[k] = v === 'true'
    }
  }
  return out
}
