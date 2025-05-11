// File: src/components/Ball3D.tsx
import React, { useRef, useEffect, useMemo } from 'react'; // Removed useState
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Ball as BallType } from '../types/game';
import { getColorByOwnerIndex } from '../utils/colors';
import BallTrail from './effects/BallTrail';
import PhasingClones from './effects/PhasingClones';

interface Ball3DProps {
  data: BallType;
  position: [number, number, number];
}

const BALL_RENDER_ORDER = 1;

// Flat material properties
const BALL_ROUGHNESS = 0.7;
const BALL_METALNESS = 0.1;
const BALL_EMISSIVE_INTENSITY_BASE = 0; // No base glow
const BALL_ENV_MAP_INTENSITY = 0.4;

const PHASING_MAIN_BALL_OPACITY = 0.3; // Main ball more transparent during phasing
const PHASING_CLONE_MAX_OPACITY = 0.6;


const Ball3D: React.FC<Ball3DProps> = ({ data, position }) => {
  const meshRef = useRef<THREE.Mesh>(null!);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null!);

  const color = getColorByOwnerIndex(data.ownerIndex);
  const baseColorThree = useMemo(() => new THREE.Color(color), [color]);
  const trailColor = baseColorThree;

  const renderRadius = useMemo(() => Math.max(data.radius, data.mass), [data.radius, data.mass]);

  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.position.set(...position);
    }
  }, [position]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.color.set(baseColorThree);
      materialRef.current.emissive.set(baseColorThree); // Emissive color same as base
      materialRef.current.roughness = BALL_ROUGHNESS;
      materialRef.current.metalness = BALL_METALNESS;
      materialRef.current.envMapIntensity = BALL_ENV_MAP_INTENSITY;
      materialRef.current.needsUpdate = true;
    }
  }, [baseColorThree]);

  useFrame(() => {
    if (!materialRef.current) return;

    let currentEmissiveIntensity = BALL_EMISSIVE_INTENSITY_BASE;
    let currentOpacity = 1.0;
    let currentTransparent = false;
    let currentDepthWrite = true;

    if (data.phasing) {
      currentOpacity = PHASING_MAIN_BALL_OPACITY;
      currentTransparent = true;
      currentDepthWrite = false; // Allow clones to be seen through
      // Phasing balls might have a slight emissive pulse if desired, or rely on clones
      currentEmissiveIntensity = 0.1;
    }

    if (data.collided) { // Simple visual cue for collision - slight emissive pulse
      currentEmissiveIntensity = Math.max(currentEmissiveIntensity, 0.3);
    }


    materialRef.current.emissiveIntensity = currentEmissiveIntensity;
    materialRef.current.opacity = currentOpacity;
    materialRef.current.transparent = currentTransparent;
    materialRef.current.depthWrite = currentDepthWrite;

    // Ensure toneMapped is true for PBR consistency
    if (!materialRef.current.toneMapped) {
      materialRef.current.toneMapped = true;
      materialRef.current.needsUpdate = true;
    }
  });

  return (
    <>
      <mesh ref={meshRef} castShadow receiveShadow renderOrder={BALL_RENDER_ORDER}>
        <sphereGeometry args={[renderRadius, 24, 24]} /> {/* Slightly less segments for performance */}
        <meshStandardMaterial
          ref={materialRef}
        // Properties set in useEffect and useFrame
        />
        {/* Lights removed from ball, rely on scene lighting */}
      </mesh>
      {meshRef.current && (
        <BallTrail
          target={meshRef}
          color={trailColor}
          width={renderRadius * 0.8} // Slightly thinner trail
          length={10}
          decay={1.2} // Faster decay
          visible={!data.phasing} // Hide trail during phasing
        />
      )}
      {data.phasing && meshRef.current && (
        <PhasingClones
          ballRef={meshRef}
          isPhasing={data.phasing}
          ballRadius={renderRadius}
          ballColor={baseColorThree}
          cloneCount={5}
          cloneLife={250} // Shorter clone life
          spawnRadiusFactor={2.0}
          maxOpacity={PHASING_CLONE_MAX_OPACITY}
        />
      )}
    </>
  );
};

export default React.memo(Ball3D);