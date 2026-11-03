import type React from 'react';
import type { GraphNode } from '../../core/graph/GraphTypes.ts';
import type { ModuleInstance } from '../../core/modules/ModuleContract.ts';

/** What a plugin's card body receives from the generic ModuleCard shell. */
export interface ModuleBodyProps<T extends ModuleInstance = ModuleInstance> {
  instance: T;
  node: GraphNode;
  /** Re-render the card after a knob moved (state lives in the instance). */
  refresh: () => void;
}

export type ModuleBody<T extends ModuleInstance = ModuleInstance> = React.FC<ModuleBodyProps<T>>;
