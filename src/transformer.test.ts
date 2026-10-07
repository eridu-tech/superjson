import SuperJSON from './index.js';

import { test, expect } from 'vitest';

test('throws an descriptive error when transforming', async () => {
  const instance = new SuperJSON();
  class FunnyNumber {
    constructor(private number: number) {}

    // @ts-ignore
    get theNumber() {
      return this.number;
    }
  }
  instance.registerClass(FunnyNumber);

  const { json } = await instance.serialize({
    number: new FunnyNumber(2137),
  });

  await expect(
    instance.deserialize({
      json,
      meta: {
        values: [['class', 'NotRegistered']],
      },
    })
  ).rejects.toThrowError(
    `Trying to deserialize unknown class 'NotRegistered' - check https://github.com/blitz-js/superjson/issues/116#issuecomment-773996564`
  );
});
