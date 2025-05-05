// File: src/components/Ball3D.tsx
import React, { useRef, useEffect, useState, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Ball as BallType } from '../types/game';
import { getColorByOwnerIndex } from '../utils/colors';

interface Ball3DProps {
  data: BallType;
  position: [number, number, number];
}

// --- Constants for Ball Appearance ---
const COLLISION_LIGHT_INTENSITY = 3;
const COLLISION_MATERIAL_EMISSIVE_INTENSITY = 1.5;
const COLLISION_EFFECT_DURATION = 150;

// Permanent Ball Appearance
const PERMANENT_BALL_OPACITY = 1.0;
const PERMANENT_BALL_ROUGHNESS = 0.6; // Lower for reflections
const PERMANENT_BALL_METALNESS = 0.8; // High for metallic look
const PERMANENT_BALL_BASE_EMISSIVE = 0.2; // Keep subtle glow

// Temporary Ball Appearance
const TEMPORARY_BALL_OPACITY = 1; // More visible than before
const TEMPORARY_BALL_ROUGHNESS = 1; // High for matte look
const TEMPORARY_BALL_METALNESS = 0.0; // No metalness/reflections
const TEMPORARY_BALL_BASE_EMISSIVE = 0.0; // No base glow

// Phasing Effect Constants
const PHASING_ALPHA_FREQUENCY = 3.0; // Faster pulse
const PHASING_ALPHA_MIN = 0.4;
const PHASING_ALPHA_MAX = 0.9;
const PHASING_EMISSIVE_FREQUENCY = 2.5; // Slightly different frequency
const PHASING_EMISSIVE_PULSE_AMOUNT = 0.15; // How much emissive pulses

// Render Order
const BALL_RENDER_ORDER = 1; // Render balls after default objects (bricks)

const Ball3D: React.FC<Ball3DProps> = ({ data, position }) => {
  const meshRef = useRef<THREE.Mesh>(null!);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null!);
  const lightRef = useRef<THREE.PointLight>(null!);
  const [pointLightIntensity, setPointLightIntensity] = useState(0);
  const [materialEmissiveIntensity, setMaterialEmissiveIntensity] = useState(0);
  const color = getColorByOwnerIndex(data.ownerIndex);
  const lightColor = useMemo(() => new THREE.Color(color), [color]);
  // const lastPhasingLogTime = useRef(0); // Removed log tracking
  // const loggedPhasingTrueThisFrame = useRef(false); // Removed log tracking

  const renderRadius = useMemo(() => Math.max(data.radius, data.mass), [data.radius, data.mass]);

  // Determine base properties based on permanence
  const baseMaterialProps = useMemo(() => ({
    opacity: data.isPermanent ? PERMANENT_BALL_OPACITY : TEMPORARY_BALL_OPACITY,
    roughness: data.isPermanent ? PERMANENT_BALL_ROUGHNESS : TEMPORARY_BALL_ROUGHNESS,
    metalness: data.isPermanent ? PERMANENT_BALL_METALNESS : TEMPORARY_BALL_METALNESS,
    baseEmissive: data.isPermanent ? PERMANENT_BALL_BASE_EMISSIVE : TEMPORARY_BALL_BASE_EMISSIVE,
    transparent: !data.isPermanent, // Initially transparent only if temporary
    depthWrite: data.isPermanent, // Initially write depth only if permanent
  }), [data.isPermanent]);

  useEffect(() => {
    if (meshRef.current) {
      meshRef.current.position.set(...position);
    }
  }, [position]);

  // Update static material properties and base emissive
  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.color.set(color);
      materialRef.current.emissive.set(color); // Emissive color is always the ball color
      materialRef.current.roughness = baseMaterialProps.roughness;
      materialRef.current.metalness = baseMaterialProps.metalness;
      // Set initial opacity/transparency based on calculated props
      materialRef.current.opacity = baseMaterialProps.opacity;
      materialRef.current.transparent = baseMaterialProps.transparent;
      materialRef.current.depthWrite = baseMaterialProps.depthWrite;
    }
    if (lightRef.current) {
      lightRef.current.color.set(lightColor);
    }
    // Set the base emissive intensity state
    setMaterialEmissiveIntensity(baseMaterialProps.baseEmissive);
  }, [color, lightColor, baseMaterialProps]); // Depend on baseMaterialProps

  // Phasing and Opacity/Transparency Management
  useFrame((state) => {
    // loggedPhasingTrueThisFrame.current = false; // Removed log tracking
    if (materialRef.current) {
      const time = state.clock.getElapsedTime(); // Use R3F clock for smoother animation
      let targetOpacity = baseMaterialProps.opacity; // Start with base opacity
      let currentEmissive = baseMaterialProps.baseEmissive; // Start with base emissive

      if (data.phasing) {
        // loggedPhasingTrueThisFrame.current = true; // Removed log tracking

        // Calculate pulsing alpha
        const alphaRange = PHASING_ALPHA_MAX - PHASING_ALPHA_MIN;
        targetOpacity = PHASING_ALPHA_MIN + (Math.sin(time * PHASING_ALPHA_FREQUENCY) + 1) / 2 * alphaRange;

        // Calculate pulsing emissive, only add if not currently in collision flash
        if (materialEmissiveIntensity <= baseMaterialProps.baseEmissive) {
          currentEmissive = baseMaterialProps.baseEmissive +
            (Math.sin(time * PHASING_EMISSIVE_FREQUENCY) + 1) / 2 * PHASING_EMISSIVE_PULSE_AMOUNT;
        }

        // Removed periodic log
        // const now = Date.now();
        // if (now - lastPhasingLogTime.current > 1000) {
        //   lastPhasingLogTime.current = now;
        // }
      }
      // else {
      //   lastPhasingLogTime.current = 0; // Removed log tracking
      // }

      // Apply collision glow if active (overrides phasing emissive)
      if (materialEmissiveIntensity > baseMaterialProps.baseEmissive) {
        currentEmissive = materialEmissiveIntensity;
      }

      // Set final material properties for the frame
      const isTransparent = targetOpacity < 1.0;
      materialRef.current.opacity = targetOpacity;
      materialRef.current.transparent = isTransparent;
      // Depth write should generally be true unless fully transparent or specifically needed otherwise
      // For phasing, we want it to interact normally with depth *except* for render order override.
      materialRef.current.depthWrite = !isTransparent;
      materialRef.current.emissiveIntensity = currentEmissive;
    }
  });

  // Collision effect (flashing light + material glow)
  useEffect(() => {
    let effectTimeout: ReturnType<typeof setTimeout> | undefined;

    if (data.collided) {
      setPointLightIntensity(COLLISION_LIGHT_INTENSITY);
      // Set emissive intensity high for the flash duration
      setMaterialEmissiveIntensity(COLLISION_MATERIAL_EMISSIVE_INTENSITY);

      effectTimeout = setTimeout(() => {
        setPointLightIntensity(0);
        // Reset emissive intensity back to its base value after the flash
        setMaterialEmissiveIntensity(baseMaterialProps.baseEmissive);
      }, COLLISION_EFFECT_DURATION);

    } else {
      // If not colliding, ensure intensity is at base level
      // (Check needed to avoid resetting during phasing right after collision ends)
      if (materialEmissiveIntensity > baseMaterialProps.baseEmissive) {
        setPointLightIntensity(0);
        setMaterialEmissiveIntensity(baseMaterialProps.baseEmissive);
      }
    }

    return () => {
      clearTimeout(effectTimeout);
      // Ensure effects are reset if component unmounts during flash
      setPointLightIntensity(0);
      setMaterialEmissiveIntensity(baseMaterialProps.baseEmissive);
    };
  }, [data.collided, baseMaterialProps.baseEmissive, materialEmissiveIntensity]); // Depend on collision and base emissive


  return (
    // Add renderOrder prop here
    <mesh ref={meshRef} castShadow receiveShadow renderOrder={BALL_RENDER_ORDER}>
      <sphereGeometry args={[renderRadius, 16, 16]} />
      <meshStandardMaterial
        ref={materialRef}
        color={color}
        roughness={baseMaterialProps.roughness} // Set from props
        metalness={baseMaterialProps.metalness} // Set from props
        emissive={color} // Always use ball color for emissive base
      // emissiveIntensity, opacity, transparent, depthWrite are handled dynamically in useFrame/useEffect
      />
      <pointLight
        ref={lightRef}
        color={lightColor}
        intensity={pointLightIntensity}
        distance={renderRadius * 5}
        decay={2}
      />
    </mesh>
  );
};

export default React.memo(Ball3D);