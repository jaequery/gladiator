/// <reference types="vite/client" />

/**
 * Vite inlines these at build time. That is the whole reason
 * `VITE_SERVER_URL` has to be set in *every* Vercel environment — Production,
 * Preview and Development — rather than once: a preview deploy is a separate
 * build, and it bakes in whatever the Preview environment held at that moment.
 *
 * Declared as an interface so it merges with Vite's rather than shadowing it.
 */
interface ImportMetaEnv {
  /**
   * `wss://<app>.fly.dev`. Absent in a local `vite dev`, where the client
   * falls back to `ws://<hostname>:8787`.
   */
  readonly VITE_SERVER_URL?: string
  /** The commit this bundle was built from. Shown on the HUD. */
  readonly VITE_BUILD?: string
}
