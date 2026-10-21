/**
 * HTML sanitization for supplier descriptions (EC-056). Allowlist-based:
 * benign markup (`<p>`, `<br>`, `<b>`, lists, headings) survives; scripts,
 * styles, embeds die with their content; every attribute — event handlers,
 * `javascript:` URLs, inline styles — is dropped; anything else is
 * untrusted text and gets escaped. Sanitize on ingest, per the EC.
 */

const ALLOWED_TAGS: Record<string, true> = {
  p: true,
  br: true,
  b: true,
  strong: true,
  i: true,
  em: true,
  u: true,
  ul: true,
  ol: true,
  li: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
}

/** Tags whose entire content is code — dropped with everything inside. */
const DROP_WITH_CONTENT: Record<string, true> = {
  script: true,
  style: true,
  iframe: true,
  object: true,
  embed: true,
  template: true,
  noscript: true,
}

const SELF_CLOSING: Record<string, true> = { br: true }

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  deg: "\u00b0",
  plusmn: "\u00b1",
  euro: "\u20ac",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  laquo: "\u00ab",
  raquo: "\u00bb",
  szlig: "\u00df",
  auml: "\u00e4",
  ouml: "\u00f6",
  uuml: "\u00fc",
  Auml: "\u00c4",
  Ouml: "\u00d6",
  Uuml: "\u00dc",
  eacute: "\u00e9",
  egrave: "\u00e8",
  agrave: "\u00e0",
  ccedil: "\u00e7",
}

function decodeEntities(text: string): string {
  return text.replace(
    /&([a-z0-9]+|#\d+|#x[0-9a-f]+);/gi,
    (entity, body: string) => {
      const lowered = body.toLowerCase()
      if (lowered.startsWith("#x")) {
        const code = Number.parseInt(body.slice(2), 16)
        return Number.isSafeInteger(code) ? String.fromCodePoint(code) : entity
      }
      if (lowered.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10)
        return Number.isSafeInteger(code) ? String.fromCodePoint(code) : entity
      }
      const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[lowered]
      return named ?? entity
    }
  )
}

function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

/** True when a cell carries recognizable markup (per-cell sanitize decision). */
export function isLikelyHtml(text: string): boolean {
  return /<\/?(?:p|br|b|div|span|ul|ol|li|table|t[dhr]|thead|tbody|strong|em|i|u|h[1-6]|font|a|img|script|style|o:p)\b[\s\S]*?>/i.test(
    text
  )
}

export interface HtmlSanitizeResult {
  value: string
  /** True when anything was removed, closed, or escaped (worth a flag). */
  changed: boolean
}

/**
 * Sanitize one cell. Balanced allowlist markup passes through unchanged;
 * everything unsafe is removed or escaped. `changed` is false only for
 * already-clean input, so flags stay meaningful.
 */
export function sanitizeHtml(input: string): HtmlSanitizeResult {
  let out = ""
  let changed = false
  const openTags: string[] = []
  let index = 0

  while (index < input.length) {
    const nextTag = input.indexOf("<", index)
    if (nextTag === -1) {
      out += escapeText(decodeEntities(input.slice(index)))
      break
    }
    out += escapeText(decodeEntities(input.slice(index, nextTag)))
    index = nextTag

    if (input.startsWith("<!--", index)) {
      const end = input.indexOf("-->", index + 4)
      index = end === -1 ? input.length : end + 3
      changed = true
      continue
    }
    if (input.startsWith("<!", index) || input.startsWith("<?", index)) {
      const end = input.indexOf(">", index + 1)
      index = end === -1 ? input.length : end + 1
      changed = true
      continue
    }

    const closing = input.startsWith("</", index)
    const nameMatch = /^[a-z][a-z0-9]*/i.exec(
      input.slice(index + (closing ? 2 : 1))
    )
    if (!nameMatch) {
      // A lone `<` is text, not markup.
      out += "&lt;"
      index += 1
      changed = true
      continue
    }
    const name = nameMatch[0].toLowerCase()

    // Find the tag end, honoring quoted attribute values.
    let cursor = index + (closing ? 2 : 1) + name.length
    let inQuote: string | null = null
    let end = -1
    while (cursor < input.length) {
      const ch = input[cursor]!
      if (inQuote !== null) {
        if (ch === inQuote) inQuote = null
      } else if (ch === '"' || ch === "'") {
        inQuote = ch
      } else if (ch === ">") {
        end = cursor
        break
      }
      cursor++
    }
    if (end === -1) {
      // Unterminated tag: the rest is broken markup — keep it as text.
      out += escapeText(decodeEntities(input.slice(index)))
      changed = true
      break
    }
    const attrRegion = input.slice(index + (closing ? 2 : 1) + name.length, end)
    index = end + 1
    const hadAttrs =
      attrRegion.replaceAll(/["'][^"']*["']/g, "").trim().length > 0

    if (closing) {
      if (ALLOWED_TAGS[name] && openTags.includes(name)) {
        // Close intermediate opens so nesting stays balanced.
        while (openTags.length > 0) {
          const top = openTags.pop()!
          if (top === name) break
          out += `</${top}>`
          changed = true
        }
        out += `</${name}>`
      } else {
        changed = true // stray or disallowed closer: dropped
      }
      continue
    }

    if (DROP_WITH_CONTENT[name]) {
      const rest = input.slice(index)
      const closeMatch = new RegExp(`</${name}\\s*>`, "i").exec(rest)
      index = closeMatch
        ? index + closeMatch.index + closeMatch[0].length
        : input.length
      changed = true
      continue
    }
    if (!ALLOWED_TAGS[name]) {
      changed = true // disallowed tag dropped, its content survives
      continue
    }
    if (hadAttrs) changed = true // all attributes dropped
    if (SELF_CLOSING[name]) {
      out += `<${name}/>`
      continue
    }
    out += `<${name}>`
    openTags.push(name)
  }

  // Balance unclosed allowlist tags so downstream parsers see well-formed markup.
  while (openTags.length > 0) {
    out += `</${openTags.pop()}>`
    changed = true
  }
  return { value: out, changed }
}
