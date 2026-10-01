import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIpcRenderer, mockExposeInMainWorld } = vi.hoisted(() => ({
  mockIpcRenderer: {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  mockExposeInMainWorld: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcRenderer: mockIpcRenderer,
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
}));

// Each preload runs exposeInMainWorld at import time. Import them all, then
// index the recorded calls by the key they exposed themselves under.
await import('../../src/preload/pill');
await import('../../src/preload/popup');
await import('../../src/preload/logs');
await import('../../src/preload/onboarding');

const exposedByKey = new Map<string, Record<string, unknown>>();
for (const [key, value] of mockExposeInMainWorld.mock.calls as Array<[string, Record<string, unknown>]>) {
  if (!exposedByKey.has(key)) exposedByKey.set(key, value);
}

const keysFor = (key: string): string[] => Object.keys(exposedByKey.get(key) ?? {}).sort();

beforeEach(() => {
  mockIpcRenderer.invoke.mockClear();
  mockIpcRenderer.send.mockClear();
  mockIpcRenderer.on.mockClear();
  mockIpcRenderer.removeListener.mockClear();
  mockIpcRenderer.removeAllListeners.mockClear();
});

describe('preload bridge registry', () => {
  it('every bridge exposes its own namespaced key', () => {
    for (const key of ['pillAPI', 'popupHostAPI', 'logsAPI', 'onboardingAPI']) {
      expect(exposedByKey.has(key), `missing ${key}`).toBe(true);
    }
  });

  it('pill, popup and logs each re-expose electronAPI (known duplication)', () => {
    // These three bridge files each expose a partial `electronAPI`, which
    // shadows the full one from shell.ts in their own renderer only. Pinned
    // here so removing one of them is a deliberate change, not an accident.
    const electronApiCallers = mockExposeInMainWorld.mock.calls.filter(
      ([key]) => key === 'electronAPI',
    ).length;
    expect(electronApiCallers).toBe(3);
  });

  it('onboarding does not leak electronAPI into its window', () => {
    // Onboarding can create a session, so it gets the real API — but it must
    // not also expose a second, partial surface under the same key.
    const onboarding = mockExposeInMainWorld.mock.calls.filter(
      ([key, value]) => key === 'onboardingAPI',
    );
    expect(onboarding).toHaveLength(1);
  });
});

describe('pill bridge', () => {
  it('exposes the documented session and window controls', () => {
    expect(keysFor('pillAPI')).toEqual(
      expect.arrayContaining([
        'followUpSubmit',
        'getKeybindings',
        'hide',
        'listSessions',
        'onFollowUpMode',
        'onSettingsMode',
        'openHub',
        'openSettings',
        'selectSession',
        'submit',
      ]),
    );
  });

  it('selectSession sends the session id over IPC', () => {
    (exposedByKey.get('pillAPI') as { selectSession: (id: string) => void }).selectSession('abc');
    expect(mockIpcRenderer.send).toHaveBeenCalled();
  });

  it('hide invokes pill:hide', () => {
    (exposedByKey.get('pillAPI') as { hide: () => void }).hide();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('pill:hide');
  });

  it('event subscriptions return an unsubscribe function', () => {
    const api = exposedByKey.get('pillAPI') as {
      onFollowUpMode: (cb: () => void) => () => void;
    };
    const off = api.onFollowUpMode(() => {});
    expect(typeof off).toBe('function');
    expect(mockIpcRenderer.on).toHaveBeenCalled();
  });
});

describe('popup bridge', () => {
  it('exposes the popup host lifecycle', () => {
    expect(keysFor('popupHostAPI')).toEqual(
      expect.arrayContaining(['action', 'close', 'contentReady', 'onRender', 'ready', 'resize']),
    );
  });

  it('ready and contentReady signal the host over IPC', () => {
    const api = exposedByKey.get('popupHostAPI') as {
      ready: () => void;
      contentReady: (id: string) => void;
    };
    api.ready();
    api.contentReady('popup-1');
    expect(mockIpcRenderer.send).toHaveBeenCalledTimes(2);
  });

  it('onRender returns an unsubscribe function', () => {
    const api = exposedByKey.get('popupHostAPI') as { onRender: (cb: () => void) => () => void };
    expect(typeof api.onRender(() => {})).toBe('function');
  });
});

describe('logs bridge', () => {
  it('exposes mode control and session focus events', () => {
    expect(keysFor('logsAPI')).toEqual(
      expect.arrayContaining(['close', 'onActiveSessionChanged', 'onFocusFollowUp', 'onModeChanged', 'setMode']),
    );
  });

  it('setMode sends the requested mode', () => {
    (exposedByKey.get('logsAPI') as { setMode: (m: string) => void }).setMode('full');
    expect(mockIpcRenderer.send).toHaveBeenCalled();
  });

  it('onModeChanged returns an unsubscribe function', () => {
    const api = exposedByKey.get('logsAPI') as { onModeChanged: (cb: () => void) => () => void };
    expect(typeof api.onModeChanged(() => {})).toBe('function');
  });
});

describe('onboarding bridge', () => {
  it('exposes the onboarding surface', () => {
    const keys = keysFor('onboardingAPI');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain('openExternal');
  });
});
