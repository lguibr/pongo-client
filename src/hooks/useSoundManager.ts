// File: src/hooks/useSoundManager.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { soundtrackManager } from '../audio/SoundtrackManager';

export type SoundEventType =
  | 'paddle_collision'
  | 'brick_break'
  | 'ball_ownership_change'
  | 'ball_collision'
  | 'ball_lost_by_player'
  | 'ball_gained_by_player';

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
  ball_lost_by_player: [
    '/sounds/ball_ownership_change/lost_0.wav',
    '/sounds/ball_ownership_change/lost_1.wav',
  ],
  ball_gained_by_player: [
    '/sounds/ball_ownership_change/gained_0.wav',
    '/sounds/ball_ownership_change/gained_1.wav',
  ],
  ball_collision: [
    '/sounds/ball_collision/0.wav',
    '/sounds/ball_collision/1.wav',
    '/sounds/ball_collision/2.wav',
    '/sounds/ball_collision/3.wav',
    '/sounds/ball_collision/4.wav',
  ],
};

const LOCAL_STORAGE_VOLUME_KEY = 'pongo-volume';
const DEFAULT_VOLUME = 0.5;
const SFX_VOLUME_SCALING = 0.1; // Drastically reduce max volume as per user request

export interface SoundManager {
  playSound: (type: SoundEventType, index?: number) => void;
  setVolume: (volume: number) => void;
  volume: number;
  isLoading: boolean;
  error: string | null;
  resumeContext: () => Promise<void>;
  soundtrackVolume: number;
  setSoundtrackVolume: (volume: number) => void;
}

export function useSoundManager(): SoundManager {
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const soundBuffers = useRef<Partial<Record<SoundEventType, AudioBuffer[]>>>(
    {}
  );
  const [volume, setVolumeState] = useState<number>(() => {
    const storedVolume = localStorage.getItem(LOCAL_STORAGE_VOLUME_KEY);
    return storedVolume ? parseFloat(storedVolume) : DEFAULT_VOLUME;
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
      const gainNode = context.createGain();
      gainNode.connect(context.destination);
      gainNodeRef.current = gainNode;

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

  const resumeContext = useCallback(async () => {
    if (audioContext && audioContext.state === 'suspended' && !audioContextResumed.current) {
      try {
        await audioContext.resume();
        audioContextResumed.current = true;
        console.log('AudioContext resumed on user gesture.');
        
        // Start soundtrack on first resume
        try {
          await soundtrackManager.start();
        } catch (e) {
          console.error("Failed to start soundtrack:", e);
        }

      } catch (err) {
        console.error('Error resuming AudioContext:', err);
      }
    } else if (audioContext && audioContext.state === 'running') {
       // Ensure soundtrack is started even if context was already running (edge case)
       if (!soundtrackManager.isSoundtrackPlaying) {
          try {
            await soundtrackManager.start();
          } catch (e) {
             console.error("Failed to start soundtrack (context running):", e);
          }
       }
    }
  }, [audioContext]);


  useEffect(() => {
    const handleInteractionToResumeAudio = async () => {
      await resumeContext();
      if (audioContext && (audioContext.state === 'running' || audioContextResumed.current)) {
        document.removeEventListener('click', handleInteractionToResumeAudio);
        document.removeEventListener('touchstart', handleInteractionToResumeAudio);
      }
    };

    if (audioContext && audioContext.state === 'suspended' && !audioContextResumed.current) {
      document.addEventListener('click', handleInteractionToResumeAudio, { once: true });
      document.addEventListener('touchstart', handleInteractionToResumeAudio, { once: true });
    }

    return () => {
      document.removeEventListener('click', handleInteractionToResumeAudio);
      document.removeEventListener('touchstart', handleInteractionToResumeAudio);
    };
  }, [audioContext, resumeContext]);


  useEffect(() => {
    if (gainNodeRef.current) {
      // Apply scaling factor to the volume
      gainNodeRef.current.gain.setValueAtTime(volume * SFX_VOLUME_SCALING, audioContext?.currentTime ?? 0);
    }
    localStorage.setItem(LOCAL_STORAGE_VOLUME_KEY, volume.toString());
  }, [volume, audioContext]);

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
          if (path.includes("lost_") || path.includes("gained_")) {
            console.warn(`Placeholder sound file not found (this is expected if not yet added): ${path}`);
            return;
          }
          throw new Error(`Failed to fetch ${path}: ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        soundBuffers.current[type] = soundBuffers.current[type] || [];
        soundBuffers.current[type]![bufferIndex] = audioBuffer;
      } catch (e: unknown) {
        let message = `Error loading sound ${path}`;
        if (e instanceof Error) {
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
    if (!audioContext || !gainNodeRef.current) return;

    const buffersForType = soundBuffers.current[type];
    if (!buffersForType || buffersForType.length === 0 || buffersForType.every(b => !b)) {
      console.warn(`Sound buffers for type "${type}" not loaded, empty, or all failed to load.`);
      if (type === 'ball_lost_by_player' || type === 'ball_gained_by_player') {
        console.warn(`Falling back to 'ball_ownership_change' sound for ${type}.`);
        const fallbackBuffers = soundBuffers.current['ball_ownership_change'];
        if (fallbackBuffers && fallbackBuffers.length > 0 && fallbackBuffers.some(b => !!b)) {
          const validFallbackBuffers = fallbackBuffers.filter(b => !!b);
          const randomIndex = Math.floor(Math.random() * validFallbackBuffers.length);
          const bufferToPlay = validFallbackBuffers[randomIndex];
          if (bufferToPlay) {
            try {
              const source = audioContext.createBufferSource();
              source.buffer = bufferToPlay;
              source.connect(gainNodeRef.current);
              source.start(0);
            } catch (e: unknown) {
              console.error(`Error playing fallback sound for ${type}:`, e);
            }
          }
          return;
        }
      }
      return;
    }

    const validBuffers = buffersForType.filter(b => !!b);
    if (validBuffers.length === 0) {
      console.warn(`No valid sound buffers found for type "${type}" after filtering.`);
      return;
    }

    let bufferToPlay: AudioBuffer | undefined;
    if (index !== undefined && index >= 0 && index < validBuffers.length) {
      bufferToPlay = validBuffers[index];
    } else {
      const randomIndex = Math.floor(Math.random() * validBuffers.length);
      bufferToPlay = validBuffers[randomIndex];
    }

    if (bufferToPlay) {
      try {
        const source = audioContext.createBufferSource();
        source.buffer = bufferToPlay;
        source.connect(gainNodeRef.current);
        source.start(0);
      } catch (e: unknown) {
        let message = `Error playing sound ${type}`;
        if (e instanceof Error) {
          message = `${message}: ${e.message}`;
        }
        console.error(message, e);
      }
    } else {
      console.warn(`Buffer to play for sound type "${type}" is undefined after selection.`);
    }
  }, [audioContext]);

  const playSound = useCallback(
    async (type: SoundEventType, index?: number) => {
      if (!audioContext) return;
      if (volume === 0) return; // Don't play if volume is 0

      if (audioContext.state === 'suspended') {
        await resumeContext();
      }

      if (audioContext.state === 'running') {
        _playSoundInternal(type, index);
      } else {
        console.warn("AudioContext not running. Sound play might fail.");
      }
    },
    [audioContext, volume, _playSoundInternal, resumeContext]
  );

  const setVolume = useCallback((newVolume: number) => {
    const clampedVolume = Math.max(0, Math.min(1, newVolume));
    setVolumeState(clampedVolume);
  }, []);

  // --- Soundtrack Integration ---
  const [soundtrackVolume, setSoundtrackVolumeState] = useState<number>(() => {
    const stored = localStorage.getItem('pongo-soundtrack-volume');
    return stored ? parseFloat(stored) : 0.5;
  });

  useEffect(() => {
    soundtrackManager.setVolume(soundtrackVolume);
    localStorage.setItem('pongo-soundtrack-volume', soundtrackVolume.toString());
  }, [soundtrackVolume]);

  const setSoundtrackVolume = useCallback((newVolume: number) => {
    const clamped = Math.max(0, Math.min(1, newVolume));
    setSoundtrackVolumeState(clamped);
  }, []);

  return { 
    playSound, 
    setVolume, 
    volume, 
    isLoading, 
    error, 
    resumeContext,
    soundtrackVolume,
    setSoundtrackVolume
  };
}