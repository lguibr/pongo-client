// File: src/hooks/InputQueue.ts

export type KeyDirection = 'ArrowLeft' | 'ArrowRight';
export type VisualDirection = KeyDirection | 'Stop';

export class InputQueue {
  private pressedKeys: KeyDirection[] = [];

  /**
   * Records a key press. Adds the key to the end of the queue
   * if it's not already the last element. Removes other occurrences.
   * @param key The direction key pressed.
   * @returns True if the effective direction might have changed, false otherwise.
   */
  press(key: KeyDirection): boolean {
    const currentLast = this.pressedKeys[this.pressedKeys.length - 1];
    if (currentLast === key) {
      return false; // No change in effective direction
    }

    // Remove other occurrences of this key
    this.pressedKeys = this.pressedKeys.filter(k => k !== key);
    // Add to the end
    this.pressedKeys.push(key);
    return true; // Effective direction changed
  }

  /**
   * Records a key release. Removes the key from the queue.
   * @param key The direction key released.
   * @returns True if the effective direction might have changed, false otherwise.
   */
  release(key: KeyDirection): boolean {
    const initialLength = this.pressedKeys.length;
    this.pressedKeys = this.pressedKeys.filter(k => k !== key);
    // Change occurred only if the key was actually removed
    return this.pressedKeys.length !== initialLength;
  }

  /**
   * Gets the current effective visual direction based on the key queue.
   * @returns The current visual direction ('ArrowLeft', 'ArrowRight', or 'Stop').
   */
  getCurrentDirection(): VisualDirection {
    if (this.pressedKeys.length === 0) {
      return 'Stop';
    }
    // The last key in the queue determines the direction
    return this.pressedKeys[this.pressedKeys.length - 1];
  }

  /**
   * Clears the queue, e.g., on blur or cleanup.
   */
  clear(): void {
    this.pressedKeys = [];
  }
}