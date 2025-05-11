// File: src/components/Ball3D.tsx
import React, { useRef, useEffect, useMemo, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Ball as BallType } from '../types/game';
import { getColorByOwnerIndex } from '../utils/colors';
import GhostTrail from './effects/GhostTrail';
import PhasingClones from './effects/PhasingClones';

interface Ball3DProps {
  data: BallType;
  position: [number, number, number];
}

const BALL_RENDER_ORDER = 1;

// Base Material Properties
const BALL_ROUGHNESS = 0.4; // More reflective
const BALL_METALNESS = 0.3; // Slightly more metallic
const BALL_ENV_MAP_INTENSITY = 0.7;

// Continuous Sine Glow
const BASE_EMISSIVE_PULSE_MIN = 0.1;
const BASE_EMISSIVE_PULSE_MAX = 0.3;
const BASE_EMISSIVE_PULSE_SPEED = 2.0; // Radians per second

// Phasing Material Properties
const PHASING_OPACITY = 0.65;
const PHASING_TRANSMISSION = 0.9;
const PHASING_IOR = 1.3;
const PHASING_THICKNESS_FACTOR = 0.6; // Relative to radius
const PHASING_EMISSIVE_INTENSITY = 0.25;
const PHASING_CLONE_MAX_OPACITY = 0.55;

// Collision Shine
const COLLISION_SHINE_ADDITIVE_INTENSITY = 0.5; // Added to current emissive
const COLLISION_SHINE_DURATION = 200; // ms

// Non-Permanent Ball Alpha
const NON_PERMANENT_ALPHA_MULTIPLIER = 0.8;


const Ball3D: React.FC<Ball3DProps> = ({ data, position }) => {
  const meshRef = useRef<THREE.Mesh>(null!);
  const materialRef = useRef<THREE.MeshPhysicalMaterial>(null!);

  const [collisionShineActive, setCollisionShineActive] = useState(false);
  const { clock } = useThree();

  const color = getColorByOwnerIndex(data.ownerIndex);
  const baseColorThree = useMemo(() => new THREE.Color(color), [color]);

  const renderRadius = useMemo(() => Math.max(data.radius, data.mass), [data.radius, data.mass]);

  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.position.set(...position);
    }
  }, [position]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.color.set(baseColorThree);
      materialRef.current.emissive.set(baseColorThree);
      materialRef.current.roughness = BALL_ROUGHNESS;
      materialRef.current.metalness = BALL_METALNESS;
      materialRef.current.envMapIntensity = BALL_ENV_MAP_INTENSITY;
      materialRef.current.needsUpdate = true;
    }
  }, [baseColorThree]);

  useEffect(() => {
    let shineTimeout: ReturnType<typeof setTimeout> | undefined;
    if (data.collided) {
      setCollisionShineActive(true);
      shineTimeout = setTimeout(() => {
        setCollisionShineActive(false);
      }, COLLISION_SHINE_DURATION);
    }
    return () => clearTimeout(shineTimeout);
  }, [data.collided]);

  useFrame(() => {
    if (!materialRef.current) return;

    const pulseTime = clock.getElapsedTime() * BASE_EMISSIVE_PULSE_SPEED;
    const sinePulse = (Math.sin(pulseTime) + 1) / 2;
    const basePulseIntensity = BASE_EMISSIVE_PULSE_MIN + sinePulse * (BASE_EMISSIVE_PULSE_MAX - BASE_EMISSIVE_PULSE_MIN);

    let finalEmissiveIntensity = basePulseIntensity;
    let finalOpacity = 1.0;
    let finalTransmission = 0;
    let finalIor = 1.5;
    let finalThickness = 0;

    if (!data.isPermanent) {
      finalOpacity *= NON_PERMANENT_ALPHA_MULTIPLIER;
    }

    if (data.phasing) {
      finalOpacity = PHASING_OPACITY * (!data.isPermanent ? NON_PERMANENT_ALPHA_MULTIPLIER : 1.0);
      finalTransmission = PHASING_TRANSMISSION;
      finalIor = PHASING_IOR;
      finalThickness = renderRadius * PHASING_THICKNESS_FACTOR;
      finalEmissiveIntensity = Math.max(finalEmissiveIntensity, PHASING_EMISSIVE_INTENSITY);
    }

    if (collisionShineActive) {
      finalEmissiveIntensity += COLLISION_SHINE_ADDITIVE_INTENSITY;
    }

    const finalTransparent = finalOpacity < 1.0 || finalTransmission > 0;
    const finalDepthWrite = !finalTransparent;

    materialRef.current.emissiveIntensity = finalEmissiveIntensity;
    materialRef.current.opacity = finalOpacity;
    materialRef.current.transparent = finalTransparent;
    materialRef.current.depthWrite = finalDepthWrite;

    materialRef.current.transmission = finalTransmission;
    materialRef.current.ior = finalIor;
    materialRef.current.thickness = finalThickness;

    materialRef.current.roughness = BALL_ROUGHNESS;
    materialRef.current.metalness = BALL_METALNESS;

    if (!materialRef.current.toneMapped) {
      materialRef.current.toneMapped = true;
    }
    materialRef.current.needsUpdate = true;
  });

  return (
    <>
      <mesh ref={meshRef} castShadow receiveShadow renderOrder={BALL_RENDER_ORDER}>
        <sphereGeometry args={[renderRadius, 24, 24]} />
        <meshPhysicalMaterial ref={materialRef} />
      </mesh>
      {data.phasing && meshRef.current && (
        <GhostTrail
          targetRef={meshRef}
          color={baseColorThree}
          radius={renderRadius * 0.8}
          trailLength={30}
          opacityDecay={0.85}
          scaleDecay={0.9}
          updateInterval={1}
          visible={true}
        />
      )}
      {data.phasing && meshRef.current && (
        <PhasingClones
          ballRef={meshRef}
          isPhasing={data.phasing}
          ballRadius={renderRadius}
          ballColor={baseColorThree}
          cloneCount={5}
          cloneLife={250}
          spawnRadiusFactor={2.0}
          maxOpacity={PHASING_CLONE_MAX_OPACITY}
        />
      )}
    </>
  );
};

export default React.memo(Ball3D);