// File: src/styles/theme.ts
// Defines the visual theme for the PonGo application

const theme = {
  colors: {
    background: '#121212',
    text: '#E0E0E0',
    textDim: '#BDBDBD',
    accent: '#7E85FF',
    accentGlow: '#7E85FF',
    brickSheenAccent: '#9FA6FF',
    connectionStatus: {
      connecting: '#FBBC05',
      open: '#34A853',
      closed: '#EA4335',
      error: '#DB4437',
    },
    player0: '#4285F4',
    player1: '#34A853',
    player2: '#FBBC05',
    player3: '#EA4335',
    unownedBall: '#BDBDBD',
    ballTrail: 'rgba(200, 200, 220, 0.5)',
    brickLife: [
      '#2196F3',
      '#4CAF50',
      '#FFC107',
      '#E91E63',
      '#FF5722',
      '#F44336',
    ],
    brickBorder: '#424242',
    brickShadow: 'rgba(0, 0, 0, 0.2)',
    brickLifeText: '#FFFFFF',
    scoreboardBackground: 'rgba(40, 40, 40, 0.9)',
    scoreboardBorder: 'rgba(100, 100, 150, 0.2)',
    statusMessageBackground: 'rgba(20, 20, 20, 0.85)',
    boundaryWall: '#28282D',
    boundaryWallEmissive: '#28282D',
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
    volumeSliderTrack: '#555',
    volumeSliderThumb: '#E0E0E0',
    volumeSliderThumbBorder: '#333',
    volumeSliderThumbHover: '#FFFFFF',
  },
  fonts: {
    primary:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
    monospace: "'Consolas', 'Menlo', 'Courier New', Courier, monospace",
    sizes: {
      title: '1.8em',
      titleMobile: '1.5em', // Added for smaller screens
      status: '1.8em',
      score: '1.4em',
      default: '1em',
      mobileButtonSymbol: '2.5em',
      mobileScore: '0.8em',
    },
  },
  sizes: {
    headerHeight: '96px',
    minScreenPadding: '.25rem',
    borderRadius: '8px',
    brickBorderRadius: '12px',
    boundaryWallThickness: 10,
    boundaryWallDepth: 16,
    mobileControlsHeight: '80px',
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