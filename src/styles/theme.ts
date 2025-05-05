// File: src/styles/theme.ts
// Defines the visual theme for the PonGo application

const theme = {
  colors: {
    background: '#000000', // Black background
    text: '#E0E0E0', // Light grey text
    textDim: '#B0B0B0', // Dimmer text for titles etc.
    accent: '#646cff', // Accent color (can be used for highlights)
    accentGlow: 'rgba(100, 108, 255, 0.3)', // Glow effect color derived from accent
    connectionStatus: { // Keep these for potential other uses
      connecting: '#FBBC05', // Yellow
      open: '#34A853', // Green
      closed: '#EA4335', // Red
      error: '#DB4437', // Darker Red
    },
    // Player colors (Google Palette) - Used for Paddles and owned Balls
    player0: '#4285F4', // Blue
    player1: '#34A853', // Green
    player2: '#FBBC05', // Yellow
    player3: '#EA4335', // Red
    // Ball colors
    unownedBall: '#FFFFFF', // White
    // Brick colors based on life
    brickLife: [
      '#4285F4', // Life 1 (Blue)
      '#34A853', // Life 2 (Green)
      '#FBBC05', // Life 3 (Yellow)
      '#EA4335', // Life 4 (Red)
      '#DB4437', // Life 5 (Darker Red)
      '#C53929', // Life 6+ (Darkest Red)
    ],
    brickBorder: '#333333', // Dark grey border for bricks
    brickShadow: 'rgba(255, 255, 255, 0.1)', // Subtle white shadow for bricks
    brickLifeText: '#FFFFFF', // Color for the life text inside bricks
    // UI Elements
    scoreboardBackground: 'rgba(20, 20, 20, 0.75)',
    scoreboardBorder: 'rgba(255, 255, 255, 0.1)',
    statusMessageBackground: 'rgba(0, 0, 0, 0.7)',
    // Boundary Walls
    boundaryWall: '#505050',
    boundaryWallEmissive: '#707070',
    // Mobile Controls
    mobileButtonBackground: 'rgba(40, 40, 40, 0.7)',
    mobileButtonBackgroundActive: 'rgba(60, 60, 60, 0.85)',
    mobileButtonBorder: 'rgba(255, 255, 255, 0.2)',
    mobileButtonSymbol: '#E0E0E0',
    // Status Overlay
    statusOverlayBackground: 'rgba(0, 0, 0, 0.8)',
    statusOverlayText: '#FFFFFF',
    statusOverlayConnecting: '#FBBC05', // Yellow
    statusOverlayWaiting: '#4285F4', // Blue
    statusOverlayClosed: '#EA4335', // Red
    statusOverlayError: '#DB4437', // Darker Red
    // Default particle color if needed (e.g., for generic effects)
    defaultParticle: '#CCCCCC',
  },
  fonts: {
    primary:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
    monospace: "'Courier New', Courier, monospace",
    sizes: {
      title: '1.5em',
      status: '1.8em',
      score: '1.0em',
      default: '1em',
      mobileButtonSymbol: '2.5em',
    },
  },
  sizes: {
    headerHeight: '50px',
    minScreenPadding: '.4rem', // Increased padding
    borderRadius: '0px',
    brickBorderRadius: '10px',
    boundaryWallThickness: 8,
    boundaryWallDepth: 10,
    mobileControlsHeight: '50px', // Reduced height
  },
  shadows: {
    canvas: '0 0 4px rgba(255, 255, 255, 0.2)',
    brick: '1px 1px 3px rgba(0, 0, 0, 0.4)',
    scoreboard: '0 2px 5px rgba(0, 0, 0, 0.3)',
    statusOverlay: '0 4px 15px rgba(0, 0, 0, 0.5)',
  },
  // Add other theme properties like spacing, breakpoints etc. as needed
};

export type AppTheme = typeof theme;

export default theme;