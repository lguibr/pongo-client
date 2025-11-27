import React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import styled, { DefaultTheme } from 'styled-components';

const StyledSwitch = styled(SwitchPrimitive.Root)<{ theme: DefaultTheme }>`
  all: unset;
  width: 42px;
  height: 25px;
  background-color: ${({ theme }) => theme.colors.input};
  border-radius: 9999px;
  position: relative;
  box-shadow: 0 2px 10px ${({ theme }) => theme.colors.background};
  -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
  cursor: pointer;
  border: 1px solid ${({ theme }) => theme.colors.border};
  transition: all 0.2s;

  &:focus {
    box-shadow: 0 0 0 2px ${({ theme }) => theme.colors.background}, 0 0 0 4px ${({ theme }) => theme.colors.ring};
  }

  &[data-state='checked'] {
    background-color: ${({ theme }) => theme.colors.primary};
    border-color: ${({ theme }) => theme.colors.primary};
  }
`;

const StyledThumb = styled(SwitchPrimitive.Thumb)<{ theme: DefaultTheme }>`
  display: block;
  width: 21px;
  height: 21px;
  background-color: white;
  border-radius: 9999px;
  box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  transition: transform 100ms;
  transform: translateX(2px);
  will-change: transform;

  &[data-state='checked'] {
    transform: translateX(19px);
  }
`;

export const Toggle = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>((props, ref) => (
  <StyledSwitch ref={ref} {...props}>
    <StyledThumb />
  </StyledSwitch>
));

Toggle.displayName = SwitchPrimitive.Root.displayName;
