import React, { useCallback, useEffect, useState } from 'react';
import useEmblaCarousel from 'embla-carousel-react';
import Autoplay from 'embla-carousel-autoplay';
import styled, { DefaultTheme } from 'styled-components';
import { Button } from './Button';
import { ArrowLeft, ArrowRight } from 'lucide-react';

const CarouselWrapper = styled.div`
  position: relative;
  width: 100%;
  max-width: 600px;
  margin: 0 auto;
`;

const Viewport = styled.div`
  overflow: hidden;
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  /* Border and background removed for cleaner look */
`;

const Container = styled.div`
  display: flex;
  touch-action: pan-y pinch-zoom;
  margin-left: -1rem; /* Negative margin for spacing */
`;

const Slide = styled.div`
  transform: translate3d(0, 0, 0);
  flex: 0 0 100%;
  min-width: 0;
  padding-left: 1rem; /* Padding for spacing */
`;

const SlideContent = styled.div<{ theme: DefaultTheme }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0.25rem; /* Aggressively reduced padding */
  gap: 0.5rem;
  height: 100%;
  text-align: center;
`;

const SlideImage = styled.img`
  max-width: 100%;
  max-height: 120px; /* Aggressively reduced max-height */
  border-radius: 4px;
  /* Border and shadow removed */
`;

const Controls = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 0.5rem; /* Reduced margin */
  padding: 0 1rem;
`;

const Dots = styled.div`
  display: flex;
  gap: 0.5rem;
`;

const Dot = styled.button<{ $active: boolean; theme: DefaultTheme }>`
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: none;
  background-color: ${({ $active, theme }) => $active ? theme.colors.primary : theme.colors.muted};
  cursor: pointer;
  transition: all 0.2s;
  padding: 0;

  &:hover {
    background-color: ${({ $active, theme }) => $active ? theme.colors.primary : theme.colors.mutedForeground};
  }
`;

const NavButton = styled(Button)`
  width: 40px;
  height: 40px;
  padding: 0;
  border-radius: 50%;
`;

interface CarouselProps {
  slides: {
    image: string;
    text: string;
  }[];
}

export const Carousel: React.FC<CarouselProps> = ({ slides }) => {
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: true }, [Autoplay({ delay: 4000 })]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollSnaps, setScrollSnaps] = useState<number[]>([]);

  const scrollPrev = useCallback(() => emblaApi && emblaApi.scrollPrev(), [emblaApi]);
  const scrollNext = useCallback(() => emblaApi && emblaApi.scrollNext(), [emblaApi]);
  const scrollTo = useCallback((index: number) => emblaApi && emblaApi.scrollTo(index), [emblaApi]);

  const onSelect = useCallback(() => {
    if (!emblaApi) return;
    setSelectedIndex(emblaApi.selectedScrollSnap());
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    onSelect();
    setScrollSnaps(emblaApi.scrollSnapList());
    emblaApi.on('select', onSelect);
    emblaApi.on('reInit', onSelect);
  }, [emblaApi, onSelect]);

  return (
    <CarouselWrapper>
      <Viewport ref={emblaRef}>
        <Container>
          {slides.map((slide, index) => (
            <Slide key={index}>
              <SlideContent>
                <SlideImage src={slide.image} alt={`Rule ${index + 1}`} />
                <div style={{ fontSize: '1.2rem', lineHeight: '1.4' }}>{slide.text}</div>
              </SlideContent>
            </Slide>
          ))}
        </Container>
      </Viewport>

      <Controls>
        <NavButton variant="outline" onClick={scrollPrev} aria-label="Previous slide">
          <ArrowLeft size={20} />
        </NavButton>

        <Dots>
          {scrollSnaps.map((_, index) => (
            <Dot
              key={index}
              $active={index === selectedIndex}
              onClick={() => scrollTo(index)}
              aria-label={`Go to slide ${index + 1}`}
            />
          ))}
        </Dots>

        <NavButton variant="outline" onClick={scrollNext} aria-label="Next slide">
          <ArrowRight size={20} />
        </NavButton>
      </Controls>
    </CarouselWrapper>
  );
};
