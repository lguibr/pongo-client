// Body text. `$tone` picks an AA colour token (C105).

import styled from 'styled-components';
import { theme } from '../theme';

export type TextTone = 'default' | 'muted' | 'danger' | 'success' | 'warn';

const TONES: Record<TextTone, string> = {
  default: theme.color.fg,
  muted: theme.color.muted,
  danger: theme.color.danger,
  success: theme.color.success,
  warn: theme.color.warn,
};

export const Text = styled.p<{ $tone?: TextTone; $center?: boolean }>`
  font-size: 1.25rem;
  line-height: 1.35;
  color: ${({ $tone = 'default' }) => TONES[$tone]};
  text-align: ${({ $center }) => ($center ? 'center' : 'inherit')};
`;

export const Caption = styled.span<{ $tone?: TextTone }>`
  font-size: 1.05rem;
  letter-spacing: 0.04em;
  color: ${({ $tone = 'muted' }) => TONES[$tone]};
`;
