import styled, { DefaultTheme, css } from 'styled-components';

interface TypographyProps {
  variant?: 'h1' | 'h2' | 'h3' | 'body' | 'caption' | 'logo';
  color?: string;
  align?: 'left' | 'center' | 'right';
  theme: DefaultTheme;
}

const getVariantStyles = (variant: TypographyProps['variant'] = 'body', theme: DefaultTheme) => {
  switch (variant) {
    case 'logo':
      return css`
        font-family: ${theme.fonts.primary};
        font-weight: 700;
        font-size: 2.5rem;
        letter-spacing: -0.02em;
        background: linear-gradient(to right, #3b82f6, #8b5cf6);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        text-shadow: 0 0 30px rgba(59, 130, 246, 0.5);
      `;
    case 'h1':
      return css`
        font-family: ${theme.fonts.primary};
        font-weight: 700;
        font-size: 2.5rem;
        letter-spacing: -0.02em;
        line-height: 1.2;
      `;
    case 'h2':
      return css`
        font-family: ${theme.fonts.primary};
        font-weight: 600;
        font-size: 2rem;
        letter-spacing: -0.01em;
        line-height: 1.3;
      `;
    case 'h3':
      return css`
        font-family: ${theme.fonts.primary};
        font-weight: 600;
        font-size: 1.5rem;
        line-height: 1.4;
      `;
    case 'caption':
      return css`
        font-family: ${theme.fonts.primary};
        font-size: 0.875rem;
        color: ${theme.colors.mutedForeground};
      `;
    case 'body':
    default:
      return css`
        font-family: ${theme.fonts.primary};
        font-size: 1rem;
        line-height: 1.5;
      `;
  }
};

export const Typography = styled.div<TypographyProps>`
  ${({ variant, theme }) => getVariantStyles(variant, theme)}
  color: ${({ color, theme }) => color || theme.colors.foreground};
  text-align: ${({ align }) => align || 'left'};
  margin: 0;
`;
