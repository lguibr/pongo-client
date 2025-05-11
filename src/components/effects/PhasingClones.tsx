// File: src/components/effects/PhasingClones.tsx
import React, { useRef, useEffect, useMemo, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface CloneData {
  id: number;
  matrix: THREE.Matrix4;
  currentLife: number; // Time remaining
  maxLife: number;
  initialScale: number;
  offset: THREE.Vector3; // Offset from the main ball's position
  active: boolean;
}

interface PhasingClonesProps {
  ballRef: React.RefObject<THREE.Object3D>; // Ref to the actual ball mesh
  isPhasing: boolean;
  ballRadius: number;
  ballColor: THREE.Color; // Main ball's color for the clones
  cloneCount?: number;
  cloneLife?: number; // ms
  spawnRadiusFactor?: number; // Multiplier of ballRadius for spawn area
  maxOpacity?: number;
}

const CLONE_GEOMETRY = new THREE.SphereGeometry(1, 12, 12);

const PhasingClones: React.FC<PhasingClonesProps> = ({
  ballRef,
  isPhasing,
  ballRadius,
  ballColor,
  cloneCount = 5,
  cloneLife = 300,
  spawnRadiusFactor = 2.5,
  maxOpacity = 0.3,
}) => {
  const instancedMeshRef = useRef<THREE.InstancedMesh>(null!);
  const clonesData = useRef<CloneData[]>([]);
  const [isVisible, setIsVisible] = useState(false);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    clonesData.current = Array.from({ length: cloneCount }, (_, i) => ({
      id: i,
      matrix: new THREE.Matrix4(),
      currentLife: 0,
      maxLife: cloneLife * (0.8 + Math.random() * 0.4),
      initialScale: ballRadius * (0.6 + Math.random() * 0.4),
      offset: new THREE.Vector3(),
      active: false,
    }));
  }, [cloneCount, cloneLife, ballRadius]);

  useEffect(() => {
    if (isPhasing) {
      setIsVisible(true);
      clonesData.current.forEach(clone => {
        clone.active = true;
        clone.currentLife = clone.maxLife;
        clone.offset.set(
          (Math.random() - 0.5) * 2 * ballRadius * spawnRadiusFactor,
          (Math.random() - 0.5) * 2 * ballRadius * spawnRadiusFactor,
          (Math.random() - 0.5) * 2 * ballRadius * spawnRadiusFactor
        );
      });
    } else {
      const anyActive = clonesData.current.some(c => c.active);
      if (!anyActive) {
        setIsVisible(false);
      }
    }
  }, [isPhasing, ballRadius, spawnRadiusFactor]);


  useFrame((_, delta) => { // Renamed 'state' to '_'
    if (!instancedMeshRef.current || !ballRef.current || !isVisible) return;

    const dt = delta * 1000;
    let activeCloneCount = 0;

    clonesData.current.forEach(clone => {
      if (clone.active) {
        clone.currentLife -= dt;
        if (clone.currentLife <= 0) {
          clone.active = false;
          dummy.matrix.identity();
          dummy.scale.set(0, 0, 0);
        } else {
          activeCloneCount++;
          const lifeRatio = clone.currentLife / clone.maxLife;

          if (ballRef.current) {
            dummy.position.copy(ballRef.current.position).add(clone.offset);
          }
          dummy.scale.setScalar(clone.initialScale * lifeRatio);
          dummy.updateMatrix();
          clone.matrix.copy(dummy.matrix);
        }
      } else {
        dummy.matrix.identity();
        dummy.scale.set(0, 0, 0);
        dummy.updateMatrix();
        clone.matrix.copy(dummy.matrix);
      }
      instancedMeshRef.current.setMatrixAt(clone.id, clone.matrix);
    });

    if (activeCloneCount === 0 && !isPhasing) {
      setIsVisible(false);
    }

    instancedMeshRef.current.instanceMatrix.needsUpdate = true;
  });

  if (!isVisible) return null;

  return (
    <instancedMesh
      ref={instancedMeshRef}
      args={[CLONE_GEOMETRY, undefined, cloneCount]}
      frustumCulled={false}
    >
      <meshStandardMaterial
        color={ballColor}
        transparent
        opacity={maxOpacity * 0.8}
        depthWrite={false}
        roughness={0.8}
        metalness={0.1}
        emissive={ballColor}
        emissiveIntensity={0.2}
      />
    </instancedMesh>
  );
};

export default React.memo(PhasingClones);