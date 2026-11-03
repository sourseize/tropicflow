import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { AudioEngine } from './core/audio/AudioEngine.ts';
import { preloadCards } from './components/graph/cardRegistry.ts';
import './index.css';

// `?rack=empty` starts with nothing loaded, `?rack=full` with every module (see RACK_PRESETS);
// default is the default rack. Module code is fetched on demand - wait before the UI and the test hooks exist.
const engine = AudioEngine.getInstance({ rack: new URLSearchParams(window.location.search).get('rack') ?? 'default' });

void engine.ready.then(async () => {
  // The initial rack renders complete: its cards are fetched before the first paint (later additions load lazily).
  await preloadCards(engine.rack.list().map((m) => m.descriptor));

  // Exposed for end-to-end tests and console debugging (see src/types/window.d.ts).
  window.tropicflowEngine = engine;
  window.tropicflowInput = engine.inputHub;

  const rootElement = document.getElementById('root');
  if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  }
});
