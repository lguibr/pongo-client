// File: src/hooks/useInputHandler.ts
import { useCallback, useEffect, useRef } from 'react';
import { InputQueue, VisualDirection, KeyDirection } from './InputQueue';

type VisualDirectionChangeHandler = (visualDir: VisualDirection) => void;

type UseInputHandlerProps = {
  isEnabled: boolean;
  onVisualDirectionChange: VisualDirectionChangeHandler;
};

export function useInputHandler({
  isEnabled,
  onVisualDirectionChange,
}: UseInputHandlerProps): void {
  const inputQueue = useRef(new InputQueue());
  const lastReportedVisualDir = useRef<VisualDirection | null>(null);

  const reportVisualDirectionIfChanged = useCallback(() => {
    if (!isEnabled) return;

    const currentVisualDir = inputQueue.current.getCurrentDirection();

    if (currentVisualDir !== lastReportedVisualDir.current) {
      onVisualDirectionChange(currentVisualDir);
      lastReportedVisualDir.current = currentVisualDir;
    }
  }, [isEnabled, onVisualDirectionChange]);

  useEffect(() => {
    // Capture the current ref value *inside* the effect setup
    const currentQueue = inputQueue.current;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;

      let relevantKey: KeyDirection | null = null;
      if (e.key === 'ArrowLeft') relevantKey = 'ArrowLeft';
      else if (e.key === 'ArrowRight') relevantKey = 'ArrowRight';

      if (relevantKey) {
        // Use the captured ref value
        const changed = currentQueue.press(relevantKey);
        if (changed) {
          reportVisualDirectionIfChanged();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      let relevantKey: KeyDirection | null = null;
      if (e.key === 'ArrowLeft') relevantKey = 'ArrowLeft';
      else if (e.key === 'ArrowRight') relevantKey = 'ArrowRight';

      if (relevantKey) {
        // Use the captured ref value
        const changed = currentQueue.release(relevantKey);
        if (changed) {
          reportVisualDirectionIfChanged();
        }
      }
    };

    const handleBlur = () => {
      // Use the captured ref value
      if (currentQueue.getCurrentDirection() !== 'Stop') {
        // console.log("[Input KB Hook] Window blurred, reporting Stop."); // Removed log
        currentQueue.clear();
        reportVisualDirectionIfChanged();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    // Correct cleanup function structure
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);

      // Capture isEnabled state at time of cleanup setup
      const currentIsEnabled = isEnabled;

      // Use the captured ref value (currentQueue) in the cleanup
      if (currentIsEnabled && currentQueue.getCurrentDirection() !== 'Stop') {
        // console.log("[Input KB Hook] Cleanup reporting Stop."); // Removed log
        currentQueue.clear(); // Clear the queue state
        // Directly call the handler if needed, as reportVisualDirectionIfChanged relies on current state
        onVisualDirectionChange('Stop');
      } else {
        // Ensure queue is clear even if not moving or not enabled
        currentQueue.clear();
      }
      lastReportedVisualDir.current = null; // Reset last reported direction
    };
    // Dependencies: reportVisualDirectionIfChanged includes isEnabled and onVisualDirectionChange
  }, [isEnabled, onVisualDirectionChange, reportVisualDirectionIfChanged]);
}