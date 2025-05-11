// File: src/hooks/useSoundManager.ts
import { useState, useEffect, useCallback, useRef } from 'react';

export type SoundEventType =
  | 'paddle_collision'
  | 'brick_break'
  | 'ball_ownership_change'
  | 'ball_collision';

const SOUND_FILES: Record<SoundEventType, string[]> = {
  paddle_collision: [
    '/sounds/paddle_collision/0.wav',
    '/sounds/paddle_collision/1.wav',
    '/sounds/paddle_collision/2.wav',
    '/sounds/paddle_collision/3.wav',
    '/sounds/paddle_collision/4.wav',
  ],
  brick_break: [
    '/sounds/brick_break/0.wav',
    '/sounds/brick_break/1.wav',
    '/sounds/brick_break/2.wav',
    '/sounds/brick_break/3.wav',
    '/sounds/brick_break/4.wav',
  ],
  ball_ownership_change: [
    '/sounds/ball_ownership_change/0.wav',
    '/sounds/ball_ownership_change/1.wav',
    '/sounds/ball_ownership_change/2.wav',
    '/sounds/ball_ownership_change/3.wav',
    '/sounds/ball_ownership_change/4.wav',
  ],
  ball_collision: [
    '/sounds/ball_collision/0.wav',
    '/sounds/ball_collision/1.wav',
    '/sounds/ball_collision/2.wav',
    '/sounds/ball_collision/3.wav',
    '/sounds/ball_collision/4.wav',
  ],
};

const LOCAL_STORAGE_MUTED_KEY = 'pongo-muted';

export interface SoundManager {
  playSound: (type: SoundEventType, index?: number) => void;
  toggleMute: () => void;
  isMuted: boolean;
  isLoading: boolean;
  error: string | null;
}

export function useSoundManager(): SoundManager {
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const soundBuffers = useRef<Partial<Record<SoundEventType, AudioBuffer[]>>>(
    {}
  );
  const [isMuted, setIsMuted] = useState<boolean>(() => {
    const storedMuteState = localStorage.getItem(LOCAL_STORAGE_MUTED_KEY);
    return storedMuteState ? JSON.parse(storedMuteState) : false;
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const audioContextResumed = useRef(false);

  useEffect(() => {
    try {
      const context = new (window.AudioContext ||
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).webkitAudioContext)();
      setAudioContext(context);
      if (context.state === 'suspended') {
        audioContextResumed.current = false;
      } else {
        audioContextResumed.current = true;
      }
    } catch (e: unknown) {
      console.error('Web Audio API is not supported in this browser.', e);
      setError('Web Audio API is not supported.');
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const resumeAudio = async () => {
      if (audioContext && audioContext.state === 'suspended' && !audioContextResumed.current) {
        try {
          await audioContext.resume();
          audioContextResumed.current = true;
          console.log('AudioContext resumed on user gesture.');
        } catch (err) {
          console.error('Error resuming AudioContext:', err);
        }
      }
      if (audioContext && (audioContext.state === 'running' || audioContextResumed.current)) {
        document.removeEventListener('click', resumeAudio);
        document.removeEventListener('touchstart', resumeAudio);
      }
    };

    if (audioContext && audioContext.state === 'suspended' && !audioContextResumed.current) {
      document.addEventListener('click', resumeAudio, { once: true });
      document.addEventListener('touchstart', resumeAudio, { once: true });
    }

    return () => {
      document.removeEventListener('click', resumeAudio);
      document.removeEventListener('touchstart', resumeAudio);
    };
  }, [audioContext]);


  useEffect(() => {
    if (!audioContext) return;

    const loadSound = async (
      type: SoundEventType,
      path: string,
      bufferIndex: number
    ) => {
      try {
        const response = await fetch(path);
        if (!response.ok) {
          throw new Error(`Failed to fetch ${path}: ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        soundBuffers.current[type] = soundBuffers.current[type] || [];
        soundBuffers.current[type]![bufferIndex] = audioBuffer;
      } catch (e: unknown) { // Changed from any to unknown
        let message = `Error loading sound ${path}`;
        if (e instanceof Error) { // Type check
          message = `${message}: ${e.message}`;
        }
        console.error(message, e);
        setError((prevError) =>
          prevError ? `${prevError}, ${path}` : `Error loading ${path}`
        );
      }
    };

    const loadAllSounds = async () => {
      setIsLoading(true);
      setError(null);
      const promises: Promise<void>[] = [];
      Object.entries(SOUND_FILES).forEach(([type, paths]) => {
        paths.forEach((path, index) => {
          promises.push(
            loadSound(type as SoundEventType, path, index)
          );
        });
      });
      await Promise.all(promises);
      setIsLoading(false);
    };

    loadAllSounds();
  }, [audioContext]);

  const _playSoundInternal = useCallback((type: SoundEventType, index?: number) => {
    if (!audioContext) return;

    const buffersForType = soundBuffers.current[type];
    if (!buffersForType || buffersForType.length === 0) {
      console.warn(`Sound buffers for type "${type}" not loaded or empty.`);
      return;
    }

    let bufferToPlay: AudioBuffer | undefined;
    if (index !== undefined && index >= 0 && index < buffersForType.length) {
      bufferToPlay = buffersForType[index];
    } else {
      const randomIndex = Math.floor(Math.random() * buffersForType.length);
      bufferToPlay = buffersForType[randomIndex];
    }

    if (bufferToPlay) {
      try {
        const source = audioContext.createBufferSource();
        source.buffer = bufferToPlay;
        source.connect(audioContext.destination);
        source.start(0);
      } catch (e: unknown) {
        let message = `Error playing sound ${type}`;
        if (e instanceof Error) {
          message = `${message}: ${e.message}`;
        }
        console.error(message, e);
      }
    } else {
      console.warn(`Buffer to play for sound type "${type}" is undefined.`);
    }
  }, [audioContext]);

  const playSound = useCallback(
    (type: SoundEventType, index?: number) => {
      if (isMuted || !audioContext) {
        return;
      }
      if (audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
          audioContextResumed.current = true;
          if (!isMuted) _playSoundInternal(type, index);
        }).catch(err => console.error("Error resuming audio context on play:", err));
        return;
      }

      if (!audioContextResumed.current) {
        console.warn("AudioContext not yet resumed by user gesture. Sound play might fail.");
      }

      _playSoundInternal(type, index);
    },
    [isMuted, audioContext, _playSoundInternal]
  );

  const toggleMute = useCallback(() => {
    setIsMuted((prevMuted) => {
      const newMutedState = !prevMuted;
      localStorage.setItem(
        LOCAL_STORAGE_MUTED_KEY,
        JSON.stringify(newMutedState)
      );
      if (!newMutedState && audioContext && audioContext.state === 'suspended' && !audioContextResumed.current) {
        audioContext.resume().then(() => {
          audioContextResumed.current = true;
        }).catch(err => console.error("Error resuming audio context on unmute:", err));
      }
      return newMutedState;
    });
  }, [audioContext]);

  return { playSound, toggleMute, isMuted, isLoading, error };
}