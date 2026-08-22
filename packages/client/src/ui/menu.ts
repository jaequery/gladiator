/**
 * Everything around the match: the menu, the room-code flow, and the settings.
 *
 * ## It is a view over a state machine it does not own
 *
 * Five screens — the menu, the join box, the room, the settings, and the pause
 * — and not one of them decides anything. Which screen is up is
 * {@link Menu.show}'s argument, the room code arrives through
 * {@link Menu.setRoom}, and every button is a call into {@link MenuHooks}.
 * `main.ts` owns the session and this owns the pixels, for the same reason
 * `ui/hud.ts` owns pixels and `ui/hudModel.ts` owns the projection: a menu that
 * could open a socket is a menu that can open a second one.
 *
 * ## The flow is one click deep
 *
 * A player who was sent a link has already done the hard part. So a room link
 * lands on the room screen with the code *already in the box*, connecting, and
 * the only thing left to do is the click every browser demands before it will
 * lock a pointer or start an audio context — which is the same click, on the
 * same button (`audio/gesture.ts`). Nothing is typed twice and nothing is
 * explained.
 *
 * ## Escape is not an error
 *
 * Pressing escape gives the mouse back; that is the browser's contract with the
 * player and this game does not fight it. What it must not do is *lose*
 * anything — so the pause screen is a screen over a match that is still
 * running, the settings behind it are the same live store, and resuming is one
 * click. Every browser refuses to re-lock for a moment after the player
 * released the lock themselves, which is why {@link Menu.setLockDenied} exists:
 * the honest response is to ask for another click, not to retry on a timer.
 */
import type { RawInput } from '../input/pointerLock.ts'
import { type CopyEnv, copyMessage, copyText } from './clipboard.ts'
import { formatRoomCode, readTypedCode } from './roomFlow.ts'
import {
  BOT_DIFFICULTIES,
  ROUNDS_TO_WIN_CHOICES,
  SELF_DAMAGE_CHOICES,
  SETTINGS_BOUNDS,
  type Settings,
  type SettingsStore,
  countsPer360,
  quakeSensitivity,
} from './settings.ts'

/** Which screen is up. `hidden` is a match with nothing in front of it. */
export type MenuScreen = 'hidden' | 'main' | 'join' | 'room' | 'settings' | 'paused'

export type MenuHooks = {
  /** Single-player: the host in this tab, and a bot to duel. */
  readonly startBot: () => void
  /** Ask the host for a new room. The code comes back in the welcome. */
  readonly createRoom: () => void
  /** Join the match this code names. */
  readonly joinRoom: (code: string) => void
  /**
   * Take the pointer lock and start the audio, from *this* click.
   *
   * Both need a user gesture and it has to be the same one, or the first rocket
   * is silent — `audio/gesture.ts` is the whole argument.
   */
  readonly enterArena: () => void
  /**
   * Where "back" goes.
   *
   * `main.ts`'s to answer rather than this module's, because the answer is
   * "the pause screen if there is a match behind you and the menu if there is
   * not", and which of those is true is a property of the session.
   */
  readonly back: () => void
  /** Leave the match and go back to a page with nothing in it. */
  readonly leave: () => void
  /** The live settings store. Written to directly by the settings screen. */
  readonly settings: SettingsStore
  /** The share link for a code, built from this page's own address. */
  readonly shareLink: (code: string) => string
  readonly copy: CopyEnv
  /** Open the credits screen. */
  readonly openCredits?: () => void
}

export type Menu = {
  show(screen: MenuScreen): void
  readonly screen: MenuScreen
  readonly isOpen: boolean
  /** The room this session ended up in, once the host has said. */
  setRoom(code: string | null): void
  /** The line under the room's code: joining, waiting, connected, refused. */
  setStatus(text: string): void
  /** Whether the browser is giving us raw mouse deltas. See `pointerLock.ts`. */
  setRawInput(state: RawInput): void
  /** A refused pointer lock, or `null` once one is held. */
  setLockDenied(reason: string | null): void
  /** Put a code in the join box without a player having typed it. */
  setTypedCode(code: string): void
  dispose(): void
}

/**
 * Whether a key pressed inside the menu stops here.
 *
 * Everything does, and for the reason {@link createMenu} states: a key that
 * went into a menu control is not a key in the game, so a `C` in a room code
 * must not open the credits and a space on a focused button must not also be a
 * jump. Both of those listen on the window, so the menu stops the event before
 * it gets there.
 *
 * **Escape is the exception, and it is not a nicety.** Escape is how a player
 * leaves whatever is in front of them, and the only code that knows what
 * "leaving" means — close the credits, step back a screen, resume the match —
 * is `main.ts`, on the window. Swallowing it left the menu eating the one key
 * that gets you out of a full-screen panel, and clicking `Credits` from the
 * menu leaves the focus on that button: the credits then covered the page at
 * 94% opacity, with no close control and a keyboard shortcut that could never
 * arrive. That is a page with no way off it, which is what GLAD-G42FEB was
 * reported as — a black screen with nothing on it but the cursor.
 *
 * Nothing is at risk in letting it through. Escape is not a movement key
 * (`input/controller.ts` binds WASD and space), and it does not type into a
 * room code.
 */
export function menuSwallowsKey(code: string): boolean {
  return code !== 'Escape'
}

/** What the settings screen says about the raw-input verdict. */
export function rawInputLabel(state: RawInput): string {
  if (state === 'granted') return 'raw — the operating system’s mouse acceleration is off'
  if (state === 'refused') return 'accelerated — this browser refused raw mouse input'
  return 'unknown — this browser does not report whether raw input was applied'
}

/**
 * The warning under it, or `null` when there is nothing to warn about.
 *
 * Shown for `unknown` as well as `refused`, because the two have the same
 * consequence for a player: the distance they set is not the distance their
 * hand travels, and it changes with how fast they move. Saying nothing until a
 * browser admits it would leave every WebKit player quietly mis-calibrated.
 */
export function rawInputWarning(state: RawInput): string | null {
  if (state === 'granted') return null
  return state === 'refused'
    ? 'Your operating system is still accelerating the mouse, so the same flick turns you further when you move faster, and cm/360 below is only exact at a steady speed. A Chromium browser gives raw input; docs/browser-support.md has the matrix.'
    : 'This browser cannot say whether it applied raw mouse input, so assume the operating system is still accelerating it: cm/360 below is then only exact at a steady speed. docs/browser-support.md has the matrix.'
}

function button(label: string, hud: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = 'menu-button'
  element.dataset['hud'] = hud
  element.textContent = label
  element.addEventListener('click', onClick)
  return element
}

/**
 * Assign only when the value changed.
 *
 * The same guard, for the same reason, as `client/src/hud.ts`: writing the same
 * string back into `textContent` still dirties the node, and a dirty node in
 * the overlay makes the browser recomposite the whole page on top of the
 * canvas. The pause screen sits over a match that is still being drawn, and it
 * is written from the session ten times a second — almost always with exactly
 * what is already there.
 */
function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value
}

function paragraph(text: string, className = 'menu-body'): HTMLParagraphElement {
  const element = document.createElement('p')
  element.className = className
  element.textContent = text
  return element
}

function screenOf(name: MenuScreen, heading: string): HTMLElement {
  const section = document.createElement('section')
  section.className = 'menu-screen'
  section.dataset['menu'] = name
  section.hidden = true
  const title = document.createElement('h2')
  title.className = 'menu-heading'
  title.textContent = heading
  section.append(title)
  return section
}

/** A labelled number, with a slider beside it. Both write the same setting. */
function slider(
  label: string,
  hud: string,
  bounds: { min: number; max: number },
  step: number,
  onInput: (value: number) => void,
): { readonly row: HTMLElement; set(value: number): void } {
  const row = document.createElement('div')
  row.className = 'menu-field'

  const name = document.createElement('label')
  name.className = 'menu-field-label'
  name.textContent = label

  const range = document.createElement('input')
  range.type = 'range'
  range.min = String(bounds.min)
  range.max = String(bounds.max)
  range.step = String(step)
  range.className = 'menu-range'

  const number = document.createElement('input')
  number.type = 'number'
  number.min = String(bounds.min)
  number.max = String(bounds.max)
  number.step = String(step)
  number.className = 'menu-number'
  number.dataset['hud'] = hud

  name.htmlFor = `menu-${hud}`
  number.id = `menu-${hud}`

  const read = (source: HTMLInputElement) => {
    const parsed = Number.parseFloat(source.value)
    if (Number.isFinite(parsed)) onInput(parsed)
  }
  range.addEventListener('input', () => read(range))
  // `change` rather than `input` for the typed field: `input` fires on every
  // keystroke, so typing "45" over "9" clamps to the minimum the instant the
  // box is empty and the player watches their number fight them.
  number.addEventListener('change', () => read(number))

  row.append(name, range, number)
  return {
    row,
    set(value) {
      const text = String(value)
      if (range.value !== text) range.value = text
      if (document.activeElement !== number && number.value !== text) number.value = text
    },
  }
}

export function createMenu(parent: HTMLElement, hooks: MenuHooks): Menu {
  const root = document.createElement('div')
  root.id = 'menu'
  root.dataset['hud'] = 'menu'
  root.hidden = true

  let screen: MenuScreen = 'hidden'

  // Nothing typed or pressed in here is also a key in the game. Without this,
  // a `C` in a room code opens the credits (`main.ts` listens on the window)
  // and a space on a focused button is both a press and a jump. Stopped at the
  // menu's own root rather than filtered further down, because the rule is
  // about *where* the key went and not about which key it was — with the one
  // exception {@link menuSwallowsKey} argues.
  const swallow = (event: KeyboardEvent) => {
    if (menuSwallowsKey(event.code)) event.stopPropagation()
  }
  root.addEventListener('keydown', swallow)
  root.addEventListener('keyup', swallow)

  /* --- the main menu ---------------------------------------------------- */

  const main = screenOf('main', 'Gladiator')
  main.append(
    paragraph(
      'A Rocket Arena duel: one small map, full health, no pickups, a rocket launcher and a railgun. First to three rounds.',
      'menu-lede',
    ),
    button('Play the bot', 'menu-bot', () => hooks.startBot()),
    button('Create a match', 'menu-create', () => hooks.createRoom()),
    button('Join with a code', 'menu-join-open', () => show('join')),
  )

  const footer = document.createElement('div')
  footer.className = 'menu-footer'
  footer.append(button('Settings', 'menu-settings-open', () => show('settings')))
  if (hooks.openCredits !== undefined) {
    footer.append(button('Credits', 'menu-credits', () => hooks.openCredits?.()))
  }
  main.append(footer)

  /* --- the join box ----------------------------------------------------- */

  const join = screenOf('join', 'Join a match')
  const codeInput = document.createElement('input')
  codeInput.type = 'text'
  codeInput.className = 'menu-code-input'
  codeInput.dataset['hud'] = 'menu-code-input'
  codeInput.placeholder = 'H7K-2Q9'
  codeInput.autocomplete = 'off'
  codeInput.spellcheck = false
  codeInput.maxLength = 16
  codeInput.setAttribute('aria-label', 'room code')

  const codeHint = paragraph('', 'menu-hint')
  codeHint.dataset['hud'] = 'menu-code-hint'
  const joinButton = button('Join', 'menu-join', () => submitCode())
  joinButton.disabled = true

  const submitCode = () => {
    const typed = readTypedCode(codeInput.value)
    if (typed.code === null) return
    hooks.joinRoom(typed.code)
  }

  const refreshCode = () => {
    const typed = readTypedCode(codeInput.value)
    joinButton.disabled = typed.code === null
    codeHint.textContent = typed.hint
  }
  codeInput.addEventListener('input', refreshCode)
  codeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitCode()
  })

  join.append(
    paragraph('Paste the code a friend sent you — or the whole link; either works.'),
    codeInput,
    codeHint,
    joinButton,
    button('Back', 'menu-join-back', () => hooks.back()),
  )

  /* --- the room: the code, the link, and the way in --------------------- */

  const roomScreen = screenOf('room', 'Your match')
  const roomCode = document.createElement('div')
  roomCode.className = 'menu-code'
  roomCode.dataset['hud'] = 'menu-room-code'
  roomCode.textContent = '······'

  const roomStatus = paragraph('opening a room…', 'menu-hint')
  roomStatus.dataset['hud'] = 'menu-room-status'

  const linkRow = document.createElement('div')
  linkRow.className = 'menu-link-row'
  const linkInput = document.createElement('input')
  linkInput.type = 'text'
  linkInput.className = 'menu-link'
  linkInput.dataset['hud'] = 'menu-room-link'
  linkInput.readOnly = true
  linkInput.setAttribute('aria-label', 'the link to this match')
  const copyButton = button('Copy the link', 'menu-copy', () => {
    void copyText(linkInput.value, hooks.copy).then((result) => {
      copyButton.textContent = copyMessage(result)
      copyButton.dataset['state'] = result === 'unavailable' ? 'manual' : 'copied'
      // Selected on both paths: on the failure path it is the only way to copy
      // it, and on the success path it shows what went on the clipboard.
      linkInput.select()
    })
  })
  linkRow.append(linkInput, copyButton)

  const enterButton = button('Enter the arena', 'menu-enter', () => hooks.enterArena())

  roomScreen.append(
    roomCode,
    roomStatus,
    paragraph('Send this link. Whoever opens it lands in this match.'),
    linkRow,
    enterButton,
    button('Leave', 'menu-room-leave', () => hooks.leave()),
  )

  /* --- the settings ----------------------------------------------------- */

  const settingsScreen = screenOf('settings', 'Settings')

  const sensitivity = slider('Sensitivity, cm/360', 'menu-cm360', SETTINGS_BOUNDS.cm360, 0.5, (value) => {
    hooks.settings.update({ cm360: value })
  })
  const dpi = slider('Mouse DPI', 'menu-dpi', SETTINGS_BOUNDS.dpi, 50, (value) => {
    hooks.settings.update({ dpi: value })
  })
  const fov = slider('Field of view', 'menu-fov', SETTINGS_BOUNDS.fovDegrees, 1, (value) => {
    hooks.settings.update({ fovDegrees: value })
  })

  const difficulty = document.createElement('fieldset')
  difficulty.className = 'menu-difficulty'
  const difficultyLegend = document.createElement('legend')
  difficultyLegend.className = 'menu-field-label'
  difficultyLegend.textContent = 'Bot difficulty'
  difficulty.append(difficultyLegend)
  const difficultyInputs = BOT_DIFFICULTIES.map((level) => {
    const choice = document.createElement('label')
    choice.className = 'menu-choice'
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'menu-bot-difficulty'
    input.value = level
    input.dataset['hud'] = `menu-difficulty-${level}`
    input.addEventListener('change', () => {
      if (input.checked) hooks.settings.update({ botDifficulty: level })
    })
    const name = level[0]?.toUpperCase() + level.slice(1)
    choice.append(input, document.createTextNode(name))
    difficulty.append(choice)
    return [level, input] as const
  })

  /* The match rules. `MatchRules` is hashed and agreed at tick zero, so these
   * are read when the next match is *created* and never while one is running —
   * the same contract the bot difficulty above already has. */
  const selfDamage = document.createElement('fieldset')
  selfDamage.className = 'menu-difficulty'
  const selfDamageLegend = document.createElement('legend')
  selfDamageLegend.className = 'menu-field-label'
  selfDamageLegend.textContent = 'Self-damage'
  selfDamage.append(selfDamageLegend)
  const selfDamageInputs = SELF_DAMAGE_CHOICES.map((choiceSpec) => {
    const choice = document.createElement('label')
    choice.className = 'menu-choice'
    choice.title = choiceSpec.hint
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'menu-self-damage'
    input.value = String(choiceSpec.mode)
    input.dataset['hud'] = `menu-self-damage-${String(choiceSpec.mode)}`
    input.addEventListener('change', () => {
      if (input.checked) hooks.settings.update({ selfDamage: choiceSpec.mode })
    })
    choice.append(input, document.createTextNode(choiceSpec.name))
    selfDamage.append(choice)
    return [choiceSpec.mode, input] as const
  })

  const rounds = document.createElement('fieldset')
  rounds.className = 'menu-difficulty'
  const roundsLegend = document.createElement('legend')
  roundsLegend.className = 'menu-field-label'
  roundsLegend.textContent = 'Rounds to win'
  rounds.append(roundsLegend)
  const roundsInputs = ROUNDS_TO_WIN_CHOICES.map((count) => {
    const choice = document.createElement('label')
    choice.className = 'menu-choice'
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'menu-rounds-to-win'
    input.value = String(count)
    input.dataset['hud'] = `menu-rounds-${String(count)}`
    input.addEventListener('change', () => {
      if (input.checked) hooks.settings.update({ roundsToWin: count })
    })
    choice.append(input, document.createTextNode(String(count)))
    rounds.append(choice)
    return [count, input] as const
  })

  const derived = paragraph('', 'menu-hint')
  derived.dataset['hud'] = 'menu-derived'

  const rawRow = document.createElement('p')
  rawRow.className = 'menu-hint'
  rawRow.dataset['hud'] = 'menu-raw'

  const rawWarning = document.createElement('p')
  rawWarning.className = 'menu-warning'
  rawWarning.dataset['hud'] = 'menu-raw-warning'
  rawWarning.hidden = true

  const diagnostics = document.createElement('label')
  diagnostics.className = 'menu-check'
  const diagnosticsBox = document.createElement('input')
  diagnosticsBox.type = 'checkbox'
  diagnosticsBox.dataset['hud'] = 'menu-diagnostics'
  diagnosticsBox.addEventListener('change', () => {
    hooks.settings.update({ diagnostics: diagnosticsBox.checked })
  })
  diagnostics.append(diagnosticsBox, document.createTextNode('Show the diagnostics panel'))

  settingsScreen.append(
    paragraph(
      'Sensitivity is the distance your hand travels to turn all the way round, which is the number that carries over from another game. It needs your mouse’s DPI to be right.',
    ),
    sensitivity.row,
    dpi.row,
    derived,
    rawRow,
    rawWarning,
    fov.row,
    difficulty,
    paragraph('Changes the opponent in your next bot match.', 'menu-hint'),
    selfDamage,
    rounds,
    paragraph(
      'The rules your next match is created with. Self-damage is what a rocket jump costs you — the push is the same in all four.',
      'menu-hint',
    ),
    diagnostics,
    paragraph('Kept in this browser.', 'menu-hint'),
    button('Back', 'menu-settings-back', () => hooks.back()),
  )

  /* --- the pause screen ------------------------------------------------- */

  const paused = screenOf('paused', 'Paused')
  const pauseHint = paragraph('The match is still running. Click to take the mouse back.', 'menu-hint')
  pauseHint.dataset['hud'] = 'menu-pause-hint'
  paused.append(
    pauseHint,
    button('Resume', 'menu-resume', () => hooks.enterArena()),
    button('Settings', 'menu-pause-settings', () => show('settings')),
    button('The room code', 'menu-pause-room', () => show('room')),
    button('Leave the match', 'menu-leave', () => hooks.leave()),
  )

  const screens: ReadonlyArray<readonly [MenuScreen, HTMLElement]> = [
    ['main', main],
    ['join', join],
    ['room', roomScreen],
    ['settings', settingsScreen],
    ['paused', paused],
  ]
  for (const [, element] of screens) root.append(element)
  parent.append(root)

  const applySettings = (settings: Settings) => {
    sensitivity.set(settings.cm360)
    dpi.set(settings.dpi)
    fov.set(settings.fovDegrees)
    for (const [level, input] of difficultyInputs) input.checked = settings.botDifficulty === level
    for (const [mode, input] of selfDamageInputs) input.checked = settings.selfDamage === mode
    for (const [count, input] of roundsInputs) input.checked = settings.roundsToWin === count
    diagnosticsBox.checked = settings.diagnostics
    // The two derived numbers, because a player who knows their real figure can
    // check the DPI field against them in one look — and because "counts per
    // 360" is what every sensitivity converter on the internet speaks.
    derived.textContent =
      `${Math.round(countsPer360(settings))} counts per 360°` +
      ` · Quake sensitivity ${quakeSensitivity(settings).toFixed(2)}`
  }
  applySettings(hooks.settings.value)
  hooks.settings.onChange(applySettings)

  function show(next: MenuScreen): void {
    screen = next
    root.hidden = next === 'hidden'
    for (const [name, element] of screens) element.hidden = name !== next
    // Focus is not decoration here: a player who has just been sent a link
    // arrives on the room screen, and the one thing they have to do is press
    // the button that takes the pointer lock.
    if (next === 'room') enterButton.focus()
    if (next === 'join') {
      refreshCode()
      codeInput.focus()
      codeInput.select()
    }
  }

  return {
    show,

    get screen() {
      return screen
    },

    get isOpen() {
      return screen !== 'hidden'
    },

    setRoom(code) {
      const link = code === null ? '' : hooks.shareLink(code)
      setText(roomCode, code === null ? '······' : formatRoomCode(code))
      if (linkInput.value !== link) linkInput.value = link
      copyButton.disabled = code === null
      setText(copyButton, 'Copy the link')
      delete copyButton.dataset['state']
    },

    setStatus(text) {
      setText(roomStatus, text)
    },

    setRawInput(state) {
      setText(rawRow, `Mouse input: ${rawInputLabel(state)}`)
      const warning = rawInputWarning(state)
      if (rawWarning.hidden !== (warning === null)) rawWarning.hidden = warning === null
      setText(rawWarning, warning ?? '')
    },

    setLockDenied(reason) {
      setText(
        pauseHint,
        reason === null
          ? 'The match is still running. Click to take the mouse back.'
          : `The browser is still holding the mouse (${reason}). Click again in a moment — a fresh click is the only thing that takes the lock back.`,
      )
      pauseHint.dataset['state'] = reason === null ? 'ready' : 'denied'
    },

    setTypedCode(code) {
      // Grouped only when it is a whole code. What arrives here otherwise is
      // whatever a chat client did to one on the way, and reformatting *that*
      // would hide the character it ate.
      codeInput.value = code.length === 6 ? formatRoomCode(code) : code
      refreshCode()
    },

    dispose() {
      root.removeEventListener('keydown', swallow)
      root.removeEventListener('keyup', swallow)
      root.remove()
    },
  }
}
