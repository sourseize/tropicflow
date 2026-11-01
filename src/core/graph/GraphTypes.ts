export type ModuleType =
  | 'clock'
  | 'synth'
  | 'marimba'
  | 'percussion'
  | 'delay'
  | 'scope'
  | 'chamber'
  | 'midi'
  | 'sensor'
  | 'master';

export type PortType = 'audio-out' | 'audio-in' | 'trigger-out' | 'trigger-in' | 'cv-out' | 'cv-in';

export interface ModulePort {
  id: string;
  name: string;
  type: PortType;
  direction: 'in' | 'out';
  color: string;
}

export interface GraphNode {
  id: string;
  title: string;
  type: ModuleType;
  position: { x: number; y: number };
  inputs: ModulePort[];
  outputs: ModulePort[];
  themeColor: 'mango' | 'tomato' | 'lime' | 'papaya';
  accentHex: string;
}

export interface PatchCable {
  id: string;
  fromNodeId: string;
  fromPortId: string;
  toNodeId: string;
  toPortId: string;
  color: string;
}
