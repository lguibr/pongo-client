import React from 'react';
import styled, { DefaultTheme, css, keyframes } from 'styled-components';
import { Slot } from '@radix-ui/react-slot';
import { Loader2 } from 'lucide-react';

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' | 'link';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  asChild?: boolean;
  isLoading?: boolean;
  theme?: DefaultTheme;
}

const getVariantStyles = (variant: ButtonProps['variant'] = 'default', theme: DefaultTheme) => {
  switch (variant) {
    case 'secondary':
      return css`
        background-color: ${theme.colors.secondary};
        color: ${theme.colors.secondaryForeground};
        &:hover {
          background-color: ${theme.colors.secondary}cc;
        }
      `;
    case 'destructive':
      return css`
        background-color: ${theme.colors.destructive};
        color: ${theme.colors.destructiveForeground};
        &:hover {
          background-color: ${theme.colors.destructive}cc;
        }
      `;
    case 'outline':
      return css`
        border: 1px solid ${theme.colors.border};
        background-color: transparent;
        &:hover {
          background-color: ${theme.colors.accent};
          color: ${theme.colors.accentForeground};
        }
      `;
    case 'ghost':
      return css`
        background-color: transparent;
        &:hover {
          background-color: ${theme.colors.accent};
          color: ${theme.colors.accentForeground};
        }
      `;
    case 'link':
      return css`
        color: ${theme.colors.primary};
        text-decoration: underline;
        background-color: transparent;
        padding: 0;
        height: auto;
        &:hover {
          color: ${theme.colors.primary}cc;
        }
      `;
    case 'default':
    default:
      return css`
        background-color: ${theme.colors.primary};
        color: ${theme.colors.primaryForeground};
        box-shadow: 0 4px 0 ${theme.colors.primary}99;
        transform: translateY(0);
        transition: all 0.1s;
        
        &:hover {
          background-color: ${theme.colors.primary}cc;
          transform: translateY(-1px);
          box-shadow: 0 5px 0 ${theme.colors.primary}99;
        }
        
        &:active {
          transform: translateY(2px);
          box-shadow: 0 2px 0 ${theme.colors.primary}99;
        }
      `;
  }
};

const getSizeStyles = (size: ButtonProps['size'] = 'default') => {
  switch (size) {
    case 'sm':
      return css`
        height: 36px;
        padding: 0 12px;
        font-size: 0.875rem;
      `;
    case 'lg':
      return css`
        height: 48px;
        padding: 0 32px;
        font-size: 1.125rem;
      `;
    case 'icon':
      return css`
        height: 40px;
        width: 40px;
        padding: 0;
      `;
    case 'default':
    default:
      return css`
        height: 40px;
        padding: 0 16px;
        font-size: 1rem;
      `;
  }
};

const StyledButton = styled.button<ButtonProps>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: ${({ theme }) => theme.sizes.borderRadius};
  font-weight: 500;
  white-space: nowrap;
  transition: colors 0.2s;
  outline: none;
  cursor: pointer;
  border: none;
  
  &:disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  ${({ variant, theme }) => getVariantStyles(variant, theme)}
  ${({ size }) => getSizeStyles(size)}
`;

const Spinner = styled(Loader2)`
  margin-right: 8px;
  animation: ${spin} 1s linear infinite;
`;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', asChild = false, isLoading = false, children, ...props }, ref) => {
    const Comp = asChild ? Slot : StyledButton;
    return (
      <Comp
        ref={ref}
        variant={variant}
        size={size}
        disabled={isLoading || props.disabled}
        {...props}
      >
        {isLoading && <Spinner size={16} />}
        {children}
      </Comp>
    );
  }
);
Button.displayName = 'Button';
