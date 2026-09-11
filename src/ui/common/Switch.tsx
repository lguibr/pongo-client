// A native switch: <button role="switch" aria-checked> with a <label for>, so clicking the text toggles it.

import styled from 'styled-components';
import { theme } from '../theme';

export interface SwitchProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

const Row = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-height: ${theme.size.touch};
`;

const Track = styled.button`
  position: relative;
  flex: none;
  width: 44px;
  height: 26px;
  border-radius: 999px;
  border: 1px solid ${theme.color.border};
  background: ${theme.color.secondary};
  transition: background ${theme.dur.fast}, border-color ${theme.dur.fast};

  &[aria-checked='true'] {
    background: ${theme.color.primary};
    border-color: ${theme.color.primary};
  }

  &::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #ffffff;
    transition: transform ${theme.dur.fast};
  }

  &[aria-checked='true']::after {
    transform: translateX(18px);
  }

  /* The visible track is small; this keeps the touch target at 44 px. */
  &::before {
    content: '';
    position: absolute;
    inset: -9px 0;
  }
`;

const Label = styled.label`
  cursor: pointer;
  user-select: none;
`;

export function Switch({ id, label, checked, onChange, disabled }: SwitchProps): JSX.Element {
  return (
    <Row>
      <Track
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
      <Label htmlFor={id}>{label}</Label>
    </Row>
  );
}
