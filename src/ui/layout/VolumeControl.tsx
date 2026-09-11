// One audio channel's control (C25, 9.8). The icon is a real toggle button (aria-pressed) that mutes with one
// tap at every width, as on phones today. At 768 px and wider the slider sits inline, as today. Narrower, a
// separate chevron button opens a popover holding the labelled slider; Escape or an outside click closes it
// and returns focus to the chevron.

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeEvent } from 'react';
import { ChevronDown, Gamepad2, Music } from 'lucide-react';
import styled from 'styled-components';
import { useSettings } from '../../state/hooks';
import { DEFAULT_SETTINGS } from '../../lib/settings';
import type { Settings } from '../../lib/settings';
import { IconButton } from '../common/IconButton';
import { theme } from '../theme';

export type AudioChannel = 'music' | 'sfx';

interface ChannelInfo {
  mute: string;
  slider: string;
  Icon: typeof Music;
  volumeKey: 'musicVolume' | 'sfxVolume';
  mutedKey: 'musicMuted' | 'sfxMuted';
}

const CHANNELS: Record<AudioChannel, ChannelInfo> = {
  music: { mute: 'Mute music', slider: 'Music volume', Icon: Music, volumeKey: 'musicVolume', mutedKey: 'musicMuted' },
  sfx: { mute: 'Mute sound effects', slider: 'Sound effects volume', Icon: Gamepad2, volumeKey: 'sfxVolume', mutedKey: 'sfxMuted' },
};

const WIDE_QUERY = '(min-width: 768px)';

function subscribeWide(cb: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(WIDE_QUERY);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}
const getWide = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches;

const Group = styled.div`
  position: relative;
  display: flex;
  align-items: center;
`;

const MuteSlash = styled.span<{ $on: boolean }>`
  position: relative;
  display: inline-flex;

  &::after {
    content: '';
    display: ${({ $on }) => ($on ? 'block' : 'none')};
    position: absolute;
    left: -3px;
    right: -3px;
    top: 50%;
    height: 2px;
    background: ${theme.color.fg};
    transform: rotate(-45deg);
  }
`;

/** The input itself is the 44 px touch target (9.8), inline and in the popover alike: tablets in portrait use
 *  the inline slider by touch, and the 60 px header fits it. The visible 8 px track is drawn by the track
 *  pseudo-elements, and the 18 px thumb is centred on it. */
const Slider = styled.input`
  width: 100px;
  height: ${theme.size.touch};
  margin: 0 8px 0 2px;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;

  &::-webkit-slider-runnable-track {
    height: 8px;
    border-radius: 5px;
    background: ${theme.color.secondary};
  }
  &::-moz-range-track {
    height: 8px;
    border-radius: 5px;
    background: ${theme.color.secondary};
  }
  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    box-sizing: border-box;
    margin-top: -5px; /* (8 px track − 18 px thumb) / 2 */
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: ${theme.color.fg};
    border: 2px solid ${theme.color.bg};
  }
  &::-moz-range-thumb {
    box-sizing: border-box;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: ${theme.color.fg};
    border: 2px solid ${theme.color.bg};
  }
`;

const Chevron = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: ${theme.size.touch};
  height: ${theme.size.touch};
  color: ${theme.color.muted};
  border-radius: ${theme.size.radius};

  &[aria-expanded='true'] > svg {
    transform: rotate(180deg);
  }
  &:hover {
    color: ${theme.color.fg};
  }
`;

const Popover = styled.div`
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 10px;
  background: ${theme.color.card};
  border: 1px solid ${theme.color.border};
  border-radius: ${theme.size.radius};
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
  z-index: ${theme.z.header};
  white-space: nowrap;

  & ${Slider} {
    width: 140px;
    margin: 0;
  }
`;

const percent = (v: number): string => `${Math.round(v * 100)}%`;

export function VolumeControl({ channel }: { channel: AudioChannel }): JSX.Element {
  const info = CHANNELS[channel];
  const [settings, update] = useSettings();
  const wide = useSyncExternalStore(subscribeWide, getWide, getWide);
  const [open, setOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const muted = settings[info.mutedKey];
  const volume = settings[info.volumeKey];

  const toggleMute = (): void => {
    const patch: Partial<Settings> = { [info.mutedKey]: !muted };
    // Unmuting at volume 0 would stay silent, so it restores the default level.
    if (muted && volume === 0) patch[info.volumeKey] = DEFAULT_SETTINGS[info.volumeKey];
    update(patch);
  };

  const onSlide = (e: ChangeEvent<HTMLInputElement>): void => {
    const v = Number(e.target.value);
    const patch: Partial<Settings> = { [info.volumeKey]: v };
    if (v > 0 && muted) patch[info.mutedKey] = false;
    update(patch);
  };

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) chevronRef.current?.focus();
  }, []);

  useEffect(() => {
    if (wide) setOpen(false);
  }, [wide]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (t !== null && (popoverRef.current?.contains(t) || chevronRef.current?.contains(t))) return;
      close(true);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close(true);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const slider = (
    <Slider
      type="range"
      min={0}
      max={1}
      step={0.01}
      value={volume}
      onChange={onSlide}
      aria-label={info.slider}
      aria-valuetext={muted ? `${percent(volume)}, muted` : percent(volume)}
      autoFocus={!wide}
    />
  );

  return (
    <Group>
      <IconButton label={info.mute} pressed={muted} dimmed={muted} onClick={toggleMute}>
        <MuteSlash $on={muted}>
          <info.Icon size={24} />
        </MuteSlash>
      </IconButton>
      {wide ? (
        slider
      ) : (
        <>
          <Chevron
            ref={chevronRef}
            type="button"
            aria-label={info.slider}
            aria-expanded={open}
            aria-controls={open ? popoverId : undefined}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronDown size={16} />
          </Chevron>
          {open && (
            <Popover id={popoverId} ref={popoverRef} role="group" aria-label={info.slider}>
              {slider}
              <span aria-hidden="true">{percent(volume)}</span>
            </Popover>
          )}
        </>
      )}
    </Group>
  );
}
