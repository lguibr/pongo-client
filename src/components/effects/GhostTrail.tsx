// File: src/components/effects/GhostTrail.tsx
import React, { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface GhostTrailProps {
  targetRef: React.RefObject<THREE.Object3D>;
  color: THREE.Color;
  radius: number;
  trailLength?: number;
  opacityDecay?: number;
  scaleDecay?: number;
  updateInterval?: number;
  visible?: boolean; // Controlled by Ball3D based on phasing state
}

interface GhostInstance {
  position: THREE.Vector3;
  scale: number;
  opacity: number;
}

const GHOST_GEOMETRY = new THREE.SphereGeometry(1, 16, 16);

const GhostTrail: React.FC<GhostTrailProps> = ({
  targetRef,
  color,
  radius,
  trailLength = 30, // Kept the longer trail length
  opacityDecay = 0.85,
  scaleDecay = 0.9,
  updateInterval = 1,
  visible = true,
}) => {
  const instancedMeshRef = useRef<THREE.InstancedMesh>(null!);
  const ghostInstances = useRef<GhostInstance[]>([]);
  const frameCounter = useRef(0);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // Material for the ghosts, always the same appearance now
  const ghostMaterial = useMemo(() => new THREE.MeshBasicMaterial({
    color: color,
    transparent: true,
    depthWrite: false,
    opacity: 0.7, // Default starting opacity for ghosts in the trail
  }), [color]);


  useEffect(() => {
    ghostInstances.current = Array(trailLength).fill(null).map(() => ({
      position: new THREE.Vector3(0, 0, -1000), // Start off-screen
      scale: 0,
      opacity: 0,
    }));
    if (instancedMeshRef.current) {
      instancedMeshRef.current.count = trailLength;
    }
  }, [trailLength]);


  useFrame(() => {
    if (!visible || !targetRef.current || !instancedMeshRef.current) {
      if (instancedMeshRef.current) instancedMeshRef.current.count = 0;
      return;
    }
    instancedMeshRef.current.count = trailLength;


    frameCounter.current++;
    if (frameCounter.current % updateInterval === 0) {
      for (let i = trailLength - 1; i > 0; i--) {
        if (ghostInstances.current[i - 1]) {
          ghostInstances.current[i] = {
            ...ghostInstances.current[i - 1],
            opacity: ghostInstances.current[i - 1].opacity * opacityDecay,
            scale: ghostInstances.current[i - 1].scale * scaleDecay,
          };
        }
      }
      ghostInstances.current[0] = {
        position: targetRef.current.position.clone(),
        scale: radius,
        opacity: 1.0, // First ghost is fully opaque (material opacity will control overall)
      };
    }

    let maxGhostOpacity = 0;
    for (let i = 0; i < trailLength; i++) {
      const ghost = ghostInstances.current[i];
      if (ghost && ghost.opacity > 0.01 && ghost.scale > 0.01) {
        dummy.position.copy(ghost.position);
        dummy.scale.setScalar(ghost.scale);
        dummy.updateMatrix();
        instancedMeshRef.current.setMatrixAt(i, dummy.matrix);
        if (i === 0) maxGhostOpacity = ghost.opacity; // Track leading ghost opacity
      } else {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        instancedMeshRef.current.setMatrixAt(i, dummy.matrix);
      }
    }
    instancedMeshRef.current.instanceMatrix.needsUpdate = true;

    // Adjust global material opacity based on the leading ghost, scaled by the material's base opacity
    ghostMaterial.opacity = maxGhostOpacity * 0.7;

  });


  if (!visible) return null;

  return (
    <instancedMesh
      ref={instancedMeshRef}
      args={[GHOST_GEOMETRY, ghostMaterial, trailLength]}
      frustumCulled={false}
    />
  );
};

export default React.memo(GhostTrail);