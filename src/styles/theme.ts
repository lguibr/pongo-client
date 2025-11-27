// File: src/styles/theme.ts
// Defines the visual theme for the PonGo application

const theme = {
  colors: {
    background: '#09090b', // Zinc 950
    foreground: '#fafafa', // Zinc 50
    
    card: '#09090b',
    cardForeground: '#fafafa',
    
    popover: '#09090b',
    popoverForeground: '#fafafa',
    
    primary: '#3b82f6', // Blue 500 (keeping the game's blue identity but refined)
    primaryForeground: '#ffffff',
    
    secondary: '#27272a', // Zinc 800
    secondaryForeground: '#fafafa',
    
    muted: '#27272a',
    mutedForeground: '#a1a1aa', // Zinc 400
    
    accent: '#27272a',
    accentForeground: '#fafafa',
    
    destructive: '#ef4444', // Red 500
    destructiveForeground: '#fafafa',
    
    border: '#27272a',
    input: '#27272a',
    ring: '#3b82f6',
    
    // Game specific
    text: '#E0E0E0',
    textDim: '#BDBDBD',
    accentGlow: '#7E85FF',
    brickSheenAccent: '#9FA6FF',
    success: '#22c55e', // Green 500
    connectionStatus: {
      connecting: '#eab308', // Yellow 500
      open: '#22c55e',
      closed: '#ef4444',
      error: '#ef4444',
    },
    player0: '#3b82f6', // Blue
    player1: '#22c55e', // Green
    player2: '#eab308', // Yellow
    player3: '#ef4444', // Red
    unownedBall: '#BDBDBD',
    ballTrail: 'rgba(200, 200, 220, 0.5)',
    brickLife: [
      '#3b82f6',
      '#22c55e',
      '#eab308',
      '#ec4899', // Pink
      '#f97316', // Orange
      '#ef4444',
    ],
    brickBorder: '#424242',
    brickShadow: 'rgba(0, 0, 0, 0.2)',
    brickLifeText: '#FFFFFF',
    scoreboardBackground: 'rgba(9, 9, 11, 0.9)',
    scoreboardBorder: 'rgba(39, 39, 42, 0.5)',
    statusMessageBackground: 'rgba(9, 9, 11, 0.9)',
    boundaryWall: '#27272a',
    boundaryWallEmissive: '#27272a',
    mobileButtonBackground: 'rgba(39, 39, 42, 0.9)',
    mobileButtonBackgroundActive: 'rgba(63, 63, 70, 0.9)',
    mobileButtonBorder: 'rgba(63, 63, 70, 0.5)',
    mobileButtonSymbol: '#fafafa',
    statusOverlayBackground: 'rgba(9, 9, 11, 0.95)',
    statusOverlayText: '#fafafa',
    statusOverlayConnecting: '#eab308',
    statusOverlayWaiting: '#3b82f6',
    statusOverlayClosed: '#ef4444',
    statusOverlayError: '#ef4444',
    defaultParticle: '#a1a1aa',
    volumeSliderTrack: '#27272a',
    volumeSliderThumb: '#fafafa',
    volumeSliderThumbBorder: '#09090b',
    volumeSliderThumbHover: '#ffffff',
  },
  fonts: {
    primary: '"VT323", monospace',
    monospace: '"VT323", monospace',
    sizes: {
      title: '3.5rem',
      subtitle: '2rem',
      body: '1.5rem',
      caption: '1.2rem',
      score: '3rem',
      mobileScore: '2rem',
      mobileButtonSymbol: '2.5rem',
    },
  },
  sizes: {
    headerHeight: 'var(--header-height)', // Or your fixed value like '60px'
    minScreenPadding: '.25rem', // Keep this for internal padding of GameAreaContainer
    borderRadius: '4px', // Retro feel usually implies sharper corners
    brickBorderRadius: '12px',
    boundaryWallThickness: 10,
    boundaryWallDepth: 16,
    mobileControlsHeight: 'var(--controls-height)', // Or your fixed value like '70px'
    brickDepthPerLifeUnit: 0.12,
  },
  shadows: {
    canvas: '0 0 10px rgba(0, 0, 0, 0.2)',
    brick: '1px 1px 3px rgba(0, 0, 0, 0.3)',
    scoreboard: '0 2px 8px rgba(0, 0, 0, 0.4)',
    statusOverlay: '0 2px 10px rgba(0, 0, 0, 0.4)',
  },
};

export type AppTheme = typeof theme;

export default theme;