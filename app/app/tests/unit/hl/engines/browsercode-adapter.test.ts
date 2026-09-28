import { describe, expect, it } from 'vitest';

import { getAdapter } from '../../../../src/main/hl/engines';

describe('BrowserCode engine adapter', () => {
  it('is registered as a first-class engine', () => {
    const adapter = getAdapter('browsercode');

    expect(adapter).toBeDefined();
    expect(adapter?.id).toBe('browsercode');
    expect(adapter?.displayName).toBe('BrowserCode');
  });

  it('uses the expected headless binary', () => {
    const adapter = getAdapter('browsercode');

    expect(adapter?.binaryName).toBe('bcode');
  });
});
