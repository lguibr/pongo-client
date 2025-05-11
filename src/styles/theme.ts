// File: src/styles/theme.ts
// Defines the visual theme for the PonGo application

const theme = {
  colors: {
    background: '#121212', // Slightly darker background
    text: '#E0E0E0', // Slightly softer white
    textDim: '#BDBDBD',
    accent: '#7E85FF', // Slightly desaturated accent
    accentGlow: '#7E85FF', // Same as accent, no glow
    brickSheenAccent: '#9FA6FF',
    connectionStatus: {
      connecting: '#FBBC05',
      open: '#34A853',
      closed: '#EA4335',
      error: '#DB4437',
    },
    player0: '#4285F4', // Google Blue
    player1: '#34A853', // Google Green
    player2: '#FBBC05', // Google Yellow
    player3: '#EA4335', // Google Red
    unownedBall: '#BDBDBD', // Lighter grey for unowned balls
    ballTrail: 'rgba(200, 200, 220, 0.5)', // More neutral trail
    brickLife: [ // Standard Material Design-like colors
      '#2196F3', // Blue
      '#4CAF50', // Green
      '#FFC107', // Amber
      '#E91E63', // Pink
      '#FF5722', // Deep Orange
      '#F44336', // Red
    ],
    brickBorder: '#424242', // Darker border
    brickShadow: 'rgba(0, 0, 0, 0.2)', // Softer shadow for flat design
    brickLifeText: '#FFFFFF',
    scoreboardBackground: 'rgba(40, 40, 40, 0.9)',
    scoreboardBorder: 'rgba(100, 100, 150, 0.2)',
    statusMessageBackground: 'rgba(20, 20, 20, 0.85)',
    boundaryWall: '#28282D', // Darker walls
    boundaryWallEmissive: '#28282D', // No emissive for walls
    mobileButtonBackground: 'rgba(60, 60, 65, 0.85)',
    mobileButtonBackgroundActive: 'rgba(80, 80, 85, 0.95)',
    mobileButtonBorder: 'rgba(120, 120, 170, 0.25)',
    mobileButtonSymbol: '#D0D0D0',
    statusOverlayBackground: 'rgba(10, 10, 15, 0.9)',
    statusOverlayText: '#E0E0E0',
    statusOverlayConnecting: '#FBBC05',
    statusOverlayWaiting: '#4285F4',
    statusOverlayClosed: '#EA4335',
    statusOverlayError: '#DB4437',
    defaultParticle: '#BDBDBD',
  },
  fonts: {
    primary:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
    monospace: "'Consolas', 'Menlo', 'Courier New', Courier, monospace",
    sizes: {
      title: '1.8em',
      status: '1.8em',
      score: '1.2em',
      default: '1em',
      mobileButtonSymbol: '2.5em',
    },
  },
  sizes: {
    headerHeight: '60px',
    minScreenPadding: '.5rem',
    borderRadius: '4px',
    brickBorderRadius: '10px', // Kept for RoundedBox, but effect will be subtle
    boundaryWallThickness: 8,
    boundaryWallDepth: 10, // This is visual depth along Z for walls
    mobileControlsHeight: '55px',
    brickDepthPerLifeUnit: 0.1, // Each point of life adds this * cellSize to depth
  },
  shadows: {
    canvas: '0 0 10px rgba(0, 0, 0, 0.2)', // Softer shadow
    brick: '1px 1px 3px rgba(0, 0, 0, 0.3)',
    scoreboard: '0 2px 8px rgba(0, 0, 0, 0.4)',
    statusOverlay: '0 2px 10px rgba(0, 0, 0, 0.4)',
  },
};

export type AppTheme = typeof theme;

export default theme;