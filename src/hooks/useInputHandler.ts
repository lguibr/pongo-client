// File: src/hooks/useInputHandler.ts
import { useCallback, useEffect, useRef } from 'react';
import { DirectionMessage } from '../types/game';

type SendDirectionFunction = (direction: DirectionMessage['direction']) => void;
type UseInputHandlerProps = {
  isEnabled: boolean; // e.g., based on WebSocket readyState === 'open'
  rotationDegrees: number; // Current canvas rotation
  sendDirection: SendDirectionFunction; // Function to send direction to backend
};

const TOUCH_MOVE_THRESHOLD = 10; // Minimum pixels to drag horizontally to trigger movement

/**
 * Hook to handle user input (keyboard and touch) for paddle movement.
 * Adjusts the direction sent to the backend based on the canvas rotation
 * to ensure intuitive control from the player's perspective.
 * Touch input allows touching anywhere and dragging left/right relative
 * to the initial touch point.
 */
export function useInputHandler({
  isEnabled,
  rotationDegrees,
  sendDirection,
}: UseInputHandlerProps): void {
  const lastSentDir = useRef<DirectionMessage['direction'] | null>(null);
  const touchStartX = useRef<number | null>(null);
  const activeTouchId = useRef<number | null>(null); // Track the specific touch

  // Function to determine the actual game direction based on screen input and rotation
  const getMappedDirection = useCallback(
    (
      screenDirection: 'ArrowLeft' | 'ArrowRight'
    ): 'ArrowLeft' | 'ArrowRight' => {
      // Players 0 (90deg) and 1 (180deg) have inverted horizontal controls
      const isInverted = rotationDegrees === 90 || rotationDegrees === 180;

      if (isInverted) {
        return screenDirection === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
      } else {
        // Players 2 (270deg) and 3 (0deg) have standard controls
        return screenDirection;
      }
    },
    [rotationDegrees]
  );

  // Memoized function to send direction only if it changed
  const sendMappedDirection = useCallback(
    (dir: DirectionMessage['direction']) => {
      if (!isEnabled || dir === lastSentDir.current) return;
      sendDirection(dir);
      lastSentDir.current = dir;
    },
    [isEnabled, sendDirection]
  );

  // Keyboard Input Handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isEnabled || e.repeat) return;

      let mappedDir: DirectionMessage['direction'] | null = null;
      if (e.key === 'ArrowLeft') {
        mappedDir = getMappedDirection('ArrowLeft');
      } else if (e.key === 'ArrowRight') {
        mappedDir = getMappedDirection('ArrowRight');
      }

      if (mappedDir) {
        sendMappedDirection(mappedDir);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!isEnabled) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Only stop if the key released corresponds to the current direction
        const releasedDir = getMappedDirection(e.key);
        if (lastSentDir.current === releasedDir) {
          sendMappedDirection('Stop');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (isEnabled && lastSentDir.current !== 'Stop') {
        sendMappedDirection('Stop');
      }
    };
  }, [isEnabled, getMappedDirection, sendMappedDirection]);

  // Touch Input Handling
  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      // Only respond to the first touch if not already tracking one
      if (!isEnabled || activeTouchId.current !== null || e.touches.length === 0) return;

      const touch = e.changedTouches[0]; // Use changedTouches for start/end
      activeTouchId.current = touch.identifier;
      touchStartX.current = touch.clientX;
      // Prevent default scroll/zoom behavior when touching the game area
      e.preventDefault();
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isEnabled || activeTouchId.current === null) return;

      // Find the active touch among the current touches
      let currentTouch: Touch | null = null;
      for (let i = 0; i < e.touches.length; i++) {
        if (e.touches[i].identifier === activeTouchId.current) {
          currentTouch = e.touches[i];
          break;
        }
      }

      if (!currentTouch || touchStartX.current === null) return;

      const currentX = currentTouch.clientX;
      const deltaX = currentX - touchStartX.current;

      let screenDirection: 'ArrowLeft' | 'ArrowRight' | null = null;
      if (deltaX > TOUCH_MOVE_THRESHOLD) {
        screenDirection = 'ArrowRight';
      } else if (deltaX < -TOUCH_MOVE_THRESHOLD) {
        screenDirection = 'ArrowLeft';
      }

      if (screenDirection) {
        const mappedDir = getMappedDirection(screenDirection);
        sendMappedDirection(mappedDir);
      } else {
        // If movement is below threshold, treat as stopped relative to touch
        sendMappedDirection('Stop');
      }
      // Prevent scrolling while dragging
      e.preventDefault();
    };

    const handleTouchEndOrCancel = (e: TouchEvent) => {
      if (!isEnabled || activeTouchId.current === null) return;

      // Check if the touch that ended/cancelled is the one we are tracking
      let touchEnded = false;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === activeTouchId.current) {
          touchEnded = true;
          break;
        }
      }

      if (touchEnded) {
        sendMappedDirection('Stop');
        touchStartX.current = null;
        activeTouchId.current = null;
      }
      e.preventDefault();
    };

    // Use passive: false for touchstart and touchmove to allow preventDefault
    const options: AddEventListenerOptions = { passive: false };
    // Add listeners to the window or a specific game area container element
    // Using window for simplicity here
    window.addEventListener('touchstart', handleTouchStart, options);
    window.addEventListener('touchmove', handleTouchMove, options);
    window.addEventListener('touchend', handleTouchEndOrCancel);
    window.addEventListener('touchcancel', handleTouchEndOrCancel);

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEndOrCancel);
      window.removeEventListener('touchcancel', handleTouchEndOrCancel);
      // Ensure stop on unmount if touch was active
      if (isEnabled && activeTouchId.current !== null) {
        sendMappedDirection('Stop');
        activeTouchId.current = null; // Clean up ref
        touchStartX.current = null; // Clean up ref
      }
    };
  }, [isEnabled, getMappedDirection, sendMappedDirection]); // Dependencies
}