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

// Importing the preload runs exposeInMainWorld once (ESM caches the module),
// so grab the exposed API here and reuse it across every test.
await import('../../../src/preload/shell');

type ShellApi = {
  log: (level: string, ns: string, msg: string, extra?: Record<string, unknown>) => void;
  shell: {
    platform: string;
    getPlatform: () => Promise<string>;
    setOverlay: (active: boolean) => void;
    openExternal: (url: string) => Promise<{ opened: boolean }>;
  };
  pill: { toggle: () => Promise<void>; hide: () => Promise<void> };
  sessions: Record<string, unknown>;
  settings: Record<string, unknown>;
};

const exposed = mockExposeInMainWorld.mock.calls[0];
const api = exposed[1] as ShellApi;

beforeEach(() => {
  // Clear IPC recording, but keep the exposeInMainWorld call recorded.
  mockIpcRenderer.invoke.mockClear();
  mockIpcRenderer.send.mockClear();
  mockIpcRenderer.send.mockImplementation(() => {});
});

describe('preload shell bridge — contextBridge surface', () => {
  it('exposes electronAPI under a single well-known key', () => {
    expect(exposed[0]).toBe('electronAPI');
  });

  it('exposes the documented namespaces', () => {
    expect(typeof api.log).toBe('function');
    expect(typeof api.shell.getPlatform).toBe('function');
    expect(typeof api.pill.toggle).toBe('function');
    expect(api.sessions).toBeTypeOf('object');
    expect(api.settings).toBeTypeOf('object');
  });

  it('reports the host platform without an IPC round-trip', () => {
    expect(api.shell.platform).toBe(process.platform);
    expect(mockIpcRenderer.invoke).not.toHaveBeenCalled();
  });
});

describe('preload shell bridge — logging is fire-and-forget', () => {
  it('forwards structured log lines over send, not invoke', () => {
    api.log('info', 'test', 'hello', { key: 'value' });

    expect(mockIpcRenderer.send).toHaveBeenCalledWith(
      'renderer:log',
      'info',
      'test',
      'hello',
      { key: 'value' },
    );
    expect(mockIpcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('swallows transport failures so logging cannot crash the renderer', () => {
    mockIpcRenderer.send.mockImplementation(() => {
      throw new Error('transport closed');
    });

    expect(() => api.log('error', 'ns', 'msg')).not.toThrow();
  });
});

describe('preload shell bridge — shell IPC', () => {
  it('getPlatform invokes shell:get-platform and returns the value', async () => {
    mockIpcRenderer.invoke.mockResolvedValue('darwin');

    await expect(api.shell.getPlatform()).resolves.toBe('darwin');
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('shell:get-platform');
  });

  it('openExternal passes the URL through untouched', async () => {
    mockIpcRenderer.invoke.mockResolvedValue({ opened: true });

    await expect(api.shell.openExternal('https://example.com')).resolves.toEqual({ opened: true });
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('shell:open-external', 'https://example.com');
  });

  it('setOverlay sends without awaiting a reply', () => {
    api.shell.setOverlay(true);

    expect(mockIpcRenderer.send).toHaveBeenCalledWith('shell:set-overlay', true);
    expect(mockIpcRenderer.invoke).not.toHaveBeenCalled();
  });
});

describe('preload shell bridge — pill IPC', () => {
  it('toggle invokes pill:toggle', async () => {
    mockIpcRenderer.invoke.mockResolvedValue(undefined);

    await api.pill.toggle();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('pill:toggle');
  });

  it('hide invokes pill:hide', async () => {
    mockIpcRenderer.invoke.mockResolvedValue(undefined);

    await api.pill.hide();
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('pill:hide');
  });
});
