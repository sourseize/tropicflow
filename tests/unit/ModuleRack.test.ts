/**
 * The plugin core without a browser: resource ledger accounting, registry
 * loading, rack lifecycle, and the default rack being exactly the canvas the
 * app always started with.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResourceLedger } from '../../src/core/modules/ResourceLedger.ts';
import { ModuleRegistry } from '../../src/core/modules/ModuleRegistry.ts';
import { ModuleRack } from '../../src/core/modules/ModuleRack.ts';
import type { ModuleDescriptor, ModuleFactory, ModuleHost, ModuleInstance } from '../../src/core/modules/ModuleContract.ts';
import { DEFAULT_RACK, FULL_RACK, RACK_PRESETS, nodesFromPreset } from '../../src/core/modules/RackPreset.ts';
import { INITIAL_CABLES, INITIAL_NODES } from '../../src/core/graph/NodeGraph.ts';
import { moduleRegistry } from '../../src/core/modules/ModuleRegistry.ts';
import '../../src/modules/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fakes: enough of an AudioNode / context / timers for the ledger
// ---------------------------------------------------------------------------

class FakeNode {
  disconnected = 0;
  disconnect(): void {
    this.disconnected++;
  }
}

function fakeCtx() {
  const created: FakeNode[] = [];
  const make = () => {
    const n = new FakeNode();
    created.push(n);
    return n;
  };
  return {
    created,
    ctx: {
      currentTime: 0,
      createGain: make,
      createOscillator: make,
      createBiquadFilter: make,
      createDelay: make,
      createAnalyser: make,
      createBufferSource: make,
      createDynamicsCompressor: make,
      createChannelSplitter: make,
      createChannelMerger: make,
    } as unknown as BaseAudioContext,
  };
}

function fakeTimers() {
  const intervals = new Set<number>();
  const frames = new Set<number>();
  let n = 0;
  return {
    intervals,
    frames,
    deps: {
      setInterval: () => {
        const h = ++n;
        intervals.add(h);
        return h;
      },
      clearInterval: (h: unknown) => {
        intervals.delete(h as number);
      },
      requestAnimationFrame: () => {
        const h = ++n;
        frames.add(h);
        return h;
      },
      cancelAnimationFrame: (h: number) => {
        frames.delete(h);
      },
    },
  };
}

class FakeTarget {
  listeners = new Map<string, Set<unknown>>();
  addEventListener(type: string, fn: unknown): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: unknown): void {
    this.listeners.get(type)?.delete(fn);
  }
  count(): number {
    let c = 0;
    for (const s of this.listeners.values()) c += s.size;
    return c;
  }
}

// ---------------------------------------------------------------------------
// ResourceLedger
// ---------------------------------------------------------------------------

test('ResourceLedger counts what it creates and releases everything exactly once', () => {
  const { ctx, created } = fakeCtx();
  const timers = fakeTimers();
  const ledger = new ResourceLedger(ctx, timers.deps);
  const target = new FakeTarget();

  ledger.gain();
  ledger.oscillator();
  const adopted = ledger.adopt(new FakeNode() as unknown as AudioNode);
  const stopInterval = ledger.setInterval(() => {}, 10);
  ledger.setInterval(() => {}, 10);
  const stopLoop = ledger.animate(() => {});
  ledger.listen(target as unknown as EventTarget, 'x', () => {});
  const off = ledger.listen(target as unknown as EventTarget, 'y', () => {});
  const stream = { stopped: 0, getTracks: () => [{ stop: () => stream.stopped++ }] };
  ledger.stream(stream as unknown as MediaStream);

  assert.deepEqual(ledger.counts(), { audioNodes: 3, timers: 2, animationLoops: 1, streams: 1, listeners: 2 });

  // Individual releases are idempotent and decrement.
  stopInterval();
  stopInterval();
  off();
  off();
  stopLoop();
  assert.deepEqual(ledger.counts(), { audioNodes: 3, timers: 1, animationLoops: 0, streams: 1, listeners: 1 });
  assert.equal(timers.intervals.size, 1);
  assert.equal(timers.frames.size, 0);
  assert.equal(target.count(), 1);

  ledger.release();
  assert.deepEqual(ledger.counts(), { audioNodes: 0, timers: 0, animationLoops: 0, streams: 0, listeners: 0 });
  assert.equal(timers.intervals.size, 0);
  assert.equal(target.count(), 0);
  assert.equal(stream.stopped, 1);
  assert.ok(created.every((n) => n.disconnected === 1));
  assert.equal((adopted as unknown as FakeNode).disconnected, 1);
  assert.ok(ledger.isReleased());
  ledger.release(); // idempotent
  assert.equal(stream.stopped, 1);
});

test('ResourceLedger.animate keeps re-arming until stopped and not after', () => {
  const { ctx } = fakeCtx();
  let pending: Array<(t: number) => void> = [];
  const ledger = new ResourceLedger(ctx, {
    requestAnimationFrame: (fn) => {
      pending.push(fn);
      return pending.length;
    },
    cancelAnimationFrame: () => {},
  });
  let ticks = 0;
  const stop = ledger.animate(() => ticks++);
  const flush = () => {
    const fns = pending;
    pending = [];
    for (const fn of fns) fn(0);
  };
  flush();
  flush();
  assert.equal(ticks, 2);
  assert.equal(pending.length, 1);
  stop();
  flush();
  assert.equal(ticks, 2);
  assert.equal(pending.length, 0);
  assert.equal(ledger.counts().animationLoops, 0);
});

// ---------------------------------------------------------------------------
// Registry + rack with a toy plugin
// ---------------------------------------------------------------------------

interface ToyInstance extends ModuleInstance {
  started: number[];
  stopped: number;
  disposed: number;
}

function toyDescriptor(type: string, opts: { async?: boolean; fail?: boolean } = {}): { descriptor: ModuleDescriptor; loads: number } {
  const counter = { loads: 0 };
  const factory: ModuleFactory = {
    create: (host: ModuleHost, id: string, state) => {
      host.ledger.gain();
      host.ledger.setInterval(() => {}, 5);
      const inst: ToyInstance = {
        id,
        descriptor,
        started: [],
        stopped: 0,
        disposed: 0,
        audioOutputs: {},
        getState: () => ({ gain: (state?.gain as number) ?? 1 }),
        onTransportStart(t) {
          this.started.push(t);
        },
        onTransportStop() {
          this.stopped++;
        },
        dispose() {
          this.disposed++;
        },
      };
      return inst;
    },
  };
  const descriptor: ModuleDescriptor = {
    type,
    title: type.toUpperCase(),
    description: 'toy',
    theme: 'lime',
    accentHex: '#000',
    cardWidthPx: 100,
    ports: [
      { id: `${type}-out`, name: 'OUT', type: 'audio-out', color: '#000' },
      { id: `${type}-in`, name: 'IN', type: 'audio-in', color: '#000' },
    ],
    load: () => {
      counter.loads++;
      if (opts.fail) return Promise.reject(new Error('boom'));
      return opts.async ? Promise.resolve(factory) : factory;
    },
  };
  const result = { descriptor, loads: 0 };
  Object.defineProperty(result, 'loads', { get: () => counter.loads });
  return result;
}

function rackWith(registry: ModuleRegistry) {
  const timers = fakeTimers();
  const { ctx } = fakeCtx();
  const rack = new ModuleRack(registry, () => {
    const ledger = new ResourceLedger(ctx, timers.deps);
    const host: ModuleHost = {
      ctx,
      realtime: false,
      publishEvents: false,
      events: { publish() {}, subscribe: () => () => {} } as unknown as ModuleHost['events'],
      ledger,
      clock: {} as ModuleHost['clock'],
      masterBus: {} as ModuleHost['masterBus'],
      portId: (specId) => specId,
      input: { stamp: (ms) => ms / 1000, publish() {}, subscribe: () => () => {}, acquirePoll: () => () => {} },
      resume: async () => {},
      playNote: () => false,
      setCv: () => {},
      quantizeTime: (t) => t,
      now: () => 0,
    };
    return { host, ledger };
  });
  return { rack, timers };
}

test('ModuleRegistry: duplicate types and ports are rejected, loads are cached, failed loads can be retried', async () => {
  const registry = new ModuleRegistry();
  const sync = toyDescriptor('a');
  const lazy = toyDescriptor('b', { async: true });
  registry.register(sync.descriptor).register(lazy.descriptor);
  assert.throws(() => registry.register(sync.descriptor), /already registered/);
  assert.throws(
    () => registry.register({ ...toyDescriptor('c').descriptor, ports: [{ id: 'p', name: 'P', type: 'cv-in', color: '' }, { id: 'p', name: 'Q', type: 'cv-in', color: '' }] }),
    /declares port "p" twice/
  );
  assert.deepEqual(registry.list().map((d) => d.type), ['a', 'b']);

  assert.ok(registry.peek('a'), 'a sync descriptor resolves on peek');
  assert.equal(registry.peek('b'), null, 'an async one does not (but starts loading)');
  await registry.load('b');
  await registry.load('b');
  assert.equal(lazy.loads, 1, 'loaded once');
  assert.ok(registry.isLoaded('b'));
  assert.ok(registry.peek('b'));
  assert.throws(() => registry.get('zzz'), /unknown module type/);

  const broken = toyDescriptor('d', { fail: true });
  registry.register(broken.descriptor);
  await assert.rejects(registry.load('d'), /boom/);
  await assert.rejects(registry.load('d'), /boom/);
  assert.equal(broken.loads, 2, 'a failed import is retried, not cached');
});

test('ModuleRack: load / add / remove / clear drive lifecycle, ledgers and nodes', async () => {
  const registry = new ModuleRegistry();
  registry.register(toyDescriptor('a').descriptor).register(toyDescriptor('b', { async: true }).descriptor);
  const { rack, timers } = rackWith(registry);
  let changes = 0;
  rack.subscribe(() => changes++);

  await assert.rejects(async () => rack.load({ modules: [{ type: 'b', id: 'b-1', position: { x: 0, y: 0 } }], cables: [] }), /not loaded yet/);

  rack.load({ modules: [{ type: 'a', id: 'a-1', position: { x: 1, y: 2 }, state: { gain: 0.5 } }], cables: [] });
  assert.equal(changes, 1);
  const a1 = rack.require<ToyInstance>('a-1');
  assert.deepEqual(a1.getState!(), { gain: 0.5 });
  assert.deepEqual(rack.nodes().map((n) => [n.id, n.title, n.position, n.inputs.length, n.outputs.length]), [['a-1', 'A', { x: 1, y: 2 }, 1, 1]]);
  assert.deepEqual(rack.inspect().total, { audioNodes: 1, timers: 1, animationLoops: 0, streams: 0, listeners: 0 });
  assert.equal(rack.inspect().editable, false);

  const b = await rack.add('b', { position: { x: 9, y: 9 } });
  assert.equal(b.id, 'b-1');
  assert.equal(rack.findByType('b'), b);
  assert.equal(timers.intervals.size, 2);
  assert.throws(() => rack.load({ modules: [{ type: 'a', id: 'x', position: { x: 0, y: 0 } }, { type: 'a', id: 'x', position: { x: 0, y: 0 } }], cables: [] }), /already in the rack/);

  // load() cleared the rack first (the failed load above already disposed a-1 and b-1).
  assert.equal(rack.list().length, 1);
  rack.load({ modules: [{ type: 'a', id: 'a-1', position: { x: 0, y: 0 } }, { type: 'b', id: 'b-1', position: { x: 0, y: 0 } }], cables: [] });
  rack.transportStart(1.5);
  rack.transportStop();
  for (const inst of rack.list() as ToyInstance[]) {
    assert.deepEqual(inst.started, [1.5]);
    assert.equal(inst.stopped, 1);
  }

  // A module added while the transport runs joins it at the same start time.
  rack.transportStart(2.5);
  const late = (await rack.add('a')) as ToyInstance;
  assert.deepEqual(late.started, [2.5]);
  rack.transportStop();
  assert.equal(late.stopped, 1);
  rack.remove(late.id);

  const inst = rack.require<ToyInstance>('b-1');
  assert.ok(rack.remove('b-1'));
  assert.equal(inst.disposed, 1);
  assert.equal(rack.remove('b-1'), false);
  assert.equal(timers.intervals.size, 1, 'the removed module\'s timer is gone');
  assert.deepEqual(rack.inspect().modules.map((m) => m.id), ['a-1']);

  rack.moveNode('a-1', { x: 7, y: 8 });
  assert.deepEqual(rack.toPreset([]).modules, [{ type: 'a', id: 'a-1', position: { x: 7, y: 8 }, state: { gain: 1 } }]);

  rack.clear();
  assert.equal(rack.list().length, 0);
  assert.equal(timers.intervals.size, 0);
  assert.deepEqual(rack.inspect().total, { audioNodes: 0, timers: 0, animationLoops: 0, streams: 0, listeners: 0 });
});

test('ModuleRack releases the ledger even when dispose throws', () => {
  const registry = new ModuleRegistry();
  const bad = toyDescriptor('bad').descriptor;
  registry.register({
    ...bad,
    load: () => ({
      create: (host, id) => {
        host.ledger.setInterval(() => {}, 1);
        return { id, descriptor: bad, dispose: () => { throw new Error('dispose failed'); } };
      },
    }),
  });
  const { rack, timers } = rackWith(registry);
  rack.load({ modules: [{ type: 'bad', id: 'bad-1', position: { x: 0, y: 0 } }], cables: [] });
  assert.equal(timers.intervals.size, 1);
  assert.throws(() => rack.remove('bad-1'), /dispose failed/);
  assert.equal(timers.intervals.size, 0);
});

// ---------------------------------------------------------------------------
// The default rack is the canvas the app always had
// ---------------------------------------------------------------------------

test('FULL_RACK derives exactly the legacy INITIAL_NODES / INITIAL_CABLES (the historical default canvas)', () => {
  const legacy = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/default-rack.legacy.json'), 'utf8'));
  // Ports gained one additive field since the fixture was frozen: the CV kind (was a table in CvBus).
  const strip = (nodes: unknown) =>
    JSON.parse(JSON.stringify(nodes), (key, value) => (key === 'cvKind' ? undefined : value));
  assert.deepEqual(strip(nodesFromPreset(moduleRegistry, FULL_RACK)), legacy.nodes);
  assert.deepEqual(strip(INITIAL_NODES), legacy.nodes);
  assert.deepEqual(JSON.parse(JSON.stringify(INITIAL_CABLES)), legacy.cables);
});

test('DEFAULT_RACK is the four tropical modules + the gravity chamber, wired as in the full studio', () => {
  assert.deepEqual(DEFAULT_RACK.modules.map((m) => m.type), ['clock', 'marimba', 'percussion', 'master', 'chamber']);
  const ids = new Set(DEFAULT_RACK.modules.map((m) => m.id));
  for (const c of DEFAULT_RACK.cables) assert.ok(ids.has(c.fromNodeId) && ids.has(c.toNodeId), `cable ${c.id} stays inside the rack`);
  // Every full-studio cable between these modules is kept (clock -> marimba / drums, chamber -> marimba / drums, both -> master).
  const expected = FULL_RACK.cables.filter((c) => ids.has(c.fromNodeId) && ids.has(c.toNodeId)).map((c) => c.id);
  assert.deepEqual(DEFAULT_RACK.cables.map((c) => c.id), expected);
  assert.equal(DEFAULT_RACK.cables.length, 6);
  assert.deepEqual(Object.keys(RACK_PRESETS), ['default', 'full']);
  assert.equal(RACK_PRESETS.full.preset, FULL_RACK);
});

test('every built-in is registered with unique port ids across the rack and every default cable resolves', () => {
  const types = moduleRegistry.list().map((d) => d.type);
  assert.deepEqual(types, ['clock', 'marimba', 'percussion', 'synth', 'delay', 'chamber', 'midi', 'sensor', 'master']);
  const ports = new Set<string>();
  for (const d of moduleRegistry.list()) {
    for (const p of d.ports) {
      assert.ok(!ports.has(p.id), `port id ${p.id} is used by two modules`);
      ports.add(p.id);
      if (p.type === 'cv-in' || p.type === 'cv-out') assert.ok(p.cvKind, `${p.id} declares its CV kind`);
    }
  }
  for (const c of FULL_RACK.cables) {
    assert.ok(ports.has(c.fromPortId) && ports.has(c.toPortId), `cable ${c.id} references known ports`);
    assert.ok(FULL_RACK.modules.some((m) => m.id === c.fromNodeId) && FULL_RACK.modules.some((m) => m.id === c.toNodeId));
  }
});
