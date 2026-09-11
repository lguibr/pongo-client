// Semantic headings (C107): one h1 per screen, h2 per card. Sizes follow today's Typography variants.

import styled from 'styled-components';
import { theme } from '../theme';

export const H1 = styled.h1`
  font-family: ${theme.font};
  font-weight: 400;
  font-size: clamp(2.25rem, 6vw, 3rem);
  line-height: 1.1;
  letter-spacing: 0.01em;

  &:focus {
    outline: none;
  }
  &:focus-visible {
    outline: 2px solid ${theme.color.focus};
    outline-offset: 4px;
  }
`;

export const H2 = styled.h2`
  font-family: ${theme.font};
  font-weight: 400;
  font-size: 1.75rem;
  line-height: 1.2;
`;

export const H3 = styled.h3`
  font-family: ${theme.font};
  font-weight: 400;
  font-size: 1.4rem;
  line-height: 1.25;
`;
