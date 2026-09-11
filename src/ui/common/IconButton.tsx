// A square icon button with a required accessible name (C25). `pressed` makes it a toggle (aria-pressed).

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styled from 'styled-components';
import { theme } from '../theme';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  label: string;
  pressed?: boolean;
  dimmed?: boolean;
  children: ReactNode;
}

const Square = styled.button<{ $dimmed: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: ${theme.size.touch};
  height: ${theme.size.touch};
  flex: none;
  border-radius: ${theme.size.radius};
  color: ${theme.color.fg};
  opacity: ${({ $dimmed }) => ($dimmed ? 0.5 : 0.9)};
  transition: opacity ${theme.dur.fast}, background ${theme.dur.fast};

  &:hover:not(:disabled) {
    opacity: 1;
    background: ${theme.color.secondary};
  }

  & > svg {
    pointer-events: none;
  }
`;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, pressed, dimmed = false, type = 'button', title, children, ...rest },
  ref,
) {
  return (
    <Square
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      $dimmed={dimmed}
      {...rest}
    >
      {children}
    </Square>
  );
});
