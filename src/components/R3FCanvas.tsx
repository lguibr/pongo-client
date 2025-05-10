import React, { useMemo, Suspense, useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
// Removed PerspectiveCamera import from drei as we'll manage the default camera
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

interface WallProp {
  position: [number, number, number];
  args: [number, number, number];
}

const BoundaryWalls: React.FC<BoundaryWallsProps> = ({ extentX, extentY }) => {
  const wallThickness = theme.sizes.boundaryWallThickness;
  const wallDepth = theme.sizes.boundaryWallDepth;

  const wallProps: WallProp[] = useMemo(() => [
    { position: [0, extentY + wallThickness / 2, wallDepth / 2], args: [extentX * 2 + wallThickness * 2, wallThickness, wallDepth] },
    { position: [0, -extentY - wallThickness / 2, wallDepth / 2], args: [extentX * 2 + wallThickness * 2, wallThickness, wallDepth] },
    { position: [-extentX - wallThickness / 2, 0, wallDepth / 2], args: [wallThickness, extentY * 2, wallDepth] },
    { position: [extentX + wallThickness / 2, 0, wallDepth / 2], args: [wallThickness, extentY * 2, wallDepth] },
  ], [extentX, extentY, wallThickness, wallDepth]);

  return (
    <group>
      {wallProps.map((props: WallProp, index) => (
        <mesh key={`boundary-${index}`} position={props.position} receiveShadow>
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

// New CameraUpdater component
const CameraUpdater: React.FC<{
  verticalFov: number;
  gameContentWidth: number;
  gameContentHeight: number;
  minCameraDistance: number;
  cameraPaddingFactor: number;
  cameraXOffsetFactor: number;
  cameraYOffsetFactor: number;
}> = ({
  verticalFov,
  gameContentWidth,
  gameContentHeight,
  minCameraDistance,
  cameraPaddingFactor,
  cameraXOffsetFactor,
  cameraYOffsetFactor,
}) => {
    const camera = useThree(state => state.camera); // Gets the default camera
    const size = useThree(state => state.size); // Canvas dimensions { width, height, top, left }

    useEffect(() => {
      // Ensure camera is a PerspectiveCamera and all necessary dimensions are available
      if (!(camera instanceof THREE.PerspectiveCamera) || !size.width || !size.height || !gameContentWidth || !gameContentHeight) {
        return;
      }

      const aspect = size.width / size.height;

      // Update camera's FOV and aspect
      camera.fov = verticalFov;
      camera.aspect = aspect;
      // camera.near and camera.far are set on <Canvas camera={{...}}> initially

      const vFOVrad = THREE.MathUtils.degToRad(verticalFov);
      const tanHalfVFov = Math.tan(vFOVrad / 2);

      const distToFitHeight = (gameContentHeight / 2) / tanHalfVFov;
      // Handle aspect ratio of 0 to prevent division by zero if canvas is not ready
      const distToFitWidth = aspect > 0 ? (gameContentWidth / 2) / (tanHalfVFov * aspect) : distToFitHeight;


      let newDistance = Math.max(distToFitHeight, distToFitWidth);
      newDistance = Math.max(minCameraDistance, newDistance * cameraPaddingFactor);

      const x = newDistance * cameraXOffsetFactor;
      const y = newDistance * cameraYOffsetFactor;
      const z = Math.sqrt(Math.max(0, newDistance ** 2 - x ** 2 - y ** 2));

      camera.position.set(x, y, z);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix(); // Crucial after changing fov, aspect, or position

    }, [
      camera,
      size,
      verticalFov,
      gameContentWidth,
      gameContentHeight,
      minCameraDistance,
      cameraPaddingFactor,
      cameraXOffsetFactor,
      cameraYOffsetFactor,
    ]);

    return null;
  };


interface R3FCanvasProps {
  brickStates: BrickStateUpdate[];
  cellSize: number;
  paddles: (PaddleType | null)[];
  balls: BallType[];
  rotationAngle: number;
  wsStatus: 'open' | 'closed';
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
    if (!canRenderGame) return { extentX: 300, extentY: 300 }; // Default if not ready

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

  // Memoize game content dimensions based on boundaries
  const gameContentWidth = useMemo(() => boundaries.extentX * 2, [boundaries.extentX]);
  const gameContentHeight = useMemo(() => boundaries.extentY * 2, [boundaries.extentY]);

  // Camera configuration constants
  const fishEyeFOV = 30; // Target vertical FOV
  const minCameraDist = 150; // Minimum distance the camera can be
  const camPaddingFactor = 1.1; // Padding factor for camera distance (e.g., 1.1 for 10% padding)
  const camXOffsetFactor = 0.00; // Camera horizontal offset factor
  const camYOffsetFactor = -0.33; // Camera vertical offset factor (negative for slight top-down view)


  return (
    <Canvas
      shadows
      gl={{ antialias: true, alpha: false }}
      // Set initial camera properties. CameraUpdater will refine position, FOV, and aspect.
      // Provide a generous far plane initially.
      camera={{ fov: fishEyeFOV, near: 10, far: Math.max(gameContentWidth, gameContentHeight) * 5 + minCameraDist }}
    >
      <color attach="background" args={[theme.colors.background]} />

      <CameraUpdater
        verticalFov={fishEyeFOV}
        gameContentWidth={gameContentWidth}
        gameContentHeight={gameContentHeight}
        minCameraDistance={minCameraDist}
        cameraPaddingFactor={camPaddingFactor}
        cameraXOffsetFactor={camXOffsetFactor}
        cameraYOffsetFactor={camYOffsetFactor}
      />

      <ambientLight intensity={0.6} />
      <directionalLight
        // Position light somewhat dynamically or ensure it's far enough
        position={[gameContentWidth * 0.1, gameContentHeight * 0.1, Math.max(gameContentWidth, gameContentHeight) * 0.5 + 100]}
        intensity={1.0}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-boundaries.extentX * 1.5}
        shadow-camera-right={boundaries.extentX * 1.5}
        shadow-camera-top={boundaries.extentY * 1.5}
        shadow-camera-bottom={-boundaries.extentY * 1.5}
        shadow-camera-near={minCameraDist * 0.1} // Adjust near/far based on typical distances
        shadow-camera-far={Math.max(gameContentWidth, gameContentHeight) * 3 + minCameraDist} // Generous far for shadows
      />
      <pointLight
        position={[0, 0, Math.max(gameContentWidth, gameContentHeight) * 0.3 + 50]}
        intensity={0.4}
      />

      {canRenderGame && ( // Check canRenderGame before accessing boundaries for walls
        <Suspense fallback={null}>
          <BoundaryWalls extentX={boundaries.extentX} extentY={boundaries.extentY} />
          <group rotation={[0, 0, rotationAngle]}>
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
            {paddles.map((paddle) =>
              paddle && paddle.r3fX !== undefined && paddle.r3fY !== undefined ? (
                <Paddle3D
                  key={`paddle-${paddle.index}`}
                  data={paddle}
                  position={[paddle.r3fX, paddle.r3fY, theme.sizes.boundaryWallDepth / 2 + 1]}
                />
              ) : null
            )}
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