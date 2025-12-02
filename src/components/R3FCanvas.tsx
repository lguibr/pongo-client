import React, { useMemo, Suspense, useEffect, useRef, useState } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
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
  balls: BallType[];
}

interface WallProp {
  position: [number, number, number];
  args: [number, number, number];
  color: string;
  normal: THREE.Vector3; // Normal vector to help with collision detection direction
}

const Wall: React.FC<{ props: WallProp; balls: BallType[] }> = ({ props, balls }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);
  const [flashIntensity, setFlashIntensity] = useState(0);

  useFrame(() => {
    if (!meshRef.current || !materialRef.current) return;

    // Decay flash
    if (flashIntensity > 0) {
      setFlashIntensity(prev => Math.max(0, prev - 0.1));
    }

    // Check collisions using LOCAL coordinates
    // The wall is axis-aligned in local space.
    // props.position is the center. props.args is [width, height, depth].
    
    const halfWidth = props.args[0] / 2;
    const halfHeight = props.args[1] / 2;
    // We ignore depth for hit detection, just check 2D plane proximity
    
    const wallX = props.position[0];
    const wallY = props.position[1];
    
    let hit = false;
    for (const ball of balls) {
      if (!ball || ball.r3fX === undefined || ball.r3fY === undefined) continue;
      
      // Check if ball is within the bounds of the wall (plus radius/margin)
      // Since walls are thin rectangles at the edges:
      
      // Calculate distance from ball center to wall center
      const dx = Math.abs(ball.r3fX - wallX);
      const dy = Math.abs(ball.r3fY - wallY);
      
      // Check if ball overlaps with the wall rectangle
      // We add a small margin (e.g. 1.0) to make the flash more visible/forgiving
      const margin = 1.0; 
      const hitX = dx < (halfWidth + ball.radius + margin);
      const hitY = dy < (halfHeight + ball.radius + margin);
      
      if (hitX && hitY) {
         hit = true;
         break;
      }
    }

    if (hit && flashIntensity === 0) {
      setFlashIntensity(1.0);
    }

    // Apply flash
    if (materialRef.current) {
        // Base color is props.color
        // Emissive color is White * intensity
        materialRef.current.emissive.setHex(0xffffff);
        materialRef.current.emissiveIntensity = flashIntensity;
    }
  });

  return (
    <mesh ref={meshRef} position={props.position} receiveShadow>
      <boxGeometry args={props.args} />
      <meshStandardMaterial
        ref={materialRef}
        color={props.color}
        roughness={0.85}
        metalness={0.05}
      />
    </mesh>
  );
};

const BoundaryWalls: React.FC<BoundaryWallsProps> = ({ extentX, extentY, balls }) => {
  const wallThickness = theme.sizes.boundaryWallThickness;
  const wallDepth = theme.sizes.boundaryWallDepth;

  const wallProps: WallProp[] = useMemo(() => [
    // Top Wall (Player 1 - Green)
    { 
        position: [0, extentY + wallThickness / 2, wallDepth / 2], 
        args: [extentX * 2 + wallThickness * 2, wallThickness, wallDepth],
        color: theme.colors.player1,
        normal: new THREE.Vector3(0, -1, 0)
    },
    // Bottom Wall (Player 0 - Blue) -> Swapped to Red based on user feedback? 
    // Wait, if user says "Blue and Red is swapped", and I had Bottom=Blue, Right=Red.
    // Maybe they want Bottom=Red, Right=Blue? 
    // Or maybe the *positions* of players 0 and 3 are swapped in the game logic?
    // Let's try swapping the colors as requested.
    { 
        position: [0, -extentY - wallThickness / 2, wallDepth / 2], 
        args: [extentX * 2 + wallThickness * 2, wallThickness, wallDepth],
        color: theme.colors.player3, // Was player0
        normal: new THREE.Vector3(0, 1, 0)
    },
    // Left Wall (Player 2 - Yellow)
    { 
        position: [-extentX - wallThickness / 2, 0, wallDepth / 2], 
        args: [wallThickness, extentY * 2, wallDepth],
        color: theme.colors.player2,
        normal: new THREE.Vector3(1, 0, 0)
    },
    // Right Wall (Player 3 - Red)
    { 
        position: [extentX + wallThickness / 2, 0, wallDepth / 2], 
        args: [wallThickness, extentY * 2, wallDepth],
        color: theme.colors.player0, // Was player3
        normal: new THREE.Vector3(-1, 0, 0)
    },
  ], [extentX, extentY, wallThickness, wallDepth]);

  return (
    <group>
      {wallProps.map((props, index) => (
        <Wall key={`boundary-${index}`} props={props} balls={balls} />
      ))}
    </group>
  );
};

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
    const camera = useThree(state => state.camera);
    const size = useThree(state => state.size);

    useEffect(() => {
      if (!(camera instanceof THREE.PerspectiveCamera) || !size.width || !size.height || !gameContentWidth || !gameContentHeight) {
        return;
      }

      const aspect = size.width / size.height;
      camera.fov = verticalFov;
      camera.aspect = aspect;

      const vFOVrad = THREE.MathUtils.degToRad(verticalFov);
      const tanHalfVFov = Math.tan(vFOVrad / 2);

      const distToFitHeight = (gameContentHeight / 2) / tanHalfVFov;
      const distToFitWidth = aspect > 0 ? (gameContentWidth / 2) / (tanHalfVFov * aspect) : distToFitHeight;

      let targetDistance = Math.max(distToFitHeight, distToFitWidth);
      targetDistance = Math.max(minCameraDistance, targetDistance * cameraPaddingFactor);

      const x = targetDistance * cameraXOffsetFactor;
      const y = targetDistance * cameraYOffsetFactor;
      const zSquared = targetDistance ** 2 - x ** 2 - y ** 2;
      const z = Math.sqrt(Math.max(0.01, zSquared));

      camera.position.set(x, y, z);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();

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
    if (!canRenderGame) return { extentX: 300, extentY: 300 };
    let maxX = 0;
    let maxY = 0;
    brickStates.forEach(b => {
      maxX = Math.max(maxX, Math.abs(b.x));
      maxY = Math.max(maxY, Math.abs(b.y));
    });
    const halfCell = cellSize / 2;
    return {
      extentX: maxX + halfCell,
      extentY: maxY + halfCell
    };
  }, [brickStates, cellSize, canRenderGame]);

  const gameContentWidth = useMemo(() => boundaries.extentX * 2, [boundaries.extentX]);
  const gameContentHeight = useMemo(() => boundaries.extentY * 2, [boundaries.extentY]);

  const fov = 16;
  const minCamDist = Math.max(gameContentWidth, gameContentHeight) * 0.7;
  const camPaddingFactor = 1.10;
  const camXOffsetFactor = 0.0;
  const camYOffsetFactor = -0.55;

  return (
    <Canvas
      shadows
      gl={{
        antialias: true,
        alpha: false,
        outputColorSpace: THREE.SRGBColorSpace,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 0.9,
      }}
      camera={{
        fov: fov,
        near: 0.1,
        far: Math.max(gameContentWidth, gameContentHeight) * 10 + minCamDist,
        position: [0, minCamDist * camYOffsetFactor, minCamDist * 0.8]
      }}
    >
      <color attach="background" args={[theme.colors.background]} />

      <CameraUpdater
        verticalFov={fov}
        gameContentWidth={gameContentWidth}
        gameContentHeight={gameContentHeight}
        minCameraDistance={minCamDist}
        cameraPaddingFactor={camPaddingFactor}
        cameraXOffsetFactor={camXOffsetFactor}
        cameraYOffsetFactor={camYOffsetFactor}
      />

      {/* Environment component removed */}


      <ambientLight intensity={0.8} color="#ffffff" />
      <hemisphereLight
        color={new THREE.Color(theme.colors.accent).multiplyScalar(0.05)}
        groundColor={new THREE.Color(theme.colors.accent).multiplyScalar(0.02)}
        intensity={0.5}
      />
      <directionalLight
        position={[gameContentWidth * 0.2, gameContentHeight * 0.5, Math.max(gameContentWidth, gameContentHeight) * 1.0]}
        intensity={0.8}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-boundaries.extentX * 2.0}
        shadow-camera-right={boundaries.extentX * 2.0}
        shadow-camera-top={boundaries.extentY * 2.0}
        shadow-camera-bottom={-boundaries.extentY * 2.0}
        shadow-camera-near={50}
        shadow-camera-far={Math.max(gameContentWidth, gameContentHeight) * 3}
        shadow-bias={-0.0005}
        shadow-normalBias={0.03}
      />

      {canRenderGame && (
        <Suspense fallback={null}>
          <group rotation={[0, 0, rotationAngle]}>
            <BoundaryWalls extentX={boundaries.extentX} extentY={boundaries.extentY} balls={balls} />
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
                  position={[paddle.r3fX, paddle.r3fY, (paddle.index === 0 || paddle.index === 2 ? paddle.width : paddle.height) / 2 + 0.1]}
                />
              ) : null
            )}
            {balls.map((ball) =>
              ball && ball.r3fX !== undefined && ball.r3fY !== undefined ? (
                <Ball3D
                  key={`ball-${ball.id}`}
                  data={ball}
                  position={[ball.r3fX, ball.r3fY, ball.radius + 0.1]}
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