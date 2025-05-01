// File: src/styles/theme.ts
// Defines the visual theme for the PonGo application

const theme = {
  colors: {
    background: '#000000', // Black background
    text: '#E0E0E0', // Light grey text
    textDim: '#B0B0B0', // Dimmer text for titles etc.
    accent: '#646cff', // Accent color (can be used for highlights)
    connectionStatus: {
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
    // UI Elements
    scoreboardBackground: 'rgba(0, 0, 0, 0.6)',
    statusMessageBackground: 'rgba(0, 0, 0, 0.7)',
    // Particle color could be defined here if needed, e.g.:
    // particleColor: '#FFFFFF',
  },
  fonts: {
    primary:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
    sizes: {
      title: '1.5em',
      status: '1.5em',
      score: '0.9em',
      default: '1em',
    },
  },
  sizes: {
    headerHeight: '50px',
    canvasGap: '20px',
    borderRadius: '5px',
    brickBorderRadius: '3px', // Slightly rounded bricks
  },
  shadows: {
    canvas: '0 0 4px rgba(255, 255, 255, 0.2)',
    brick: '1px 1px 3px rgba(0, 0, 0, 0.4)', // Shadow for bricks
  },
  // Add other theme properties like spacing, breakpoints etc. as needed
};

export type AppTheme = typeof theme;

export default theme;