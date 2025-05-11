// File: src/components/icons/VolumeHighIcon.tsx
import React from 'react';

interface SVGIconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
  color?: string;
}

const VolumeHighIcon: React.FC<SVGIconProps> = ({ size = 24, color = 'currentColor', ...props }) => (
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
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
  </svg>
);

export default VolumeHighIcon;