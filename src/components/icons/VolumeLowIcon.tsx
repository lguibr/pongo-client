// File: src/components/icons/VolumeLowIcon.tsx
import React from 'react';

interface SVGIconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  color?: string;
}

const VolumeLowIcon: React.FC<SVGIconProps> = ({ size = 24, color = 'currentColor', ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
  </svg>
);

export default VolumeLowIcon;