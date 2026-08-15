/**
 * The credits screen.
 *
 * It reads `/credits.json` — the machine-readable file `pnpm assets:build`
 * generates from the registry — rather than a list written out here. Two lists
 * of the same assets would be two lists that disagree, and the one that goes
 * stale is always the one a person has to remember to edit.
 *
 * Fetched on first open, not at boot. Nobody opens the credits during a duel,
 * and a request at boot is a request in front of the first frame.
 *
 * The menu this eventually lives behind is GLAD-NPCTU8's. Until there is one,
 * `C` opens it and `Escape` closes it, and `?credits=1` opens it on load so the
 * screen can be looked at without playing a round first.
 */

/** One line of the credits, exactly as the generated file carries it. */
export type CreditsEntry = {
  readonly id: string
  readonly title: string
  readonly author: string
  readonly source: string
  readonly licence: string
  readonly kind: string
}

export type CreditsDocument = { readonly entries: readonly CreditsEntry[] }

/** Where the generated file is served from. */
export const CREDITS_URL = '/credits.json'

const HEADINGS: ReadonlyArray<readonly [kind: string, heading: string]> = [
  ['model', 'Models'],
  ['texture', 'Textures'],
  ['vendored', 'Vendored code'],
]

/**
 * Parse what the server sent.
 *
 * Defensive because it is a *file*, and a file can be stale, half-deployed, or
 * a 404 page an edge proxy decided to serve with a 200. A credits screen is not
 * worth an exception that takes the page with it.
 */
export function parseCredits(raw: unknown): CreditsDocument {
  if (raw === null || typeof raw !== 'object') return { entries: [] }
  const entries = (raw as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return { entries: [] }

  const parsed: CreditsEntry[] = []
  for (const item of entries) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const strings = ['id', 'title', 'author', 'source', 'licence', 'kind'] as const
    if (strings.some((key) => typeof record[key] !== 'string')) continue
    parsed.push({
      id: record['id'] as string,
      title: record['title'] as string,
      author: record['author'] as string,
      source: record['source'] as string,
      licence: record['licence'] as string,
      kind: record['kind'] as string,
    })
  }
  return { entries: parsed }
}

/** Group into the sections the screen shows, in a fixed order. */
export function creditsSections(
  document: CreditsDocument,
): ReadonlyArray<{ readonly heading: string; readonly entries: readonly CreditsEntry[] }> {
  const sections = HEADINGS.map(([kind, heading]) => ({
    heading,
    entries: document.entries.filter((entry) => entry.kind === kind),
  })).filter((section) => section.entries.length > 0)

  // Anything with a kind this screen does not know about still gets shown. A
  // credit that is silently dropped is worse than one in the wrong section.
  const known = new Set(HEADINGS.map(([kind]) => kind))
  const rest = document.entries.filter((entry) => !known.has(entry.kind))
  return rest.length > 0 ? [...sections, { heading: 'Everything else', entries: rest }] : sections
}

export type CreditsScreen = {
  open(): void
  close(): void
  toggle(): void
  readonly isOpen: boolean
}

function render(root: HTMLElement, sections: ReturnType<typeof creditsSections>): void {
  root.innerHTML = ''

  const heading = document.createElement('h1')
  heading.className = 'credits-title'
  heading.textContent = 'Credits'
  root.append(heading)

  const preamble = document.createElement('p')
  preamble.className = 'credits-preamble'
  preamble.textContent =
    'Everything Gladiator ships, and where it came from. Content is CC0; the vendored code carries its own licence.'
  root.append(preamble)

  for (const section of sections) {
    const group = document.createElement('section')
    group.className = 'credits-section'
    group.dataset['credits'] = section.heading

    const title = document.createElement('h2')
    title.textContent = section.heading
    group.append(title)

    for (const entry of section.entries) {
      const row = document.createElement('div')
      row.className = 'credits-row'
      row.dataset['creditId'] = entry.id

      const name = document.createElement('a')
      name.className = 'credits-name'
      name.href = entry.source
      name.rel = 'noreferrer noopener'
      name.target = '_blank'
      name.textContent = entry.title
      row.append(name)

      const by = document.createElement('span')
      by.className = 'credits-author'
      by.textContent = entry.author
      row.append(by)

      const licence = document.createElement('span')
      licence.className = 'credits-licence'
      licence.textContent = entry.licence
      row.append(licence)

      group.append(row)
    }

    root.append(group)
  }

  const close = document.createElement('p')
  close.className = 'credits-close'
  close.textContent = 'Escape to close'
  root.append(close)
}

/**
 * Mount the screen, hidden, and hand back the handle that opens it.
 *
 * `load` is injected so the tests can drive the whole screen without a network
 * — and so a fetch that fails shows a line saying so rather than an empty
 * panel that looks like there is nothing to credit.
 */
export function createCreditsScreen(
  parent: HTMLElement,
  load: () => Promise<unknown> = async () => {
    const response = await fetch(CREDITS_URL)
    if (!response.ok) throw new Error(`${CREDITS_URL} answered ${response.status}`)
    return await response.json()
  },
): CreditsScreen {
  const root = document.createElement('div')
  root.id = 'credits'
  root.hidden = true
  parent.append(root)

  let loaded = false
  let open = false

  const fill = () => {
    if (loaded) return
    loaded = true
    load().then(
      (raw) => {
        render(root, creditsSections(parseCredits(raw)))
      },
      (cause: unknown) => {
        loaded = false
        root.textContent = `Could not load the credits: ${String(cause)}`
      },
    )
  }

  const screen: CreditsScreen = {
    open() {
      open = true
      root.hidden = false
      fill()
    },
    close() {
      open = false
      root.hidden = true
    },
    toggle() {
      if (open) screen.close()
      else screen.open()
    },
    get isOpen() {
      return open
    },
  }

  return screen
}

/** `?credits=1` — open it on load, so the screen can be looked at directly. */
export function creditsRequested(search: string): boolean {
  return new URLSearchParams(search).get('credits') === '1'
}
