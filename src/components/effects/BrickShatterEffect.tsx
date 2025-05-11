// File: src/components/effects/BrickShatterEffect.tsx
import React, { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface ShatterPieceData {
  id: number;
  matrix: THREE.Matrix4;
  currentLife: number;
  maxLife: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  rotation: THREE.Euler;
  angularVelocity: THREE.Vector3;
  initialScale: THREE.Vector3;
  active: boolean;
}

interface BrickShatterEffectProps {
  id: string;
  centerPosition: THREE.Vector3; // World-space center of the shattered layer
  layerDimensions: { width: number; height: number; depth: number };
  color: THREE.Color;
  onComplete: (id: string) => void;
}

const PIECE_COUNT = 16;
const PIECE_LIFE_MS = 1200; // Slightly longer life for pieces to clear
const INITIAL_OUTWARD_SPEED = 18; // Increased outward speed
const INITIAL_UPWARD_SPEED = 12;  // Significantly increased upward speed
const FALL_ACCELERATION = -25;   // Less strong gravity
const HORIZONTAL_DRAG = 0.975;   // Slightly less drag
const ROTATION_SPEED_FACTOR = 3.0;

const SHATTER_PIECE_GEOMETRY = new THREE.BoxGeometry(1, 1, 1); // Unit geometry

const BrickShatterEffect: React.FC<BrickShatterEffectProps> = ({
  id,
  centerPosition,
  layerDimensions,
  color,
  onComplete,
}) => {
  const instancedMeshRef = useRef<THREE.InstancedMesh>(null!);
  const piecesData = useRef<ShatterPieceData[]>([]);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const pieceMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: color,
    roughness: 0.8, // Flat
    metalness: 0.1, // Flat
    transparent: true, // Will fade opacity
    opacity: 1,
    depthWrite: true, // Start with depth write
    emissiveIntensity: 0,
    envMapIntensity: 0.15,
  }), [color]);


  useEffect(() => {
    piecesData.current = [];
    // Calculate base dimensions for a single piece from the 4x4 grid
    const pieceBaseWidth = layerDimensions.width / 4;
    const pieceBaseHeight = layerDimensions.height / 4;
    // Depth of each piece is the full depth of the shattered layer
    const pieceDepth = layerDimensions.depth;


    for (let i = 0; i < PIECE_COUNT; i++) {
      const row = Math.floor(i / 4); // 0 to 3
      const col = i % 4;             // 0 to 3

      // Position pieces relative to the center of the 4x4 grid of pieces
      // (col - 1.5) results in -1.5, -0.5, 0.5, 1.5. Multiplied by pieceBaseWidth gives local X.
      const x = (col - 1.5) * pieceBaseWidth;
      const y = (row - 1.5) * pieceBaseHeight;
      // Initial Z position is slightly offset within their own layer depth to avoid z-fighting if layer is very thin
      const initialLocalPos = new THREE.Vector3(x, y, (Math.random() - 0.5) * pieceDepth * 0.2);

      const outwardDir = new THREE.Vector3(x, y, 0).normalize();
      if (x === 0 && y === 0) { // Center pieces, give them a random horizontal direction
        outwardDir.set(Math.random() - 0.5, Math.random() - 0.5, 0).normalize();
      }

      const velocity = new THREE.Vector3(
        outwardDir.x * INITIAL_OUTWARD_SPEED * (0.7 + Math.random() * 0.6), // Add more variance
        outwardDir.y * INITIAL_OUTWARD_SPEED * (0.7 + Math.random() * 0.6),
        INITIAL_UPWARD_SPEED * (0.7 + Math.random() * 0.6) // More upward variance
      );

      piecesData.current.push({
        id: i,
        matrix: new THREE.Matrix4(),
        currentLife: PIECE_LIFE_MS * (0.75 + Math.random() * 0.5), // Variance in lifetime
        maxLife: PIECE_LIFE_MS,
        position: initialLocalPos.clone(),
        velocity: velocity,
        rotation: new THREE.Euler(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI),
        angularVelocity: new THREE.Vector3(
          (Math.random() - 0.5) * ROTATION_SPEED_FACTOR * 2,
          (Math.random() - 0.5) * ROTATION_SPEED_FACTOR * 2,
          (Math.random() - 0.5) * ROTATION_SPEED_FACTOR * 2
        ),
        // initialScale is the actual dimension of the piece
        initialScale: new THREE.Vector3(
          Math.max(0.001, pieceBaseWidth * (0.8 + Math.random() * 0.4)), // Add size variance
          Math.max(0.001, pieceBaseHeight * (0.8 + Math.random() * 0.4)),
          Math.max(0.001, pieceDepth * (0.8 + Math.random() * 0.4))
        ),
        active: true,
      });
    }
    if (instancedMeshRef.current) {
      instancedMeshRef.current.material = pieceMaterial;
    }
     
  }, [id, layerDimensions, pieceMaterial]); // Recalculate if these key props change

  useFrame((_state, delta) => { // state parameter marked as unused
    if (!instancedMeshRef.current || piecesData.current.length === 0) return;

    const dt = Math.min(delta, 0.05); // Cap delta to prevent large jumps
    let allInactive = true;
    let needsMaterialOpacityUpdate = false;

    piecesData.current.forEach(piece => {
      if (!piece.active) {
        // Ensure inactive pieces are not rendered by scaling to zero
        if (piece.matrix.elements[0] !== 0) { // Check if already scaled to zero
          dummy.matrix.identity().scale(new THREE.Vector3(0, 0, 0));
          piece.matrix.copy(dummy.matrix);
          instancedMeshRef.current!.setMatrixAt(piece.id, piece.matrix);
        }
        return;
      }

      allInactive = false;
      piece.currentLife -= dt * 1000;
      const lifeRatio = Math.max(0, piece.currentLife / piece.maxLife);

      if (piece.currentLife <= 0) {
        piece.active = false;
        dummy.matrix.identity().scale(new THREE.Vector3(0, 0, 0)); // Scale to zero
      } else {
        piece.velocity.z += FALL_ACCELERATION * dt;
        piece.velocity.x *= Math.pow(HORIZONTAL_DRAG, dt * 60); // Frame-rate independent drag
        piece.velocity.y *= Math.pow(HORIZONTAL_DRAG, dt * 60);

        piece.position.addScaledVector(piece.velocity, dt);

        piece.rotation.x += piece.angularVelocity.x * dt;
        piece.rotation.y += piece.angularVelocity.y * dt;
        piece.rotation.z += piece.angularVelocity.z * dt;

        dummy.position.copy(piece.position);
        dummy.rotation.copy(piece.rotation);

        // Scale fades with life, opacity also fades in the last portion
        const scaleMultiplier = Math.pow(lifeRatio, 0.5); // Slower scale fade
        dummy.scale.set(
          piece.initialScale.x * scaleMultiplier,
          piece.initialScale.y * scaleMultiplier,
          piece.initialScale.z * scaleMultiplier
        );
      }
      dummy.updateMatrix();
      piece.matrix.copy(dummy.matrix);
      instancedMeshRef.current!.setMatrixAt(piece.id, piece.matrix);
    });

    // Fade material opacity globally for all pieces based on average remaining life or similar
    // This is a simple approach; for per-instance opacity, custom shaders are better.
    // Here, we'll just fade the whole InstancedMesh material as pieces die.
    const activePieces = piecesData.current.filter(p => p.active);
    if (activePieces.length > 0) {
      const avgLifeRatio = activePieces.reduce((sum, p) => sum + (p.currentLife / p.maxLife), 0) / activePieces.length;
      const targetOpacity = Math.pow(avgLifeRatio, 1.5); // Fade opacity faster
      if (Math.abs(pieceMaterial.opacity - targetOpacity) > 0.01) {
        pieceMaterial.opacity = targetOpacity;
        needsMaterialOpacityUpdate = true;
      }
      if (targetOpacity < 0.5 && pieceMaterial.depthWrite) {
        pieceMaterial.depthWrite = false; // Stop writing to depth buffer when mostly transparent
        needsMaterialOpacityUpdate = true;
      }
    } else if (pieceMaterial.opacity > 0) {
      pieceMaterial.opacity = 0;
      pieceMaterial.depthWrite = false;
      needsMaterialOpacityUpdate = true;
    }

    if (needsMaterialOpacityUpdate) {
      pieceMaterial.needsUpdate = true;
    }

    instancedMeshRef.current!.instanceMatrix.needsUpdate = true;

    if (allInactive) {
      onComplete(id);
    }
  });

  return (
    <group position={centerPosition}>
      <instancedMesh
        ref={instancedMeshRef}
        args={[SHATTER_PIECE_GEOMETRY, undefined, PIECE_COUNT]} // Material set in useEffect
        castShadow
        receiveShadow
      />
    </group>
  );
};

export default React.memo(BrickShatterEffect);