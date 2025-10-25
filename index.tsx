import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ControlPanel } from './src/components/ControlPanel';
import { LoadingScreen } from './src/components/LoadingScreen';
import { createMainScene } from './main';
import type { RobotKey, MainSceneHandle, MainSceneProgress } from './src/types/scene';

const App = () => {
  const [activeRobot, setActiveRobot] = useState<RobotKey>('lekiwi');
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [sceneHandle, setSceneHandle] = useState<MainSceneHandle | null>(null);
  const [loadingProgress, setLoadingProgress] = useState<MainSceneProgress | null>(null);
  const [isSceneReady, setIsSceneReady] = useState(false);
  const sceneHandleRef = useRef<MainSceneHandle | null>(null);
  const robotViewRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);


  useEffect(() => {
    const canvas = canvasRef.current;
    const container = robotViewRef.current;
    if (!canvas || !container) return;

    let disposed = false;
    setIsSceneReady(false);

    const handleProgress = (progress: MainSceneProgress) => {
      if (disposed) return;
      setLoadingProgress(progress);
      if (progress.stage === 'complete') {
        setIsSceneReady(true);
      }
    };

    createMainScene({
      canvas,
      container,
      initialRobot: activeRobot,
      onActiveRobotChange: (key) => {
        if (disposed) return;
        setActiveRobot(key);
      },
      onProgress: handleProgress,
      debugHoldLoading: window.location.search.includes('debugLoading'),
    })
      .then((handle) => {
        if (disposed) {
          handle.dispose();
          return;
        }
        sceneHandleRef.current = handle;
        setSceneHandle(handle);
      })
      .catch((error) => {
        console.error('Failed to initialize main scene', error);
      });

    return () => {
      disposed = true;
      sceneHandleRef.current?.dispose();
      sceneHandleRef.current = null;
      setSceneHandle(null);
      setIsSceneReady(false);
      setLoadingProgress(null);
    };
  }, []);

  useEffect(() => {
    if (!sceneHandle) return;
    sceneHandle.switchRobot(activeRobot);
  }, [activeRobot, sceneHandle]);

  return (
    <div className="relative bg-gray-100 w-screen h-screen">
      {!isSceneReady && <LoadingScreen progress={loadingProgress} />}

      <div
        className={`max-w-full mx-auto pt-5 transition-opacity duration-500 ${
          isSceneReady ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="mb-5">
          <h1 className="text-gray-800 text-center text-3xl quicksand mb-1">Die Roboter</h1>
          <div className="flex items-center justify-center gap-3">
            <p className="text-gray-600 text-sm quicksand">a video game for robots</p>
            <span className="text-xs font-bold text-gray-700 bg-yellow-100 border border-yellow-300 px-3 py-1 rounded quicksand">
              Alpha Product - Work in Progress :)
            </span>
          </div>
        </div>

        <div className="relative w-full h-[calc(100vh-100px)]">
          <div className="w-full h-full rounded-sm">
            <div
              ref={robotViewRef}
              className="relative w-full h-full bg-gray-100 rounded-lg overflow-hidden"
            >
              <canvas ref={canvasRef} className="w-full h-full block" />
            </div>
          </div>

          <ControlPanel
            activeRobot={activeRobot}
            onRobotChange={setActiveRobot}
            isPanelOpen={isPanelOpen}
            onTogglePanel={() => setIsPanelOpen((prev) => !prev)}
            sceneHandle={sceneHandle}
          />
        </div>
      </div>
    </div>
  );
};

const rootElement = document.getElementById('root');

if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<App />);
}
