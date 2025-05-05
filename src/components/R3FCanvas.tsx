// File: src/components/R3FCanvas.tsx
import React, { useMemo, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';

import {
  Paddle as PaddleType, Ball as BallType, BrickStateUpdate,
} from '../types/game';
import Paddle3D from './Paddle3D';
import Ball3D from './Ball3D';
import Brick3D from './Brick3D';
import theme from '../styles/theme';

interface BoundaryWallsProps {
  extentX: number;
  extentY: number;
}

// Define the expected shape of the props within the map function
interface WallProp {
  position: [number, number, number];
  args: [number, number, number];
}

const BoundaryWalls: React.FC<BoundaryWallsProps> = ({ extentX, extentY }) => {
  const wallThickness = theme.sizes.boundaryWallThickness;
  const wallDepth = theme.sizes.boundaryWallDepth;

  // Ensure the type matches WallProp[]
  const wallProps: WallProp[] = useMemo(() => [
    { position: [0, extentY + wallThickness / 2, wallDepth / 2], args: [extentX * 2 + wallThickness * 2, wallThickness, wallDepth] },
    { position: [0, -extentY - wallThickness / 2, wallDepth / 2], args: [extentX * 2 + wallThickness * 2, wallThickness, wallDepth] },
    { position: [-extentX - wallThickness / 2, 0, wallDepth / 2], args: [wallThickness, extentY * 2, wallDepth] },
    { position: [extentX + wallThickness / 2, 0, wallDepth / 2], args: [wallThickness, extentY * 2, wallDepth] },
  ], [extentX, extentY, wallThickness, wallDepth]);

  return (
    <group>
      {/* Explicitly type props here */}
      {wallProps.map((props: WallProp, index) => (
        <mesh key={`boundary-${index}`} position={props.position} receiveShadow>
          {/* Pass args directly, TypeScript now knows it's a tuple */}
          <boxGeometry args={props.args} />
          <meshStandardMaterial
            color={theme.colors.boundaryWall}
            emissive={theme.colors.boundaryWallEmissive}
            emissiveIntensity={0.4}
            roughness={0.8}
            metalness={0.1}
          />
        </mesh>
      ))}
    </group>
  );
};

interface R3FCanvasProps {
  brickStates: BrickStateUpdate[];
  cellSize: number;
  paddles: (PaddleType | null)[];
  balls: BallType[];
  rotationAngle: number; // Rotation angle in RADIANS
  wsStatus: 'open' | 'closed'; // Simplified status for rendering decision
}

const R3FCanvas: React.FC<R3FCanvasProps> = ({
  brickStates,
  cellSize,
  paddles,
  balls,
  rotationAngle,
  wsStatus,
}) => {
  const canRenderGame = wsStatus === 'open' && brickStates.length > 0 && cellSize > 0;

  const boundaries = useMemo(() => {
    if (!canRenderGame) return { extentX: 300, extentY: 300 };

    let maxX = 0;
    let maxY = 0;
    brickStates.forEach(b => {
      maxX = Math.max(maxX, Math.abs(b.x));
      maxY = Math.max(maxY, Math.abs(b.y));
    });

    const halfCell = cellSize / 2;
    const extentX = maxX + halfCell;
    const extentY = maxY + halfCell;

    const paddleOverhang = 0;
    return {
      extentX: extentX + paddleOverhang,
      extentY: extentY + paddleOverhang
    };
  }, [brickStates, cellSize, canRenderGame]);

  const fishEyeFOV = 30;

  const cameraDistance = useMemo(() => {
    const requiredViewSize = Math.max(boundaries.extentX, boundaries.extentY) * 2;
    const distance = (requiredViewSize / 2) / Math.tan(THREE.MathUtils.degToRad(fishEyeFOV / 2));
    return Math.max(150, distance * 1.1);
  }, [boundaries, fishEyeFOV]);

  // Calculate camera position with a slight angle
  const cameraPosition = useMemo(() => {
    // Define small offset factors relative to distance
    const xOffsetFactor = 0.00; // Small offset to the right
    const yOffsetFactor = -0.33; // Slightly larger offset upwards

    const x = cameraDistance * xOffsetFactor;
    const y = cameraDistance * yOffsetFactor;
    // Adjust Z to maintain roughly the same distance from origin despite XY offset
    const z = Math.sqrt(Math.max(0, cameraDistance ** 2 - x ** 2 - y ** 2));

    return new THREE.Vector3(x, y, z);
  }, [cameraDistance]);

  return (
    <Canvas
      shadows
      gl={{ antialias: true, alpha: false }}
    >
      <color attach="background" args={[theme.colors.background]} />

      <PerspectiveCamera
        makeDefault
        fov={fishEyeFOV}
        aspect={window.innerWidth / window.innerHeight}
        near={10}
        far={cameraDistance * 2.5} // Increase far plane slightly due to angle/offset
        position={cameraPosition} // Use the calculated angled position
        onUpdate={(self) => self.lookAt(0, 0, 0)} // Ensure it always looks at the center
      />

      {/* Adjust light positions */}
      <ambientLight intensity={0.6} />
      <directionalLight
        // Position light relative to camera/scene, slightly offset
        position={[cameraPosition.x + 50, cameraPosition.y + 50, cameraPosition.z]}
        intensity={1.0}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-boundaries.extentX * 1.5}
        shadow-camera-right={boundaries.extentX * 1.5}
        shadow-camera-top={boundaries.extentY * 1.5}
        shadow-camera-bottom={-boundaries.extentY * 1.5}
        shadow-camera-near={cameraDistance * 0.1} // Adjust near/far
        shadow-camera-far={cameraDistance * 2}
      />
      <pointLight position={[0, 0, cameraDistance * 0.6]} intensity={0.4} />

      {canRenderGame && boundaries && (
        <Suspense fallback={null}>
          <BoundaryWalls extentX={boundaries.extentX} extentY={boundaries.extentY} />
          <group rotation={[0, 0, rotationAngle]}>
            {/* Render Bricks */}
            {brickStates.map((brickState, index) =>
              brickState.type !== 2 ? (
                <Brick3D
                  key={`brick-${index}-${brickState.x.toFixed(2)}-${brickState.y.toFixed(2)}`}
                  life={brickState.life}
                  type={brickState.type}
                  cellSize={cellSize}
                  position={[brickState.x, brickState.y, 0]}
                />
              ) : null
            )}
            {/* Render Paddles */}
            {paddles.map((paddle) =>
              paddle && paddle.r3fX !== undefined && paddle.r3fY !== undefined ? (
                <Paddle3D
                  key={`paddle-${paddle.index}`}
                  data={paddle}
                  position={[paddle.r3fX, paddle.r3fY, theme.sizes.boundaryWallDepth / 2 + 1]}
                />
              ) : null
            )}
            {/* Render Balls */}
            {balls.map((ball) =>
              ball && ball.r3fX !== undefined && ball.r3fY !== undefined ? (
                <Ball3D
                  key={`ball-${ball.id}`}
                  data={ball}
                  position={[ball.r3fX, ball.r3fY, theme.sizes.boundaryWallDepth / 2 + ball.radius + 1]}
                />
              ) : null
            )}
          </group>
        </Suspense>
      )}
    </Canvas>
  );
};

export default R3FCanvas;