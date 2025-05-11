// File: src/components/effects/BallTrail.tsx
import React from 'react'; // Removed useMemo
import { Trail } from '@react-three/drei';
import * as THREE from 'three';

interface BallTrailProps {
  target: React.RefObject<THREE.Object3D>;
  color: THREE.Color;
  width: number;
  length?: number;
  decay?: number;
  attenuation?: (width: number) => number;
  visible?: boolean;
}

const BallTrail: React.FC<BallTrailProps> = ({
  target,
  color,
  width,
  length = 12,
  decay = 1.1,
  attenuation = (w) => w * 0.95,
  visible = true,
}) => {
  if (!visible || !target.current) {
    return null;
  }

  const mutableTargetRef = target as React.MutableRefObject<THREE.Object3D>;

  return (
    <Trail
      target={mutableTargetRef}
      color={color}
      length={length}
      decay={decay}
      width={width}
      attenuation={attenuation}
      stride={0}
      interval={1}
    />
  );
};

export default React.memo(BallTrail);