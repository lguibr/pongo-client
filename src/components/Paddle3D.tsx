// File: src/components/Paddle3D.tsx
import React, { useRef, useEffect, useState, useMemo } from 'react';
import * as THREE from 'three';
import { Paddle as PaddleType } from '../types/game';
import { getPaddleColorByPlayerIndex } from '../utils/colors';

interface Paddle3DProps {
  data: PaddleType;
  position: [number, number, number];
}

// Flat material properties
const PADDLE_ROUGHNESS = 0.8;
const PADDLE_METALNESS = 0.1;
const PADDLE_EMISSIVE_INTENSITY_BASE = 0; // No base glow
const PADDLE_COLLISION_EMISSIVE_INTENSITY = 0.4; // Subtle glow on collision
const COLLISION_EFFECT_DURATION = 100; // ms for collision glow
const PADDLE_ENV_MAP_INTENSITY = 0.3;


const Paddle3D: React.FC<Paddle3DProps> = ({ data, position }) => {
  const meshRef = useRef<THREE.Mesh>(null!);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null!);
  const [currentEmissiveIntensity, setCurrentEmissiveIntensity] = useState(PADDLE_EMISSIVE_INTENSITY_BASE);

  const color = getPaddleColorByPlayerIndex(data.index);
  const baseColorThree = useMemo(() => new THREE.Color(color), [color]);

  const depth = (data.index === 0 || data.index === 2) ? data.width : data.height;
  const epsilon = 1e-5;
  const geometryArgs: [number, number, number] = [
    Math.max(epsilon, data.width),
    Math.max(epsilon, data.height),
    Math.max(epsilon, depth)
  ];

  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.position.set(...position);
    }
  }, [position]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.color.set(baseColorThree);
      materialRef.current.emissive.set(baseColorThree); // Emissive color same as base
      materialRef.current.roughness = PADDLE_ROUGHNESS;
      materialRef.current.metalness = PADDLE_METALNESS;
      materialRef.current.envMapIntensity = PADDLE_ENV_MAP_INTENSITY;
      materialRef.current.needsUpdate = true;
    }
  }, [baseColorThree]);

  useEffect(() => {
    let effectTimeout: ReturnType<typeof setTimeout> | undefined;
    if (data.collided) {
      setCurrentEmissiveIntensity(PADDLE_COLLISION_EMISSIVE_INTENSITY);
      effectTimeout = setTimeout(() => {
        setCurrentEmissiveIntensity(PADDLE_EMISSIVE_INTENSITY_BASE);
      }, COLLISION_EFFECT_DURATION);
    } else {
      // If not collided and current intensity is not base, reset it.
      // This handles cases where collision state might flip quickly.
      if (currentEmissiveIntensity !== PADDLE_EMISSIVE_INTENSITY_BASE) {
        setCurrentEmissiveIntensity(PADDLE_EMISSIVE_INTENSITY_BASE);
      }
    }
    return () => clearTimeout(effectTimeout);
  }, [data.collided, currentEmissiveIntensity]); // Added currentEmissiveIntensity to deps

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.emissiveIntensity = currentEmissiveIntensity;
    }
  }, [currentEmissiveIntensity]);

  return (
    <mesh ref={meshRef} castShadow receiveShadow>
      <boxGeometry args={geometryArgs} />
      <meshStandardMaterial
        ref={materialRef}
      // Properties set in useEffects
      />
      {/* Point light removed */}
    </mesh>
  );
};

export default React.memo(Paddle3D);