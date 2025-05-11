// File: src/components/ParticleEmitter.tsx
import React, { useRef, useMemo, useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface ParticleData {
  id: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  scale: number;
  color: THREE.Color;
  active: boolean;
}

export interface ParticleEmitterProps {
  emitterId: string | number; // Key to re-trigger emission
  type?: 'spark' | 'brickExplosion'; // Type can be optional if color is always provided
  count: number;
  origin?: THREE.Vector3; // Center of emission, defaults to (0,0,0) relative to parent
  baseColor: THREE.Color; // Now mandatory
  duration?: number; // ms for particle lifetime
  particleSize?: number;
  force?: number;
  spread?: number; // Angle in radians for initial velocity cone
  decay?: number;
  gravity?: number;
  emissionShape?: 'point' | 'sphereSurface' | 'boxSurface';
  shapeRadius?: number; // For sphereSurface
  shapeDimensions?: THREE.Vector3; // For boxSurface [width, height, depth]
  onComplete?: () => void; // Callback when all particles are dead
}

const PARTICLE_GEOMETRY = new THREE.SphereGeometry(1, 4, 4); // Simple geometry for all particles

const ParticleEmitter: React.FC<ParticleEmitterProps> = ({
  emitterId,
  count,
  origin = new THREE.Vector3(0, 0, 0),
  baseColor,
  duration = 1000,
  particleSize = 0.8,
  force = 8,
  spread = Math.PI, // Wider spread for sparks
  decay = 0.96,
  gravity = -10,
  emissionShape = 'point',
  shapeRadius = 1,
  shapeDimensions = new THREE.Vector3(1, 1, 1),
  onComplete,
}) => {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const particles = useRef<ParticleData[]>([]);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const [isActive, setIsActive] = useState(true);

  const particleMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false, // Particles usually don't write to depth buffer
    roughness: 0.7,
    metalness: 0.1,
    emissiveIntensity: 0.2, // Slight self-glow for visibility
    envMapIntensity: 0.1,
  }), []);


  useEffect(() => {
    setIsActive(true);
    particles.current = [];

    for (let i = 0; i < count; i++) {
      const initialPos = new THREE.Vector3();
      const direction = new THREE.Vector3();

      if (emissionShape === 'sphereSurface' && shapeRadius > 0) {
        direction.randomDirection(); // Random point on unit sphere surface
        initialPos.copy(direction).multiplyScalar(shapeRadius); // Scale to shapeRadius
      } else if (emissionShape === 'boxSurface' && shapeDimensions) {
        // Get a random point on the surface of the box
        const face = Math.floor(Math.random() * 6);
        const u = Math.random() - 0.5; // -0.5 to 0.5
        const v = Math.random() - 0.5; // -0.5 to 0.5
        const halfDims = shapeDimensions.clone().multiplyScalar(0.5);

        switch (face) {
          case 0: initialPos.set(halfDims.x, u * shapeDimensions.y, v * shapeDimensions.z); break; // +X
          case 1: initialPos.set(-halfDims.x, u * shapeDimensions.y, v * shapeDimensions.z); break; // -X
          case 2: initialPos.set(u * shapeDimensions.x, halfDims.y, v * shapeDimensions.z); break; // +Y
          case 3: initialPos.set(u * shapeDimensions.x, -halfDims.y, v * shapeDimensions.z); break; // -Y
          case 4: initialPos.set(u * shapeDimensions.x, v * shapeDimensions.y, halfDims.z); break; // +Z
          case 5: initialPos.set(u * shapeDimensions.x, v * shapeDimensions.y, -halfDims.z); break; // -Z
        }
        direction.copy(initialPos).normalize(); // Emit outwards from surface point
      } else { // Point emission (default)
        direction.set(
          (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 2
        ).normalize();
        // Apply spread for point emission
        const angle = spread / 2;
        direction.applyAxisAngle(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), (Math.random() - 0.5) * angle);
      }

      initialPos.add(origin); // Add local origin offset

      const speed = force * (0.75 + Math.random() * 0.5);
      const velocity = direction.multiplyScalar(speed);

      const particleColor = baseColor.clone();
      // Optional: Add slight color variation
      particleColor.offsetHSL(0, (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1);


      particles.current.push({
        id: i,
        position: initialPos,
        velocity: velocity,
        life: duration * (0.7 + Math.random() * 0.6),
        maxLife: duration,
        scale: particleSize * (0.6 + Math.random() * 0.8),
        color: particleColor,
        active: true,
      });
    }

    if (meshRef.current) {
      meshRef.current.count = count; // Ensure all instances are potentially renderable
      meshRef.current.instanceMatrix.needsUpdate = true;
      if (meshRef.current.instanceColor) {
        meshRef.current.instanceColor.needsUpdate = true;
      }
    }
  }, [emitterId, count, origin, baseColor, duration, particleSize, force, spread, emissionShape, shapeRadius, shapeDimensions]);

  useFrame((_, delta) => {
    if (!meshRef.current || !isActive) return;

    const dt = Math.min(delta, 0.05); // Cap delta
    let aliveCount = 0;

    particles.current.forEach((p) => {
      if (!p.active) {
        dummy.scale.set(0, 0, 0);
      } else {
        p.life -= dt * 1000;
        if (p.life <= 0) {
          p.active = false;
          dummy.scale.set(0, 0, 0);
        } else {
          aliveCount++;
          p.velocity.z += gravity * dt;
          p.position.addScaledVector(p.velocity, dt);
          p.velocity.multiplyScalar(Math.pow(decay, dt * 60));

          dummy.position.copy(p.position);
          const lifeRatio = Math.max(0, p.life / p.maxLife);
          const currentScale = p.scale * Math.pow(lifeRatio, 1.5); // Scale fades out
          dummy.scale.setScalar(Math.max(1e-5, currentScale));

          if (meshRef.current.instanceColor) {
            // Fade color alpha if material supports it (MeshBasicMaterial does, MeshStandardMaterial needs transparent=true)
            const tempColor = p.color.clone();
            // For MeshStandardMaterial, opacity is on the material itself.
            // This setColorAt won't directly control opacity unless the shader is custom.
            // We rely on scaling to zero for disappearance.
            meshRef.current.setColorAt(p.id, tempColor);
          }
        }
      }
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(p.id, dummy.matrix);
    });

    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }

    if (aliveCount === 0) {
      setIsActive(false);
      if (onComplete) onComplete();
    }
  });

  if (!isActive || count === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[PARTICLE_GEOMETRY, particleMaterial, count]}
      castShadow={false}
      receiveShadow={false}
    />
  );
};

export default React.memo(ParticleEmitter);