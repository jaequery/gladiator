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
 * `C` opens it, `Escape` and the Close button close it, and `?credits=1` opens
 * it on load so the screen can be looked at without playing a round first.
 *
 * ## Two rules, because this panel covers the whole page
 *
 * `#credits` is opaque and `inset: 0`, so while it is up it *is* the page.
 * Everything below follows from that, and both halves were GLAD-G42FEB — a
 * black screen with nothing on it but the cursor:
 *
 *   1. **The way out is always drawn.** It sits outside the part a re-render
 *      clears, so it survives a fetch that fails and a fetch that never lands.
 *      A keyboard shortcut alone is not a way out: the menu used to swallow
 *      Escape before the window ever saw it (`ui/menu.ts`), and the player who
 *      opened this from the menu had nothing left but a reload.
 *   2. **The body is never empty.** Opening starts a fetch, and until it
 *      answers there is nothing to draw — which on a slow link is a full-screen
 *      sheet of near-black with no content and no explanation. It says what it
 *      is waiting for instead.
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
  ['audio', 'Audio'],
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

/**
 * The one line the body carries while it has nothing else.
 *
 * Named rather than written inline because it is rule 2 in this file's header
 * made concrete: it is what stands between opening this panel and a full-screen
 * sheet of near-black with nothing on it. `scripts/e2e.mjs` asserts the body is
 * never empty; this is what it finds there before the fetch lands.
 */
export const CREDITS_LOADING = 'Loading the credits…'

/** A single line in the body, for the states that have nothing to list. */
function renderNote(body: HTMLElement, text: string): void {
  body.innerHTML = ''
  const note = document.createElement('p')
  note.className = 'credits-preamble'
  note.dataset['credits'] = 'note'
  note.textContent = text
  body.append(note)
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
  // Both routes, because the point of rule 1 is that there is more than one.
  close.textContent = 'Escape, or the Close button, to leave'
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

  // Rule 1: outside `body`, so no re-render can take it away, and drawn before
  // anything that has to be fetched. A player must be able to leave this panel
  // with the mouse they opened it with.
  const bar = document.createElement('div')
  bar.className = 'credits-bar'
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'menu-button credits-close-button'
  closeButton.dataset['hud'] = 'credits-close'
  closeButton.textContent = 'Close'
  closeButton.addEventListener('click', () => {
    screen.close()
  })
  bar.append(closeButton)

  const body = document.createElement('div')
  body.className = 'credits-body'
  root.append(bar, body)
  parent.append(root)

  let loaded = false
  let open = false

  const fill = () => {
    if (loaded) return
    loaded = true
    // Rule 2. The fetch is a network round trip and this panel is opaque, so
    // the gap between opening and answering is a black page unless it says
    // what it is doing.
    renderNote(body, CREDITS_LOADING)
    load().then(
      (raw) => {
        render(body, creditsSections(parseCredits(raw)))
      },
      (cause: unknown) => {
        loaded = false
        renderNote(body, `Could not load the credits: ${String(cause)}`)
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
