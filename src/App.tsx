import React from 'react';
import { TopBar } from './components/header/TopBar.tsx';
import { ModularCanvas } from './components/graph/ModularCanvas.tsx';
import { StepSequencer } from './components/sequencer/StepSequencer.tsx';
import { VirtualKeyboard } from './components/keyboard/VirtualKeyboard.tsx';
import { VisualizerPanel } from './components/visualizer/VisualizerPanel.tsx';

export const App: React.FC = () => {
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-jungle-950 text-cream-100 select-none">
      <TopBar />

      <div className="flex-1 relative overflow-hidden flex flex-col">
        <ModularCanvas />
      </div>

      <div className="h-[270px] bg-jungle-950 border-t border-jungle-800 p-3 flex gap-3 z-30 shrink-0 overflow-x-auto">
        <div className="flex-[3] min-w-[580px]">
          <StepSequencer />
        </div>

        <div className="flex-[2] min-w-[340px]">
          <VirtualKeyboard />
        </div>

        <div className="flex-[2] min-w-[320px]">
          <VisualizerPanel />
        </div>
      </div>
    </div>
  );
};

export default App;
