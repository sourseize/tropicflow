import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { AudioEngine } from './core/audio/AudioEngine.ts';
import { InputHub } from './core/input/InputHub.ts';
import './index.css';

// Exposed for end-to-end tests and console debugging (see src/types/window.d.ts).
window.tropicflowEngine = AudioEngine.getInstance();
window.tropicflowInput = InputHub.getInstance();

const rootElement = document.getElementById('root');

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
