/** Built-in module types; any registered plugin type is valid (see core/modules). */
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
  | 'master'
  | (string & {});

/** How a CV jack's value is interpreted (see core/cv/CvBus for the scaling). */
export type CvSourceKind = 'pitch' | 'control';
export type CvTargetKind = 'pitch' | 'cutoff' | 'time';

export type PortType = 'audio-out' | 'audio-in' | 'trigger-out' | 'trigger-in' | 'cv-out' | 'cv-in';

export interface ModulePort {
  id: string;
  name: string;
  type: PortType;
  direction: 'in' | 'out';
  color: string;
  /** CV jacks: how the value is interpreted. */
  cvKind?: CvSourceKind | CvTargetKind;
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
