/**
 * How a baked artifact is written to disk.
 *
 * `JSON.stringify(x, null, 2)` would put every coordinate of every brush on its
 * own line and turn a hundred-brush map into four thousand of them, which makes
 * a diff useless and a review impossible. So: a value stays on one line while
 * it fits, and a vector stays a vector.
 *
 * Shared by `bake-map.ts` and `nav-bake.ts` because both write artifacts a
 * human is expected to read in a pull request, and two formatters would mean
 * two answers to "why did this whole file change".
 */

/** How wide a rendered *value* may get before it is broken across lines. */
const LINE_BUDGET = 100

function inlineJson(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    const parts = value.map(inlineJson)
    if (parts.some((p) => p === null)) return null
    return `[${parts.join(', ')}]`
  }
  const parts: string[] = []
  for (const [key, item] of Object.entries(value)) {
    const rendered = inlineJson(item)
    if (rendered === null) return null
    parts.push(`${JSON.stringify(key)}: ${rendered}`)
  }
  return `{ ${parts.join(', ')} }`
}

/**
 * Render `value` at `indent`, inline if it fits inside {@link LINE_BUDGET}.
 *
 * A long flat array of numbers — a routing table, a visibility bitset — is
 * broken across lines *by element*, which keeps a diff pointed at the entries
 * that moved instead of at the whole table.
 */
export function renderJson(value: unknown, indent: string): string {
  const inline = inlineJson(value)
  if (inline !== null && indent.length + inline.length <= LINE_BUDGET) return inline

  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.every((item) => typeof item === 'number')) return renderNumbers(value, inner, indent)
    const items = value.map((item) => `${inner}${renderJson(item, inner)}`)
    return `[\n${items.join(',\n')}\n${indent}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return '{}'
    const items = entries.map(
      ([key, item]) => `${inner}${JSON.stringify(key)}: ${renderJson(item, inner)}`,
    )
    return `{\n${items.join(',\n')}\n${indent}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * A long run of numbers, wrapped at the line budget rather than one per line.
 *
 * A 3969-entry routing table is four thousand lines the other way, and nobody
 * reviews four thousand lines. Wrapped, it is forty, and a table whose shape
 * changed still shows up as a handful of them.
 */
function renderNumbers(value: readonly number[], inner: string, indent: string): string {
  const lines: string[] = []
  let line = ''
  for (let i = 0; i < value.length; i += 1) {
    const part = `${JSON.stringify(value[i])}${i === value.length - 1 ? '' : ','}`
    if (line !== '' && inner.length + line.length + 1 + part.length > LINE_BUDGET) {
      lines.push(inner + line)
      line = part
    } else {
      line = line === '' ? part : `${line} ${part}`
    }
  }
  if (line !== '') lines.push(inner + line)
  return `[\n${lines.join('\n')}\n${indent}]`
}

/** An artifact as the bytes that go on disk. Stable: same value, same file. */
export function serializeJson(value: unknown): string {
  return `${renderJson(value, '')}\n`
}
