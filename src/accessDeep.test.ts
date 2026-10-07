import { setDeep } from './accessDeep.js';

import { describe, it, expect } from 'vitest';

describe('setDeep',  () => {
  it('correctly sets values in maps', async () => {
    const obj = {
      a: new Map([[new Set(['NaN']), [[1, 'undefined']]]]),
    };

    await setDeep(obj, ['a', 0, 0, 0], async v => Number(v));
    await setDeep(obj, ['a', 0, 1], async entries => new Map(entries));
    await setDeep(obj, ['a', 0, 1, 0, 1], async () => undefined);

    expect(obj).toEqual({
      a: new Map([[new Set([NaN]), new Map([[1, undefined]])]]),
    });
  });

  it('correctly sets values in sets', async () => {
    const obj = {
      a: new Set([10, new Set(['NaN'])]),
    };

    await setDeep(obj, ['a', 1, 0], async v => Number(v));

    expect(obj).toEqual({
      a: new Set([10, new Set([NaN])]),
    });
  });
});
