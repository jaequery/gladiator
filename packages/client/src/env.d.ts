/// <reference types="vite/client" />

/**
 * Vite inlines these at build time. The shipping Fly image enables the
 * same-origin path; `VITE_SERVER_URL` remains an explicit override for a
 * separately hosted client.
 *
 * Declared as an interface so it merges with Vite's rather than shadowing it.
 */
interface ImportMetaEnv {
  /**
   * Explicit authoritative host. Absent in the combined Fly image and local
   * `vite dev`; local development falls back to `ws://<hostname>:8787`.
   */
  readonly VITE_SERVER_URL?: string
  /** The page and authoritative WebSocket host ship from one origin. */
  readonly VITE_SAME_ORIGIN_SERVER?: string
  /** The commit this bundle was built from. Shown on the HUD. */
  readonly VITE_BUILD?: string
}
