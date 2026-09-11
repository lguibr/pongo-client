// The text button (C105). Today's look: VT323, 4 px radius, the primary button's 4 px drop edge. Every
// size keeps a 44 px minimum touch target, and :focus-visible shows a ring.

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import styled, { css } from 'styled-components';
import { theme } from '../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'lg' | 'xl';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
}

const VARIANTS: Record<ButtonVariant, ReturnType<typeof css>> = {
  primary: css`
    background: ${theme.color.primary};
    color: ${theme.color.primaryFg};
    box-shadow: 0 4px 0 #1e40af;
    &:hover:not(:disabled) { filter: brightness(1.1); }
    &:active:not(:disabled) { transform: translateY(calc(2px * ${theme.motion})); box-shadow: 0 2px 0 #1e40af; }
  `,
  secondary: css`
    background: ${theme.color.secondary};
    color: ${theme.color.fg};
    &:hover:not(:disabled) { background: #3f3f46; }
  `,
  outline: css`
    background: transparent;
    color: ${theme.color.fg};
    border: 1px solid ${theme.color.border};
    &:hover:not(:disabled) { background: ${theme.color.secondary}; }
  `,
  ghost: css`
    background: transparent;
    color: ${theme.color.fg};
    &:hover:not(:disabled) { background: ${theme.color.secondary}; }
  `,
  danger: css`
    background: #b91c1c;
    color: #ffffff;
    &:hover:not(:disabled) { background: #991b1b; }
  `,
};

const SIZES: Record<ButtonSize, ReturnType<typeof css>> = {
  md: css`min-height: ${theme.size.touch}; padding: 0 16px; font-size: 1.25rem;`,
  lg: css`min-height: 52px; padding: 0 28px; font-size: 1.5rem;`,
  xl: css`min-height: 64px; padding: 0 32px; font-size: 1.75rem; letter-spacing: 0.04em;`,
};

const StyledButton = styled.button<{ $variant: ButtonVariant; $size: ButtonSize; $block: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: ${theme.size.touch};
  border: 1px solid transparent;
  border-radius: ${theme.size.radius};
  font-family: ${theme.font};
  line-height: 1;
  white-space: nowrap;
  user-select: none;
  transition: filter ${theme.dur.fast}, background ${theme.dur.fast}, transform ${theme.dur.fast};
  width: ${({ $block }) => ($block ? '100%' : 'auto')};
  ${({ $variant }) => VARIANTS[$variant]}
  ${({ $size }) => SIZES[$size]}

  /* aria-disabled keeps a control focusable while it cannot act, so focus is not dropped to the body. */
  &:disabled,
  &[aria-disabled='true'] {
    opacity: 0.55;
  }
  &[aria-disabled='true'] {
    cursor: not-allowed;
  }
`;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', block = false, type = 'button', ...rest },
  ref,
) {
  return <StyledButton ref={ref} type={type} $variant={variant} $size={size} $block={block} {...rest} />;
});
