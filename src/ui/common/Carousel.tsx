// The rules carousel (E52; C105, C106): today's embla slides with labelled previous and next buttons, dots
// that are real buttons with aria-current, and a pause button. Autoplay (4 s) is off under reduced motion
// unless the viewer presses play.
//
// The plugin runs with stopOnInteraction: a drag stops it and embla never restarts it by itself (its own
// restart would ignore Pause and reduced motion). This component resumes it after a drag, or after focus
// leaves the slides, only while the viewer's choice is playing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useEmblaCarousel from 'embla-carousel-react';
import Autoplay from 'embla-carousel-autoplay';
import { ArrowLeft, ArrowRight, Pause, Play } from 'lucide-react';
import styled from 'styled-components';
import { useReducedMotion } from '../../state/hooks';
import { theme } from '../theme';
import { IconButton } from './IconButton';

export interface CarouselSlide { image: string; alt: string; text: string }

export const AUTOPLAY_MS = 4000;

const Root = styled.section`
  width: 100%;
  max-width: 600px;
  margin: 0 auto;
`;

const Viewport = styled.div`
  overflow: hidden;
  border-radius: ${theme.size.radius};
`;

const Track = styled.div`
  display: flex;
  touch-action: pan-y pinch-zoom;
  margin-left: -1rem;
`;

const Slide = styled.div`
  flex: 0 0 100%;
  min-width: 0;
  padding-left: 1rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  text-align: center;

  & img {
    width: auto;
    max-height: 120px;
    image-rendering: pixelated;
    border-radius: ${theme.size.radius};
  }

  & p {
    font-size: 1.2rem;
    line-height: 1.35;
    max-width: 34ch;
  }
`;

// Previous at the left edge, next at the right, the dots and the pause button centred between them. Below
// 360 px the four dots and two arrows (6 x 44 = 264 px) fill the row, so the pause button wraps to its own
// centred row and every target keeps 44 x 44 (9.8).
const Controls = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 0.5rem;
`;

const Prev = styled(IconButton)`
  margin-right: auto;
`;

const Next = styled(IconButton)`
  margin-left: auto;
  order: 1;
`;

const Dots = styled.div`
  display: flex;
  align-items: center;
`;

const PauseSlot = styled.div`
  display: flex;
  justify-content: center;

  @media (max-width: 359px) {
    order: 2;
    flex-basis: 100%;
  }
`;

const Dot = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: ${theme.size.touch};
  height: ${theme.size.touch};

  &::after {
    content: '';
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: ${theme.color.dot};
    transition: background ${theme.dur.fast}, transform ${theme.dur.fast};
  }

  &[aria-current='true']::after {
    background: ${theme.color.primary};
    transform: scale(1.2);
  }
`;

type Choice = 'auto' | 'paused' | 'playing';

export function Carousel({ slides, label }: { slides: readonly CarouselSlide[]; label: string }): JSX.Element {
  const reduced = useReducedMotion();
  const plugins = useMemo(
    () => [Autoplay({ delay: AUTOPLAY_MS, playOnInit: false, stopOnInteraction: true, stopOnFocusIn: true })],
    [],
  );
  const [viewportRef, api] = useEmblaCarousel({ loop: true }, plugins);
  const [selected, setSelected] = useState(0);
  const [choice, setChoice] = useState<Choice>('auto');
  const playing = choice === 'playing' || (choice === 'auto' && !reduced);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    if (!api) return;
    const onSelect = (): void => setSelected(api.selectedScrollSnap());
    const resume = (): void => {
      const autoplay = api.plugins().autoplay;
      if (playingRef.current && autoplay) autoplay.play();
    };
    const container = api.containerNode();
    onSelect();
    api.on('select', onSelect);
    api.on('reInit', onSelect);
    api.on('pointerUp', resume);
    container.addEventListener('focusout', resume);
    return () => {
      api.off('select', onSelect);
      api.off('reInit', onSelect);
      api.off('pointerUp', resume);
      container.removeEventListener('focusout', resume);
    };
  }, [api]);

  useEffect(() => {
    const autoplay = api?.plugins().autoplay;
    if (!autoplay) return;
    if (playing) autoplay.play();
    else autoplay.stop();
  }, [api, playing]);

  const prev = useCallback(() => api?.scrollPrev(), [api]);
  const next = useCallback(() => api?.scrollNext(), [api]);

  return (
    <Root aria-label={label} aria-roledescription="carousel">
      <Viewport ref={viewportRef}>
        <Track aria-live={playing ? 'off' : 'polite'}>
          {slides.map((s, i) => (
            <Slide key={s.image} role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${slides.length}`}>
              <img src={s.image} alt={s.alt} draggable={false} />
              <p>{s.text}</p>
            </Slide>
          ))}
        </Track>
      </Viewport>
      <Controls>
        <Prev label="Previous rule" onClick={prev}>
          <ArrowLeft size={20} />
        </Prev>
        <Dots>
          {slides.map((s, i) => (
            <Dot
              key={s.image}
              type="button"
              aria-label={`Go to rule ${i + 1}`}
              aria-current={i === selected ? 'true' : undefined}
              onClick={() => api?.scrollTo(i)}
            />
          ))}
        </Dots>
        <PauseSlot>
          <IconButton
            label={playing ? 'Pause slideshow' : 'Play slideshow'}
            onClick={() => setChoice(playing ? 'paused' : 'playing')}
          >
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </IconButton>
        </PauseSlot>
        <Next label="Next rule" onClick={next}>
          <ArrowRight size={20} />
        </Next>
      </Controls>
    </Root>
  );
}
