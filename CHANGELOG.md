# @eridu-tech/superjson

## 3.0.0

### Major Changes

- 4d497bd: The public API is now asynchronous: `stringify`, `parse`, `serialize` and `deserialize` return Promises, and custom transformers may perform async work.

  ### Breaking changes

  `SuperJSON.stringify`, `SuperJSON.parse`, `SuperJSON.serialize` and `SuperJSON.deserialize` — together with the named exports `stringify`, `parse`, `serialize`, `deserialize` — are now `async`:

  - `stringify(object)` returns `Promise<string>`
  - `parse<T>(string)` returns `Promise<T>`
  - `serialize(object)` returns `Promise<SuperJSONResult>`
  - `deserialize<T>(payload)` returns `Promise<T>`

  Callers must now `await` these methods. The registration methods (`registerClass`, `registerSymbol`, `registerCustom`, `allowErrorProps`) remain synchronous.

  ### Custom transformers

  The `CustomTransfomer` hooks (`isApplicable`, `serialize`, `deserialize`) may now return either a value or a `Promise`, so custom transformers can perform asynchronous work (for example, lazily loading a class before serializing it).

  ### Migration

  ```ts
  // before
  const json = superjson.stringify(object);
  const parsed = superjson.parse(json);

  // after
  const json = await superjson.stringify(object);
  const parsed = await superjson.parse(json);
  ```
