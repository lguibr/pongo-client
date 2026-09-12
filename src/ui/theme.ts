// Typed token names (9.9). Every value is a CSS variable defined once in GlobalStyle, so components read
// tokens by import and the reduced-motion switch (data-motion, prefers-reduced-motion) needs no re-render.

export const theme = {
  color: {
    bg: 'var(--bg)',
    fg: 'var(--fg)',
    muted: 'var(--muted)',          // #a1a1aa, 7.9:1 on the ground (C105)
    border: 'var(--border)',
    card: 'var(--card)',
    secondary: 'var(--secondary)',  // zinc-800 fills: secondary buttons, seat rows
    primary: 'var(--primary)',      // #2563eb, 5.2:1 with white (C105)
    primaryFg: 'var(--primary-fg)',
    danger: 'var(--danger)',
    success: 'var(--success)',
    warn: 'var(--warn)',
    dot: 'var(--dot)',              // inactive carousel dots, #71717a, 4.1:1 (C105)
    focus: 'var(--focus)',
  },
  size: {
    headerH: 'var(--header-h)',
    radius: 'var(--radius)',
    touch: '44px',                  // minimum touch target (9.8)
    /** The reconnect bar's height plus its top gap while it shows over the room, else 0. ReconnectBanner
     *  writes --banner-h on the foreground layer; the frozen HUD's top row offsets by it. */
    bannerH: 'var(--banner-h, 0px)',
  },
  safe: {
    t: 'var(--safe-t)',
    r: 'var(--safe-r)',
    b: 'var(--safe-b)',
    l: 'var(--safe-l)',
  },
  dur: {
    fast: 'var(--dur-fast)',
    base: 'var(--dur)',
    slow: 'var(--dur-slow)',
  },
  /** 1 normally, 0 under reduced motion: multiply scale and distance amplitudes by it. */
  motion: 'var(--motion)',
  z: {
    stage: 'var(--z-stage)',
    hud: 'var(--z-hud)',
    overlay: 'var(--z-overlay)',
    dialog: 'var(--z-dialog)',
    toast: 'var(--z-toast)',
    header: 'var(--z-header)',
  },
  font: 'var(--font)',
} as const;

export type AppTheme = typeof theme;
