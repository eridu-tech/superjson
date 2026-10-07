import { JSONValue } from './types.js';
import { find } from './util.js';

export interface CustomTransfomer<I, O extends JSONValue> {
  name: string;
  isApplicable: (v: any) => boolean | Promise<boolean>;
  serialize: (v: I) => O | Promise<O>;
  deserialize: (v: O) => I | Promise<I>;
}

export class CustomTransformerRegistry {
  private transfomers: Record<string, CustomTransfomer<any, any>> = {};

  register<I, O extends JSONValue>(transformer: CustomTransfomer<I, O>) {
    this.transfomers[transformer.name] = transformer;
  }

  findApplicable<T>(v: T): Promise<CustomTransfomer<T, JSONValue> | undefined> {
    return find(this.transfomers, async transformer =>
      transformer.isApplicable(v)
    );
  }

  findByName(name: string): CustomTransfomer<any, any> {
    return this.transfomers[name];
  }
}
