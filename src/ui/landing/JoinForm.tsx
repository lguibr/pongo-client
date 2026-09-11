// Join by code (C100, C101): a labelled form, so Enter submits. The code is upper-cased as it is typed and
// validated with normalizeRoomCode; an invalid code shows an inline error linked by aria-describedby.
// maxLength (6) would cut a pasted code with surrounding spaces before onChange sees it, so a paste is
// cleaned first: whitespace removed, upper-cased, inserted at the caret, then clipped to 6.

import { useId, useRef, useState } from 'react';
import type { ClipboardEvent, FormEvent } from 'react';
import styled from 'styled-components';
import { normalizeRoomCode } from '../../net/roomCode';
import type { RoomCode } from '../../session/types';
import { Button } from '../common/Button';
import { theme } from '../theme';

const CODE_LENGTH = 6;

const JOIN_ERRORS = {
  empty: 'Enter the 6-character room code.',
  invalid: 'Room codes are 6 characters: digits 0–9 and letters A–F.',
} as const;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
`;

const Label = styled.label`
  color: ${theme.color.muted};
  font-size: 1.1rem;
`;

const Input = styled.input`
  width: 100%;
  min-height: ${theme.size.touch};
  padding: 8px 12px;
  border: 1px solid ${theme.color.border};
  border-radius: ${theme.size.radius};
  background: ${theme.color.bg};
  color: ${theme.color.fg};
  font-family: ${theme.font};
  font-size: 1.5rem;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 0.2em;

  &::placeholder {
    color: #71717a;
    letter-spacing: 0.1em;
  }
  &[aria-invalid='true'] {
    border-color: ${theme.color.danger};
  }
  &:focus-visible {
    outline: 2px solid ${theme.color.focus};
    outline-offset: 1px;
  }
`;

const ErrorText = styled.p`
  color: #f87171;
  font-size: 1.1rem;
`;

export function JoinForm({ onJoin }: { onJoin: (code: RoomCode) => void }): JSX.Element {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const code = normalizeRoomCode(value);
    if (code === null) {
      setError(value.trim() === '' ? JOIN_ERRORS.empty : JOIN_ERRORS.invalid);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    onJoin(code);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const el = e.currentTarget;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const pasted = e.clipboardData.getData('text');
    e.preventDefault();
    setValue((value.slice(0, start) + pasted + value.slice(end)).replace(/\s+/g, '').toUpperCase().slice(0, CODE_LENGTH));
    if (error !== null) setError(null);
  };

  return (
    <Form onSubmit={onSubmit} noValidate>
      <Label htmlFor={inputId}>Room code</Label>
      <Input
        ref={inputRef}
        id={inputId}
        name="code"
        value={value}
        onChange={(e) => {
          setValue(e.target.value.toUpperCase());
          if (error !== null) setError(null);
        }}
        onPaste={onPaste}
        maxLength={CODE_LENGTH}
        placeholder="ABC123"
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        aria-invalid={error !== null}
        aria-describedby={error !== null ? errorId : undefined}
      />
      {error !== null && <ErrorText id={errorId}>{error}</ErrorText>}
      <Button type="submit" variant="secondary" block>
        Join
      </Button>
    </Form>
  );
}
