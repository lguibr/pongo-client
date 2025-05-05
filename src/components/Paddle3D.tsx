// File: src/components/Paddle3D.tsx
import React, { useRef, useEffect, useState, useMemo } from 'react';
import * as THREE from 'three';
import { Paddle as PaddleType } from '../types/game';
import { getPaddleColorByPlayerIndex } from '../utils/colors';

interface Paddle3DProps {
  data: PaddleType;
  position: [number, number, number];
}

const COLLISION_LIGHT_INTENSITY = 6; // Point light flash intensity
const COLLISION_MATERIAL_EMISSIVE_INTENSITY = 1.2; // How much the paddle material glows on hit
const COLLISION_EFFECT_DURATION = 150; // Duration of the flash/glow in ms

const Paddle3D: React.FC<Paddle3DProps> = ({ data, position }) => {
  const meshRef = useRef<THREE.Mesh>(null!);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null!);
  const lightRef = useRef<THREE.PointLight>(null!);
  const [pointLightIntensity, setPointLightIntensity] = useState(0);
  const [materialEmissiveIntensity, setMaterialEmissiveIntensity] = useState(0); // State for material glow
  const color = getPaddleColorByPlayerIndex(data.index);
  const lightColor = useMemo(() => new THREE.Color(color), [color]);

  // Determine depth based on orientation
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

  // Update color and base emissive properties
  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.color.set(color);
      // Set base emissive color (will be modulated by intensity)
      materialRef.current.emissive.set(color);
    }
    if (lightRef.current) {
      lightRef.current.color.set(lightColor);
    }
    // Set initial material emissive intensity (paddles don't have permanent glow)
    setMaterialEmissiveIntensity(0);
  }, [color, lightColor]);

  // Collision effect (flashing light + material glow)
  useEffect(() => {
    let effectTimeout: ReturnType<typeof setTimeout> | undefined;

    if (data.collided) {
      setPointLightIntensity(COLLISION_LIGHT_INTENSITY); // Turn point light on
      setMaterialEmissiveIntensity(COLLISION_MATERIAL_EMISSIVE_INTENSITY); // Make material glow brightly

      // Set a timeout to turn off both effects
      effectTimeout = setTimeout(() => {
        setPointLightIntensity(0);
        setMaterialEmissiveIntensity(0); // Reset to base (0 for paddles)
      }, COLLISION_EFFECT_DURATION);

    } else {
      // Ensure effects are off if not collided
      setPointLightIntensity(0);
      setMaterialEmissiveIntensity(0);
    }

    // Cleanup timeout on effect change or unmount
    return () => {
      clearTimeout(effectTimeout);
      // Ensure effects are reset if component unmounts during flash
      setPointLightIntensity(0);
      setMaterialEmissiveIntensity(0);
    };
  }, [data.collided]); // Depend only on collision state

  // Apply material emissive intensity state directly
  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.emissiveIntensity = materialEmissiveIntensity;
    }
  }, [materialEmissiveIntensity]);

  return (
    <mesh ref={meshRef} castShadow receiveShadow>
      <boxGeometry args={geometryArgs} />
      <meshStandardMaterial
        ref={materialRef}
        color={color}
        roughness={0.5}
        metalness={0.3}
        emissive={color} // Set emissive color to paddle color
        emissiveIntensity={materialEmissiveIntensity} // Controlled by state
      />
      {/* Point light for collision flash */}
      <pointLight
        ref={lightRef}
        color={lightColor}
        intensity={pointLightIntensity} // Controlled by state
        distance={Math.max(data.width, data.height) * 3}
        decay={2}
      />
    </mesh>
  );
};

export default React.memo(Paddle3D);