import { describe, expect, it } from 'vitest'

import { FOV_RADIANS } from '../render/scene.ts'
import {
  CM_PER_INCH,
  DEFAULT_SETTINGS,
  QUAKE_DEGREES_PER_COUNT,
  SETTINGS_BOUNDS,
  SETTINGS_KEY,
  type Settings,
  type SettingsStorage,
  countsPer360,
  createSettingsStore,
  degreesPerCount,
  loadSettings,
  normalizeSettings,
  parseSettings,
  quakeSensitivity,
  verticalFovRadians,
} from './settings.ts'

const at = (change: Partial<Settings>): Settings => normalizeSettings({ ...DEFAULT_SETTINGS, ...change })

/** A `localStorage` that is a `Map`, so the round trip can be asserted. */
function fakeStorage(initial: Record<string, string> = {}): SettingsStorage & { readonly map: Map<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

describe('cm/360', () => {
  it('turns centimetres into mouse counts through the mouse’s own DPI', () => {
    // Ten inches of travel at 800 CPI is 8000 counts, by definition.
    expect(countsPer360(at({ cm360: 10 * CM_PER_INCH, dpi: 800 }))).toBeCloseTo(8000, 9)
    // Twice the distance is twice the counts; twice the DPI is too.
    expect(countsPer360(at({ cm360: 60, dpi: 800 }))).toBeCloseTo(
      2 * countsPer360(at({ cm360: 30, dpi: 800 })),
      9,
    )
    expect(countsPer360(at({ cm360: 30, dpi: 1600 }))).toBeCloseTo(
      2 * countsPer360(at({ cm360: 30, dpi: 800 })),
      9,
    )
  })

  it('is the same physical distance whatever the DPI', () => {
    // The claim the whole setting rests on: a player who moves their hand 30 cm
    // turns exactly once, on any mouse. Distance in cm = counts / (dpi / 2.54).
    for (const dpi of [400, 800, 1600, 3200]) {
      const settings = at({ cm360: 30, dpi })
      const centimetres = (countsPer360(settings) / dpi) * CM_PER_INCH
      expect(centimetres).toBeCloseTo(30, 9)
    }
  })

  it('reports the Quake sensitivity a player would recognise', () => {
    // Quake's own default — `sensitivity 2.5` on `m_yaw 0.022` — is 0.055
    // degrees a count, which at 800 CPI is a hair under 21 cm/360.
    const quakeDefault = at({ cm360: 360 / (2.5 * QUAKE_DEGREES_PER_COUNT) / 800 * CM_PER_INCH, dpi: 800 })
    expect(quakeSensitivity(quakeDefault)).toBeCloseTo(2.5, 6)
    expect(quakeDefault.cm360).toBeCloseTo(20.8, 1)
  })
})

describe('the FOV', () => {
  it('agrees with the renderer at Quake’s 90', () => {
    // The setting is horizontal-at-4:3, which is what `fov 90` means; the
    // camera takes the vertical angle. Getting this backwards is a game that
    // feels zoomed in and looks fine in a screenshot.
    expect(verticalFovRadians(90)).toBeCloseTo(FOV_RADIANS, 12)
  })

  it('is monotonic, so the slider does what it looks like it does', () => {
    expect(verticalFovRadians(70)).toBeLessThan(verticalFovRadians(90))
    expect(verticalFovRadians(130)).toBeGreaterThan(verticalFovRadians(90))
  })
})

describe('normalizeSettings', () => {
  it('clamps rather than rejects', () => {
    expect(normalizeSettings({ cm360: 0 }).cm360).toBe(SETTINGS_BOUNDS.cm360.min)
    expect(normalizeSettings({ cm360: 9999 }).cm360).toBe(SETTINGS_BOUNDS.cm360.max)
    expect(normalizeSettings({ fovDegrees: 179 }).fovDegrees).toBe(SETTINGS_BOUNDS.fovDegrees.max)
    expect(normalizeSettings({ dpi: 1 }).dpi).toBe(SETTINGS_BOUNDS.dpi.min)
  })

  it('falls back for anything that is not a finite number', () => {
    const junk = { cm360: Number.NaN, dpi: '800', fovDegrees: null, diagnostics: 'yes' }
    expect(normalizeSettings(junk as unknown as Partial<Settings>)).toEqual(DEFAULT_SETTINGS)
  })
})

describe('storage', () => {
  it('round-trips through a store', () => {
    const storage = fakeStorage()
    const store = createSettingsStore(storage)
    store.update({ cm360: 45, fovDegrees: 110 })

    expect(loadSettings(storage)).toMatchObject({ cm360: 45, fovDegrees: 110 })
    expect(storage.map.has(SETTINGS_KEY)).toBe(true)
  })

  it('tells its listeners what stuck, not what was asked for', () => {
    const store = createSettingsStore(fakeStorage())
    const seen: number[] = []
    store.onChange((settings) => seen.push(settings.cm360))
    store.update({ cm360: 1000 })
    expect(seen).toEqual([SETTINGS_BOUNDS.cm360.max])
    expect(store.value.cm360).toBe(SETTINGS_BOUNDS.cm360.max)
  })

  it('survives a storage that throws, because private browsing does', () => {
    const hostile: SettingsStorage = {
      getItem: () => {
        throw new Error('site data is blocked')
      },
      setItem: () => {
        throw new Error('site data is blocked')
      },
    }
    expect(loadSettings(hostile)).toEqual(DEFAULT_SETTINGS)
    const store = createSettingsStore(hostile)
    expect(() => store.update({ cm360: 40 })).not.toThrow()
    // It still applies to this session; it just will not survive the tab.
    expect(store.value.cm360).toBe(40)
  })

  it('reads a corrupt blob as the defaults', () => {
    expect(parseSettings('{"cm360":')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('null')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS)
  })
})

describe('degreesPerCount', () => {
  it('is what a full turn divided by its counts comes to', () => {
    const settings = at({ cm360: 30, dpi: 800 })
    expect(degreesPerCount(settings) * countsPer360(settings)).toBeCloseTo(360, 9)
  })
})
