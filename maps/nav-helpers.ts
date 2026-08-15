/**
 * The nav authoring vocabulary. What a `*.nav.ts` file is written in.
 *
 * The same trade `maps/helpers.ts` makes, for the same reasons: a nav graph is
 * TypeScript rather than a data format, so the editor knows the tags, a typo in
 * a node id is a red squiggle rather than a bake failure, and a lane of
 * waypoints can be a helper call instead of eight pasted objects. The cost is
 * that the graph has to be *baked* before the bot can load it — which is
 * `pnpm nav:bake`, and which is also where the validation lives.
 *
 * Everything here is Quake frame, Quake units, whole numbers, and an origin at
 * the player's feet. `docs/physics-spec.md` §0.2 and §0.3.
 *
 * No validation happens here. The baker validates, once, so that a rule cannot
 * be true of hand-written graphs and false of generated ones.
 */

import type { NavLink, NavNode, NavSource, NavTag, Vec3 } from '@gladiator/bot'

/**
 * One place worth standing.
 *
 * `origin` is the feet, in whole units, read off the map file next to it. The
 * bake drops it on to the surface underneath — an axis-aligned box rests on its
 * *uphill* edge, so a node on a ramp ends up a few units above the plane you
 * typed — and that snapped height is what goes in the artifact.
 *
 * Tags are a rest parameter because every node has at least one and most have
 * exactly one: `node('lane-sw', [-448, -448, 0], 'ground')`.
 */
export function node(id: string, origin: Vec3, ...tags: readonly NavTag[]): NavNode {
  return { id, origin, tags }
}

/**
 * A walk, both ways.
 *
 * The only kind that is symmetric by definition: the rule that makes it a walk
 * — no rise bigger than a step, no hole wider than a stride — reads the same
 * from either end, so authoring one direction and forgetting the other would
 * always be a mistake rather than sometimes a design.
 */
export function walk(a: string, b: string): NavLink[] {
  return [
    { from: a, to: b, kind: 'walk' },
    { from: b, to: a, kind: 'walk' },
  ]
}

/** A run of walks along a line of nodes: a lane, a staircase, a ring. */
export function walkChain(...ids: readonly string[]): NavLink[] {
  const links: NavLink[] = []
  for (let i = 1; i < ids.length; i += 1) {
    const from = ids[i - 1]
    const to = ids[i]
    if (from === undefined || to === undefined) continue
    links.push(...walk(from, to))
  }
  return links
}

/**
 * A jump, one way and upwards.
 *
 * Not paired with anything: coming back down is a {@link drop}, and it is a
 * different button, a different arc and a different traversal controller. An
 * author who wants both says both, which is also how a one-way ledge gets
 * written down.
 */
export function jump(from: string, to: string): NavLink {
  return { from, to, kind: 'jump' }
}

/** A fall off an edge, one way and downwards. */
export function drop(from: string, to: string): NavLink {
  return { from, to, kind: 'drop' }
}

/** A teleporter pad. One way, from the pad to wherever it puts you. */
export function teleport(from: string, to: string): NavLink {
  return { from, to, kind: 'teleport' }
}

/** What a `*.nav.ts` file's default export is built with. */
export type NavSpec = {
  /** The map this graph is for. Must match the map's `name`. */
  readonly map: string
  readonly nodes: readonly NavNode[]
  /**
   * The links, in whatever shape the helpers produced them.
   *
   * `walk` gives back a pair and `jump` gives back one, so a hand-written list
   * would be a mess of spreads. Flattening here means an author writes
   * `[...walk(a, b), jump(b, c)]` as `[walk(a, b), jump(b, c)]` and the file
   * reads like the level does.
   */
  readonly links: readonly (NavLink | readonly NavLink[])[]
}

/** Assemble a nav graph. The baker looks for this as a module's default export. */
export function defineNav(spec: NavSpec): NavSource {
  const links: NavLink[] = []
  for (const entry of spec.links) {
    if (Array.isArray(entry)) links.push(...(entry as readonly NavLink[]))
    else links.push(entry as NavLink)
  }
  return { map: spec.map, nodes: spec.nodes, links }
}
