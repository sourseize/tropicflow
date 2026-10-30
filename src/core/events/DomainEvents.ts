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
  | 'RECORDING_STOPPED'
  | 'TAKE_STARTED'
  | 'TAKE_STOPPED'
  | 'CHAMBER_COLLISION'
  | 'CHAMBER_CHANGED';

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
  /** Audio-context time at which the step will actually sound. */
  audioTime: number;
  /** Audio-context time when the step was scheduled (always <= audioTime). */
  contextTime: number;
}

export interface ChamberCollisionEvent extends BaseDomainEvent {
  type: 'CHAMBER_COLLISION';
  /** When the resulting note sounds. */
  audioTime: number;
  contextTime: number;
  ballId: number;
  surfaceId: string;
  surfaceKind: string;
  track: string;
  impactSpeed: number;
}

export interface RecordingEvent extends BaseDomainEvent {
  type: 'RECORDING_STARTED' | 'RECORDING_STOPPED';
  bars: number;
  sampleRate: number;
}

/** Live take recording (what you hear) started / stopped. */
export interface TakeEvent extends BaseDomainEvent {
  type: 'TAKE_STARTED' | 'TAKE_STOPPED';
  /** Length of the finished take in seconds (0 for TAKE_STARTED). */
  durationSeconds: number;
  /** Why the take stopped: user/transport stop, max length reached, or nothing was captured. */
  reason?: 'stopped' | 'max-length' | 'empty';
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
  | RecordingEvent
  | TakeEvent
  | ChamberCollisionEvent
  | ParamChangedEvent
  | CableConnectedEvent
  | CableDisconnectedEvent;
