// File: src/components/Brick3D.tsx
import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import * as THREE from 'three';
import { useSpring, animated } from '@react-spring/three';
import { RoundedBox } from '@react-three/drei';

import theme from '../styles/theme';
import BrickShatterEffect from './effects/BrickShatterEffect';

interface Brick3DProps {
  life: number;
  type: number;
  cellSize: number;
  position: [number, number, number];
}

interface ShatterEffectInstance {
  id: string;
  centerPosition: THREE.Vector3;
  layerDimensions: { width: number; height: number; depth: number };
  color: THREE.Color;
}

const getBrickColor = (life: number, type: number): THREE.Color => {
  if (type === 2 || life <= 0) return new THREE.Color(theme.colors.background);
  const lifeIndex = Math.max(0, life - 1);
  const colorHex = theme.colors.brickLife[
    Math.min(lifeIndex, theme.colors.brickLife.length - 1)
  ];
  return new THREE.Color(colorHex);
};

const MIN_VISIBLE_DEPTH_SCALE = 0.001;

const BRICK_ROUNDING_RADIUS_FACTOR = 0.03;
const BRICK_BEVEL_SEGMENTS = 4;

const BRICK_ROUGHNESS = 0.75;
const BRICK_METALNESS = 0.05;
const BRICK_TRANSMISSION = 0.3;
const BRICK_OPACITY = 0.85;
const BRICK_IOR = 1.0;
const BRICK_THICKNESS_FACTOR_FOR_TRANSMISSION = 0.1;
const BRICK_ENV_MAP_INTENSITY = 0.2;


const Brick3D: React.FC<Brick3DProps> = ({ life, type, cellSize, position }) => {
  const meshRef = useRef<THREE.Mesh>(null!);
  const materialRef = useRef<THREE.MeshPhysicalMaterial>(null!);
  const previousLife = useRef<number>(life);

  const [activeShatters, setActiveShatters] = useState<ShatterEffectInstance[]>([]);

  const calculateCurrentDepth = useCallback((currentLifeVal: number) => {
    if (type === 2 || currentLifeVal <= 0) return MIN_VISIBLE_DEPTH_SCALE * cellSize;
    return Math.max(
      MIN_VISIBLE_DEPTH_SCALE * cellSize,
      currentLifeVal * theme.sizes.brickDepthPerLifeUnit * cellSize
    );
  }, [type, cellSize]);

  const currentDepth = useMemo(() => calculateCurrentDepth(life), [life, calculateCurrentDepth]);
  const currentColor = useMemo(() => getBrickColor(life, type), [life, type]);
  const isActuallyVisible = type !== 2 && life > 0;

  const AnimatedRoundedBox = animated(RoundedBox);

  const { animatedDepth } = useSpring({
    animatedDepth: currentDepth,
    config: { mass: 0.5, tension: 180, friction: 20 },
  });

  const currentOpacitySetting = useMemo(() => {
    if (!isActuallyVisible) return 0.0;
    return BRICK_OPACITY;
  }, [isActuallyVisible]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.color.set(currentColor);
      materialRef.current.opacity = currentOpacitySetting;
      materialRef.current.transparent = isActuallyVisible && (BRICK_TRANSMISSION > 0 || currentOpacitySetting < 1.0);
      materialRef.current.depthWrite = !materialRef.current.transparent || currentOpacitySetting > 0.95;

      materialRef.current.transmission = isActuallyVisible ? BRICK_TRANSMISSION : 0;
      materialRef.current.thickness = isActuallyVisible ? animatedDepth.get() * BRICK_THICKNESS_FACTOR_FOR_TRANSMISSION : 0;

      materialRef.current.roughness = BRICK_ROUGHNESS;
      materialRef.current.metalness = BRICK_METALNESS;
      materialRef.current.ior = BRICK_IOR;
      materialRef.current.clearcoat = 0;
      materialRef.current.sheen = 0;
      materialRef.current.emissiveIntensity = 0;
      materialRef.current.envMapIntensity = BRICK_ENV_MAP_INTENSITY;
      materialRef.current.needsUpdate = true;
    }
  }, [currentColor, isActuallyVisible, currentOpacitySetting, animatedDepth]);


  useEffect(() => {
    const prevLifeValue = previousLife.current;

    if (life < prevLifeValue && prevLifeValue > 0) { // Trigger if life decreased and was previously > 0
      const colorBeforeHit = getBrickColor(prevLifeValue, type);
      // Calculate how many "layers" of life were lost.
      // If life goes from 3 to 0, lostLifeLayers is 3.
      // If life goes from 1 to 0, lostLifeLayers is 1.
      const lostLifeLayers = prevLifeValue - Math.max(0, life);


      for (let i = 0; i < lostLifeLayers; i++) {
        // lifeOfLayerBeingShattered is the life value *before* this specific layer was lost.
        const lifeOfLayerBeingShattered = prevLifeValue - i;
        if (lifeOfLayerBeingShattered <= 0) continue; // Should not happen if lostLifeLayers is correct

        const depthOfLayerBeforeShatter = calculateCurrentDepth(lifeOfLayerBeingShattered);
        // The depth after this specific layer is lost. If it's the last life, this will be effectively 0.
        const depthOfLayerAfterShatter = calculateCurrentDepth(lifeOfLayerBeingShattered - 1);

        const shatteredLayerThickness = Math.max(0.001 * cellSize, depthOfLayerBeforeShatter - depthOfLayerAfterShatter);

        if (shatteredLayerThickness > 0.0005 * cellSize) {
          const shatterId = `shatter-${Date.now()}-${Math.random()}-${i}`;
          // Z position of the center of the shattering layer
          const shatterLayerCenterZ = position[2] + depthOfLayerAfterShatter + (shatteredLayerThickness / 2);
          const Z_OFFSET_FOR_SHATTER = shatteredLayerThickness * 0.05;

          setActiveShatters(prev => [
            ...prev,
            {
              id: shatterId,
              centerPosition: new THREE.Vector3(position[0], position[1], shatterLayerCenterZ + Z_OFFSET_FOR_SHATTER),
              layerDimensions: {
                width: cellSize * 0.88,
                height: cellSize * 0.88,
                depth: shatteredLayerThickness,
              },
              color: colorBeforeHit.clone(),
            },
          ]);
        }
      }
    }
    previousLife.current = life;
  }, [life, type, cellSize, position, calculateCurrentDepth]);

  const handleShatterComplete = useCallback((id: string) => {
    setActiveShatters(prev => prev.filter(s => s.id !== id));
  }, []);

  if (!isActuallyVisible && activeShatters.length === 0) {
    return null;
  }

  const boxWidth = cellSize * 0.88;
  const boxHeight = cellSize * 0.88;
  const radius = boxWidth * BRICK_ROUNDING_RADIUS_FACTOR;

  return (
    <>
      {isActuallyVisible && (
        <group position={position}>
          <AnimatedRoundedBox
            ref={meshRef}
            castShadow
            receiveShadow
            args={[boxWidth, boxHeight, 1]}
            radius={radius}
            smoothness={BRICK_BEVEL_SEGMENTS}
            scale-z={animatedDepth}
            position-z={animatedDepth.to(ad => ad / 2)}
          >
            <meshPhysicalMaterial
              ref={materialRef}
            />
          </AnimatedRoundedBox>
        </group>
      )}
      {activeShatters.map(shatter => (
        <BrickShatterEffect
          key={shatter.id}
          id={shatter.id}
          centerPosition={shatter.centerPosition}
          layerDimensions={shatter.layerDimensions}
          color={shatter.color}
          onComplete={handleShatterComplete}
        />
      ))}
    </>
  );
};

export default React.memo(Brick3D);