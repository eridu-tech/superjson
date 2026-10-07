import {
  isBigint,
  isDate,
  isInfinite,
  isMap,
  isNaNValue,
  isRegExp,
  isSet,
  isUndefined,
  isSymbol,
  isArray,
  isError,
  isTypedArray,
  TypedArray,
  TypedArrayConstructor,
  BigIntTypedArrayConstructor,
  isURL,
} from './is.js';
import { findArr } from './util.js';
import SuperJSON from './index.js';
import { JSONValue } from './types.js';

export type PrimitiveTypeAnnotation = 'number' | 'undefined' | 'bigint';

type LeafTypeAnnotation = PrimitiveTypeAnnotation | 'regexp' | 'Date' | 'URL';

type TypedArrayAnnotation = ['typed-array', string];
type ClassTypeAnnotation = ['class', string];
type SymbolTypeAnnotation = ['symbol', string];
type CustomTypeAnnotation = ['custom', string];

type SimpleTypeAnnotation = LeafTypeAnnotation | 'map' | 'set' | 'Error';

type CompositeTypeAnnotation =
  | TypedArrayAnnotation
  | ClassTypeAnnotation
  | SymbolTypeAnnotation
  | CustomTypeAnnotation;

export type TypeAnnotation = SimpleTypeAnnotation | CompositeTypeAnnotation;

function simpleTransformation<I, O, A extends SimpleTypeAnnotation>(
  isApplicable: (v: any, superJson: SuperJSON) => v is I,
  annotation: A,
  transform: (v: I, superJson: SuperJSON) => O,
  untransform: (v: O, superJson: SuperJSON) => I
) {
  return {
    isApplicable,
    annotation,
    transform,
    untransform,
  };
}

const simpleRules = [
  simpleTransformation(
    isUndefined,
    'undefined',
    () => null,
    () => undefined
  ),
  simpleTransformation(
    isBigint,
    'bigint',
    v => v.toString(),
    v => {
      if (typeof BigInt !== 'undefined') {
        return BigInt(v);
      }

      console.error('Please add a BigInt polyfill.');

      return v as any;
    }
  ),
  simpleTransformation(
    isDate,
    'Date',
    v => v.toISOString(),
    v => new Date(v)
  ),

  simpleTransformation(
    isError,
    'Error',
    (v, superJson) => {
      const baseError: any = {
        name: v.name,
        message: v.message,
      };

      if ('cause' in v) {
        baseError.cause = v.cause;
      }

      superJson.allowedErrorProps.forEach(prop => {
        baseError[prop] = (v as any)[prop];
      });

      return baseError;
    },
    (v, superJson) => {
      const e =
        'cause' in v
          ? new Error(v.message, { cause: v.cause })
          : new Error(v.message);
      e.name = v.name;
      e.stack = v.stack;

      superJson.allowedErrorProps.forEach(prop => {
        (e as any)[prop] = v[prop];
      });

      return e;
    }
  ),

  simpleTransformation(
    isRegExp,
    'regexp',
    v => '' + v,
    regex => {
      const body = regex.slice(1, regex.lastIndexOf('/'));
      const flags = regex.slice(regex.lastIndexOf('/') + 1);
      return new RegExp(body, flags);
    }
  ),

  simpleTransformation(
    isSet,
    'set',
    // (sets only exist in es6+)
    // eslint-disable-next-line es5/no-es6-methods
    v => [...v.values()],
    v => new Set(v)
  ),
  simpleTransformation(
    isMap,
    'map',
    v => [...v.entries()],
    v => new Map(v)
  ),

  simpleTransformation<number, 'NaN' | 'Infinity' | '-Infinity', 'number'>(
    (v): v is number => isNaNValue(v) || isInfinite(v),
    'number',
    v => {
      if (isNaNValue(v)) {
        return 'NaN';
      }

      if (v > 0) {
        return 'Infinity';
      } else {
        return '-Infinity';
      }
    },
    Number
  ),

  simpleTransformation<number, '-0', 'number'>(
    (v): v is number => v === 0 && 1 / v === -Infinity,
    'number',
    () => {
      return '-0';
    },
    Number
  ),

  simpleTransformation(
    isURL,
    'URL',
    v => v.toString(),
    v => new URL(v)
  ),
];

function compositeTransformation<I, O, A extends CompositeTypeAnnotation>(
  isApplicable: (v: any, superJson: SuperJSON) => Promise<boolean>,
  annotation: (v: I, superJson: SuperJSON) => Promise<A>,
  transform: (v: I, superJson: SuperJSON) => Promise<O>,
  untransform: (v: O, a: A, superJson: SuperJSON) => Promise<I>
) {
  return {
    isApplicable,
    annotation,
    transform,
    untransform,
  };
}

const symbolRule = compositeTransformation<
  Symbol,
  string | undefined,
  ['symbol', string]
>(
  async (s, superJson): Promise<boolean> => {
    if (isSymbol(s)) {
      const isRegistered = !!superJson.symbolRegistry.getIdentifier(s);
      return isRegistered;
    }
    return false;
  },
  async (s, superJson) => {
    const identifier = superJson.symbolRegistry.getIdentifier(s);
    return ['symbol', identifier!];
  },
  async v => v.description,
  async (_, a, superJson) => {
    const value = superJson.symbolRegistry.getValue(a[1]);
    if (!value) {
      throw new Error('Trying to deserialize unknown symbol');
    }
    return value;
  }
);

const constructorToName = [
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  Uint8ClampedArray,
].reduce<Record<string, TypedArrayConstructor>>((obj, ctor) => {
  obj[ctor.name] = ctor;
  return obj;
}, {});

// BigInt-backed typed arrays hold `bigint` elements, which JSON.stringify
// cannot represent. They're serialized/deserialized as strings instead.
const bigIntConstructorToName: Record<string, BigIntTypedArrayConstructor> = {};
if (typeof BigInt64Array !== 'undefined') {
  bigIntConstructorToName[BigInt64Array.name] = BigInt64Array;
}
if (typeof BigUint64Array !== 'undefined') {
  bigIntConstructorToName[BigUint64Array.name] = BigUint64Array;
}

const typedArrayRule = compositeTransformation<
  TypedArray,
  (string | number)[],
  ['typed-array', string]
>(
  async a => isTypedArray(a),
  async v => ['typed-array', v.constructor.name],
  async v =>
    [...v].map(n => {
      // bigint values (from BigInt64Array / BigUint64Array) are not valid JSON,
      // so they're stored as strings.
      if (typeof n === 'bigint') {
        return n.toString();
      }
      // Handle special float values that JSON.stringify converts to null
      if (typeof n === 'number') {
        if (Number.isNaN(n)) return 'NaN';
        if (n === Infinity) return 'Infinity';
        if (n === -Infinity) return '-Infinity';
      }
      return n;
    }),
  async (v, a) => {
    const bigIntCtor = bigIntConstructorToName[a[1]];
    if (bigIntCtor) {
      const values = v.map((n: string | number | bigint): bigint => BigInt(n));
      return new bigIntCtor(values);
    }

    const ctor = constructorToName[a[1]];

    if (!ctor) {
      throw new Error('Trying to deserialize unknown typed array');
    }

    // Convert string representations back to special float values
    const values = v.map((n: number | string): number => {
      if (n === 'NaN') return NaN;
      if (n === 'Infinity') return Infinity;
      if (n === '-Infinity') return -Infinity;
      return n as number;
    });

    return new ctor(values as number[]);
  }
);

export function isInstanceOfRegisteredClass(
  potentialClass: any,
  superJson: SuperJSON
): potentialClass is any {
  if (potentialClass?.constructor) {
    const isRegistered = !!superJson.classRegistry.getIdentifier(
      potentialClass.constructor
    );
    return isRegistered;
  }
  return false;
}

const classRule = compositeTransformation<any, any, ['class', string]>(
  async (value, superJson) => isInstanceOfRegisteredClass(value, superJson),
  async (clazz, superJson) => {
    const identifier = superJson.classRegistry.getIdentifier(clazz.constructor);
    return ['class', identifier!];
  },
  async (clazz, superJson) => {
    const allowedProps = superJson.classRegistry.getAllowedProps(
      clazz.constructor
    );
    if (!allowedProps) {
      return { ...clazz };
    }

    const result: any = {};
    allowedProps.forEach(prop => {
      result[prop] = clazz[prop];
    });
    return result;
  },
  async (v, a, superJson) => {
    const clazz = superJson.classRegistry.getValue(a[1]);

    if (!clazz) {
      throw new Error(
        `Trying to deserialize unknown class '${a[1]}' - check https://github.com/blitz-js/superjson/issues/116#issuecomment-773996564`
      );
    }

    return Object.assign(Object.create(clazz.prototype), v);
  }
);

const customRule = compositeTransformation<
  any,
  JSONValue | Promise<JSONValue>,
  ['custom', any]
>(
  async (value, superJson): Promise<boolean> => {
    return !!(await superJson.customTransformerRegistry.findApplicable(value));
  },
  async (value, superJson) => {
    const transformer = (await superJson.customTransformerRegistry.findApplicable(
      value
    ))!;
    return ['custom', transformer.name];
  },
  async (value, superJson) => {
    const transformer = (await superJson.customTransformerRegistry.findApplicable(
      value
    ))!;
    return transformer.serialize(value);
  },
  async (v, a, superJson) => {
    const transformer = superJson.customTransformerRegistry.findByName(a[1]);
    if (!transformer) {
      throw new Error('Trying to deserialize unknown custom value');
    }
    return transformer.deserialize(v);
  }
);

const compositeRules = [classRule, symbolRule, customRule, typedArrayRule];

export const transformValue = async (
  value: any,
  superJson: SuperJSON
): Promise<{ value: any; type: TypeAnnotation } | undefined> => {
  const applicableCompositeRule = await findArr(compositeRules, async rule =>
    await rule.isApplicable(value, superJson)
  );
  if (applicableCompositeRule) {
    return {
      value: await applicableCompositeRule.transform(value as never, superJson),
      type: await applicableCompositeRule.annotation(value, superJson),
    };
  }

  const applicableSimpleRule = await findArr(simpleRules, async rule =>
    rule.isApplicable(value, superJson)
  );

  if (applicableSimpleRule) {
    return {
      value: applicableSimpleRule.transform(value as never, superJson),
      type: applicableSimpleRule.annotation,
    };
  }

  return undefined;
};

const simpleRulesByAnnotation: Record<string, typeof simpleRules[0]> = {};
simpleRules.forEach(rule => {
  simpleRulesByAnnotation[rule.annotation] = rule;
});

export const untransformValue = async (
  json: any,
  type: TypeAnnotation,
  superJson: SuperJSON
) => {
  if (isArray(type)) {
    switch (type[0]) {
      case 'symbol':
        return symbolRule.untransform(json, type, superJson);
      case 'class':
        return classRule.untransform(json, type, superJson);
      case 'custom':
        return customRule.untransform(json, type, superJson);
      case 'typed-array':
        return typedArrayRule.untransform(json, type, superJson);
      default:
        throw new Error('Unknown transformation: ' + type);
    }
  } else {
    const transformation = simpleRulesByAnnotation[type];
    if (!transformation) {
      throw new Error('Unknown transformation: ' + type);
    }

    return transformation.untransform(json as never, superJson);
  }
};
