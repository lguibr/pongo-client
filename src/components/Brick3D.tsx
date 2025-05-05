// File: src/components/Brick3D.tsx
import React, { useRef, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { useSpring, animated } from '@react-spring/three';
import { RoundedBox } from '@react-three/drei';

import theme from '../styles/theme';

interface Brick3DProps {
  life: number;
  type: number; // utils.CellType as number
  cellSize: number;
  position: [number, number, number]; // Base position from R3FCanvas
}

const getBrickColor = (life: number, type: number): string => {
  if (type === 2 || life <= 0) return theme.colors.background; // Type 2 is Empty
  const lifeIndex = Math.max(0, life - 1);
  return theme.colors.brickLife[
    Math.min(lifeIndex, theme.colors.brickLife.length - 1)
  ];
};

const MAX_LIFE_DEPTH_FACTOR = .2;
const BASE_DEPTH = .2;
const HIT_GLOW_INTENSITY = 1;
const HIT_EFFECT_DURATION = 150;
const BRICK_OPACITY = 1; // Keep translucency
const BRICK_ROUGHNESS = 0.9; // Increase roughness for matte look
const BRICK_METALNESS = 0.5; // Set metalness to 0 to remove reflections
const BRICK_ROUNDING_RADIUS = 0;
const BRICK_BEVEL_SEGMENTS = 10;
const MIN_VISIBLE_DEPTH_SCALE = 0

const Brick3D: React.FC<Brick3DProps> = ({ life, type, cellSize, position }) => {
  const meshRef = useRef<THREE.Mesh>(null!);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null!);
  const previousLife = useRef<number>(life);
  const [materialEmissiveIntensity, setMaterialEmissiveIntensity] = useState(0);
  const [emissiveColor, setEmissiveColor] = useState<string>(theme.colors.background);

  const currentColor = useMemo(() => getBrickColor(life, type), [life, type]);
  const isActuallyVisible = type !== 2 && life > 0;

  const targetScaleZ = useMemo(() => {
    if (!isActuallyVisible) return MIN_VISIBLE_DEPTH_SCALE;
    const depth = Math.max(BASE_DEPTH, BASE_DEPTH + (life - 1) * MAX_LIFE_DEPTH_FACTOR) * cellSize * 0.9;
    return Math.max(MIN_VISIBLE_DEPTH_SCALE, depth);
  }, [isActuallyVisible, life, cellSize]);

  const AnimatedRoundedBox = animated(RoundedBox);

  const { scaleZ } = useSpring({
    scaleZ: targetScaleZ,
    config: { mass: 1, tension: 180, friction: 15 },
  });

  useEffect(() => {
    if (materialRef.current && isActuallyVisible) {
      materialRef.current.color.set(currentColor);
    }
    if (materialRef.current) {
      materialRef.current.opacity = isActuallyVisible ? BRICK_OPACITY : 0;
      materialRef.current.transparent = isActuallyVisible;
      materialRef.current.depthWrite = !isActuallyVisible;
    }
  }, [currentColor, isActuallyVisible]);

  useEffect(() => {
    const wasVisible = type !== 2 && previousLife.current > 0;
    let effectTimeout: ReturnType<typeof setTimeout> | undefined;

    if (wasVisible && life < previousLife.current) {
      const colorBeforeHit = getBrickColor(previousLife.current, type);
      setEmissiveColor(colorBeforeHit);
      setMaterialEmissiveIntensity(HIT_GLOW_INTENSITY);

      effectTimeout = setTimeout(() => {
        setMaterialEmissiveIntensity(0);
      }, HIT_EFFECT_DURATION);
    } else {
      if (materialEmissiveIntensity > 0) {
        setMaterialEmissiveIntensity(0);
      }
    }

    previousLife.current = life;

    return () => {
      clearTimeout(effectTimeout);
      if (materialEmissiveIntensity > 0) {
        setMaterialEmissiveIntensity(0);
      }
    };
  }, [life, type, materialEmissiveIntensity]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.emissive.set(emissiveColor);
      materialRef.current.emissiveIntensity = materialEmissiveIntensity;
    }
  }, [emissiveColor, materialEmissiveIntensity]);

  const shouldRender = isActuallyVisible || materialEmissiveIntensity > 0;

  if (!shouldRender) {
    return null;
  }

  const boxWidth = cellSize * 0.9;
  const boxHeight = cellSize * 0.9;
  const radius = boxWidth * BRICK_ROUNDING_RADIUS;

  return (
    <group position={position}>
      <AnimatedRoundedBox
        ref={meshRef}
        castShadow
        receiveShadow
        args={[boxWidth, boxHeight, 1]} // Use fixed base depth
        radius={radius}
        smoothness={BRICK_BEVEL_SEGMENTS}
        scale-z={scaleZ} // Animate scale
        position-z={scaleZ.to(sz => sz / 2)} // Adjust position based on scale
      >
        <meshStandardMaterial
          ref={materialRef}
          color={currentColor}
          roughness={BRICK_ROUGHNESS} // Use updated roughness
          metalness={BRICK_METALNESS} // Use updated metalness (0)
          emissive={emissiveColor}
          emissiveIntensity={materialEmissiveIntensity}
          opacity={isActuallyVisible ? BRICK_OPACITY : 0}
          transparent={isActuallyVisible}
          depthWrite={!isActuallyVisible}
        />
      </AnimatedRoundedBox>
    </group>
  );
};

export default React.memo(Brick3D);