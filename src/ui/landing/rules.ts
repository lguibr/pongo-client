// Rule slides (C110). The images are imported, so Vite content-hashes them; the alt text describes each
// picture, and the caption states the rule.

import rule1 from '../../assets/rules/rule1.png';
import rule2 from '../../assets/rules/rule2.png';
import rule3 from '../../assets/rules/rule3.png';
import rule4 from '../../assets/rules/rule4.png';

export interface RuleSlide { image: string; alt: string; text: string }

export const RULES: readonly RuleSlide[] = [
  {
    image: rule1,
    alt: 'A blue ball above a blue paddle of the same colour.',
    text: '1. Every player controls a coloured paddle and starts with a matching ball.',
  },
  {
    image: rule2,
    alt: 'A blue ball turning green as it bounces off a green paddle.',
    text: "2. Hitting another player's ball captures it, changing it to your colour.",
  },
  {
    image: rule3,
    alt: 'A blue ball splashing against the wall behind a blue paddle, with a red minus one above it.',
    text: '3. If a ball hits your wall, you lose a point. If it was your ball, you also lose ownership.',
  },
  {
    image: rule4,
    alt: 'A blue ball breaking a red brick wall, with a blue plus one beside it.',
    text: '4. When your ball breaks a brick, you score points.',
  },
];
