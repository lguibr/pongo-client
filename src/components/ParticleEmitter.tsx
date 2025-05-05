// File: src/components/ParticleEmitter.tsx
import React, { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import theme from '../styles/theme'; // Import theme for player colors

interface ParticleData {
  id: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number; // Remaining duration in ms
  maxLife: number;
  scale: number;
  color: THREE.Color;
}

interface ParticleEmitterProps {
  type: 'spark' | 'brickExplosion';
  count: number;
  origin: { x: number; y: number; z: number }; // Center of emission relative to parent group
  color?: string; // Base color for brick explosion, ignored for spark
  duration: number; // ms for particle lifetime
  particleSize?: number; // Base size
  force?: number;
  spread?: number; // Angle in radians (primarily for brick explosion Z variation)
  decay?: number; // Velocity decay factor per frame (e.g., 0.95)
  gravity?: number; // Simple Z-axis force
  shape?: 'point' | 'sphere' | 'box'; // Emission shape relative to origin
  shapeRadius?: number; // For sphere shape
  shapeDimensions?: [number, number, number]; // For box shape
}

const PARTICLE_GEOMETRY_SPARK = new THREE.SphereGeometry(1, 4, 4);
const PARTICLE_GEOMETRY_BRICK = new THREE.BoxGeometry(1, 1, 1);

const PLAYER_COLORS = [
  theme.colors.player0,
  theme.colors.player1,
  theme.colors.player2,
  theme.colors.player3,
];

// Helper to get a random point on the surface of a box
function getRandomPointOnBoxSurface(dims: [number, number, number]): THREE.Vector3 {
  const halfDims = dims.map(d => d / 2);
  const face = Math.floor(Math.random() * 6);
  const point = new THREE.Vector3();

  switch (face) {
    case 0: point.set(halfDims[0], Math.random() * dims[1] - halfDims[1], Math.random() * dims[2] - halfDims[2]); break; // +X
    case 1: point.set(-halfDims[0], Math.random() * dims[1] - halfDims[1], Math.random() * dims[2] - halfDims[2]); break; // -X
    case 2: point.set(Math.random() * dims[0] - halfDims[0], halfDims[1], Math.random() * dims[2] - halfDims[2]); break; // +Y
    case 3: point.set(Math.random() * dims[0] - halfDims[0], -halfDims[1], Math.random() * dims[2] - halfDims[2]); break; // -Y
    case 4: point.set(Math.random() * dims[0] - halfDims[0], Math.random() * dims[1] - halfDims[1], halfDims[2]); break; // +Z
    case 5: point.set(Math.random() * dims[0] - halfDims[0], Math.random() * dims[1] - halfDims[1], -halfDims[2]); break; // -Z
  }
  return point;
}


const ParticleEmitter: React.FC<ParticleEmitterProps> = ({
  type,
  count,
  origin,
  color, // Used only for brickExplosion
  duration,
  particleSize = 1.2,
  force = 5,
  spread = Math.PI / 4,
  decay = 0.95,
  gravity = type === 'spark' ? -15 : -9.8, // Increased default gravity for sparks
  shape = 'point',
  shapeRadius = 1,
  shapeDimensions = [1, 1, 1],
}) => {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const particles = useRef<ParticleData[]>([]);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const emitterId = useMemo(() => `${type}-${Date.now().toString().slice(-5)}`, [type]);

  const particleGeometry = type === 'brickExplosion' ? PARTICLE_GEOMETRY_BRICK : PARTICLE_GEOMETRY_SPARK;
  const baseColor = useMemo(() => new THREE.Color(color ?? theme.colors.defaultParticle), [color]);

  // Initialize particles
  useEffect(() => {
    particles.current = [];
    const originVec = new THREE.Vector3(origin.x, origin.y, origin.z);

    for (let i = 0; i < count; i++) {
      const initialPos = originVec.clone();
      let direction = new THREE.Vector3();

      // --- Calculate Initial Position & Direction based on Shape ---
      if (type === 'spark') {
        if (shape === 'sphere' && shapeRadius > 0) {
          direction.set(
            (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 2
          ).normalize();
          initialPos.addScaledVector(direction, shapeRadius);
        } else if (shape === 'box' && shapeDimensions) {
          const surfacePoint = getRandomPointOnBoxSurface(shapeDimensions);
          initialPos.add(surfacePoint);
          direction = surfacePoint.normalize();
        } else {
          direction.set(
            (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 2
          ).normalize();
        }
      } else { // brickExplosion
        if (shape === 'box' && shapeDimensions) {
          initialPos.add(
            new THREE.Vector3(
              (Math.random() - 0.5) * shapeDimensions[0] * 0.8,
              (Math.random() - 0.5) * shapeDimensions[1] * 0.8,
              (Math.random() - 0.5) * shapeDimensions[2] * 0.8
            )
          );
        }
        const horizontalAngle = Math.random() * Math.PI * 2;
        const zAngleVariation = (Math.random() - 0.5) * spread;
        direction.set(
          Math.cos(horizontalAngle),
          Math.sin(horizontalAngle),
          Math.sin(zAngleVariation)
        ).normalize();
      }

      const speed = force * (Math.random() * 0.5 + 0.75);
      const velocity = direction.multiplyScalar(speed);

      // --- Particle Color ---
      let particleColor: THREE.Color;
      if (type === 'spark') {
        // ALWAYS pick one of the 4 player colors randomly for sparks
        particleColor = new THREE.Color(PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]);
      } else {
        particleColor = baseColor.clone();
        particleColor.offsetHSL(0, 0, (Math.random() - 0.5) * 0.1);
      }

      particles.current.push({
        id: i,
        position: initialPos,
        velocity: velocity,
        life: duration * (Math.random() * 0.4 + 0.8),
        maxLife: duration,
        scale: particleSize * (Math.random() * 0.5 + 0.75),
        color: particleColor,
      });
    }

    if (meshRef.current) {
      meshRef.current.instanceMatrix.needsUpdate = true;
      if (meshRef.current.instanceColor) {
        meshRef.current.instanceColor.needsUpdate = true;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, emitterId]);

  useFrame((_, delta) => {
    if (!meshRef.current || particles.current.length === 0) return;

    const dt = delta * 1000;
    let aliveCount = 0;

    particles.current.forEach((p, i) => {
      p.life -= dt;

      if (p.life <= 0) {
        dummy.scale.set(0, 0, 0);
        dummy.updateMatrix();
        meshRef.current.setMatrixAt(i, dummy.matrix);
      } else {
        aliveCount++;
        p.velocity.z += (gravity * delta); // Apply gravity
        p.position.addScaledVector(p.velocity, delta);
        p.velocity.multiplyScalar(Math.pow(decay, delta * 60)); // Apply decay

        dummy.position.copy(p.position);
        const lifeRatio = Math.max(0, p.life / p.maxLife);
        // Make scale fade more noticeably towards the end
        const scaleMultiplier = Math.pow(lifeRatio, 1.5); // Faster fade than linear
        const currentScale = p.scale * scaleMultiplier;
        dummy.scale.set(Math.max(1e-5, currentScale), Math.max(1e-5, currentScale), Math.max(1e-5, currentScale));
        dummy.updateMatrix();

        meshRef.current.setMatrixAt(i, dummy.matrix);
        if (meshRef.current.instanceColor) {
          meshRef.current.setColorAt(i, p.color);
        }
      }
    });

    meshRef.current.count = aliveCount;
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  });

  if (count === 0) return null;

  return (
    <group position={[origin.x, origin.y, origin.z]}>
      <instancedMesh
        ref={meshRef}
        args={[particleGeometry, undefined, count]}
        castShadow={false}
        receiveShadow={false}
      >
        <meshStandardMaterial
          toneMapped={false}
          vertexColors
          transparent={false} // Start opaque
          opacity={1.0}      // Start opaque
          depthWrite={true} // Write depth initially
          // Note: Fading opacity requires changing transparent/depthWrite dynamically
          // or using a custom shader. We rely on scale fadeout for simplicity.
          roughness={type === 'spark' ? 0.8 : 0.6}
          metalness={type === 'spark' ? 0.1 : 0.2}
          emissive={type === 'spark' ? '#ffffff' : '#000000'}
          emissiveIntensity={type === 'spark' ? 0.4 : 0}
        />
      </instancedMesh>
    </group>
  );
};

export default React.memo(ParticleEmitter);