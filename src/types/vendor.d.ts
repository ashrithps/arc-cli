/**
 * Ambient declarations for TUI dependencies that ship no types.
 *
 * `blessed` and `blessed-contrib` are untyped on npm and have no @types
 * package worth pinning. The TUI already treats their widgets as loose
 * objects, so declaring them as `any` here is honest about what we have
 * rather than inventing a surface we would then have to keep true.
 *
 * Scoped to these two modules deliberately — this is not a general escape
 * hatch, and nothing else in src/ should need an entry.
 */
declare module 'blessed' {
  const blessed: any;
  export default blessed;
}

declare module 'blessed-contrib' {
  const contrib: any;
  export default contrib;
}
