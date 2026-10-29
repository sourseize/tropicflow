export type DomainEventType =
  | 'AUDIO_STARTED'
  | 'AUDIO_STOPPED'
  | 'BPM_CHANGED'
  | 'SWING_CHANGED'
  | 'STEP_TRIGGERED'
  | 'NOTE_ON'
  | 'NOTE_OFF'
  | 'NODE_ADDED'
  | 'NODE_REMOVED'
  | 'NODE_MOVED'
  | 'PARAM_CHANGED'
  | 'CABLE_CONNECTED'
  | 'CABLE_DISCONNECTED'
  | 'RECORDING_STARTED'
  | 'RECORDING_STOPPED';

export interface BaseDomainEvent {
  type: DomainEventType;
  timestamp: number;
}

export interface NoteOnEvent extends BaseDomainEvent {
  type: 'NOTE_ON';
  channel: 'synth' | 'marimba' | 'kick' | 'snare' | 'hihat';
  frequency: number;
  velocity: number;
  duration?: number;
}

export interface NoteOffEvent extends BaseDomainEvent {
  type: 'NOTE_OFF';
  channel: 'synth' | 'marimba';
  frequency: number;
}

export interface StepTriggeredEvent extends BaseDomainEvent {
  type: 'STEP_TRIGGERED';
  stepIndex: number;
  activeTracks: string[];
}

export interface ParamChangedEvent extends BaseDomainEvent {
  type: 'PARAM_CHANGED';
  nodeId: string;
  paramKey: string;
  value: number;
}

export interface CableConnectedEvent extends BaseDomainEvent {
  type: 'CABLE_CONNECTED';
  cableId: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
  color: string;
}

export interface CableDisconnectedEvent extends BaseDomainEvent {
  type: 'CABLE_DISCONNECTED';
  cableId: string;
}

export type DomainEvent =
  | BaseDomainEvent
  | NoteOnEvent
  | NoteOffEvent
  | StepTriggeredEvent
  | ParamChangedEvent
  | CableConnectedEvent
  | CableDisconnectedEvent;
