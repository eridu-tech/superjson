import {
  isArray,
  isEmptyObject,
  isError,
  isMap,
  isPlainObject,
  isPrimitive,
  isSet,
} from './is.js';
import { escapeKey, stringifyPath } from './pathstringifier.js';
import {
  isInstanceOfRegisteredClass,
  transformValue,
  TypeAnnotation,
  untransformValue,
} from './transformer.js';
import { includes, forEach } from './util.js';
import { parsePath } from './pathstringifier.js';
import { getDeep, setDeep } from './accessDeep.js';
import SuperJSON from './index.js';

type Tree<T> = InnerNode<T> | Leaf<T>;
type Leaf<T> = [T];
type InnerNode<T> = [T, Record<string, Tree<T>>];

export type MinimisedTree<T> = Tree<T> | Record<string, Tree<T>> | undefined;

const enableLegacyPaths = (version: number) => version < 1;

async function traverse<T>(
  tree: MinimisedTree<T>,
  walker: (v: T, path: string[]) => Promise<void>,
  version: number,
  origin: string[] = []
): Promise<void> {
  if (!tree) {
    return;
  }

  const legacyPaths = enableLegacyPaths(version);
  if (!isArray(tree)) {
    await forEach(tree, async (subtree, key) =>
      traverse(subtree, walker, version, [
        ...origin,
        ...parsePath(key, legacyPaths),
      ])
    );
    return;
  }

  const [nodeValue, children] = tree;
  if (children) {
    await forEach(children, async (child, key) =>
      traverse(child, walker, version, [
        ...origin,
        ...parsePath(key, legacyPaths),
      ])
    );
  }

  await walker(nodeValue, origin);
}

export async function applyValueAnnotations(
  plain: any,
  annotations: MinimisedTree<TypeAnnotation>,
  version: number,
  superJson: SuperJSON
) {
  await traverse(
    annotations,
    async (type, path) => {
      plain = await setDeep(plain, path, v =>
        untransformValue(v, type, superJson)
      );
    },
    version
  );

  return plain;
}

export async function applyReferentialEqualityAnnotations(
  plain: any,
  annotations: ReferentialEqualityAnnotations,
  version: number
) {
  const legacyPaths = enableLegacyPaths(version);
  async function apply(identicalPaths: string[], path: string) {
    const object = getDeep(plain, parsePath(path, legacyPaths));

    const promises = identicalPaths
      .map(path => parsePath(path, legacyPaths))
      .map(async identicalObjectPath => {
        plain = await setDeep(plain, identicalObjectPath, async () => object);
      });
    await Promise.all(promises);
  }

  if (isArray(annotations)) {
    const [root, other] = annotations;
    const promises = root.map(async identicalPath => {
      plain = await setDeep(
        plain,
        parsePath(identicalPath, legacyPaths),
        () => plain
      );
    });
    await Promise.all(promises);

    if (other) {
      await forEach(other, apply);
    }
  } else {
    await forEach(annotations, apply);
  }

  return plain;
}

const isDeep = (object: any, superJson: SuperJSON): boolean =>
  isPlainObject(object) ||
  isArray(object) ||
  isMap(object) ||
  isSet(object) ||
  isError(object) ||
  isInstanceOfRegisteredClass(object, superJson);

function addIdentity(object: any, path: any[], identities: Map<any, any[][]>) {
  const existingSet = identities.get(object);

  if (existingSet) {
    existingSet.push(path);
  } else {
    identities.set(object, [path]);
  }
}

interface Result {
  transformedValue: any;
  annotations?: MinimisedTree<TypeAnnotation>;
}

export type ReferentialEqualityAnnotations =
  | Record<string, string[]>
  | [string[]]
  | [string[], Record<string, string[]>];

export function generateReferentialEqualityAnnotations(
  identitites: Map<any, any[][]>,
  dedupe: boolean
): ReferentialEqualityAnnotations | undefined {
  const result: Record<string, string[]> = {};
  let rootEqualityPaths: string[] | undefined = undefined;

  identitites.forEach(paths => {
    if (paths.length <= 1) {
      return;
    }

    // if we're not deduping, all of these objects continue existing.
    // putting the shortest path first makes it easier to parse for humans
    // if we're deduping though, only the first entry will still exist, so we can't do this optimisation.
    if (!dedupe) {
      paths = paths
        .map(path => path.map(String))
        .sort((a, b) => a.length - b.length);
    }

    const [representativePath, ...identicalPaths] = paths;

    if (representativePath.length === 0) {
      rootEqualityPaths = identicalPaths.map(stringifyPath);
    } else {
      result[stringifyPath(representativePath)] = identicalPaths.map(
        stringifyPath
      );
    }
  });

  if (rootEqualityPaths) {
    if (isEmptyObject(result)) {
      return [rootEqualityPaths];
    } else {
      return [rootEqualityPaths, result];
    }
  } else {
    return isEmptyObject(result) ? undefined : result;
  }
}

export const walker = async (
  object: any,
  identities: Map<any, any[][]>,
  superJson: SuperJSON,
  dedupe: boolean,
  path: any[] = [],
  objectsInThisPath: any[] = [],
  seenObjects = new Map<unknown, Result>()
): Promise<Result> => {
  const primitive = isPrimitive(object);

  if (!primitive) {
    addIdentity(object, path, identities);

    const seen = seenObjects.get(object);
    if (seen) {
      // short-circuit result if we've seen this object before
      return dedupe
        ? {
            transformedValue: null,
          }
        : seen;
    }
  }

  if (!isDeep(object, superJson)) {
    const transformed = await transformValue(object, superJson);

    const result: Result = transformed
      ? {
          transformedValue: transformed.value,
          annotations: [transformed.type],
        }
      : {
          transformedValue: object,
        };
    if (!primitive) {
      seenObjects.set(object, result);
    }
    return result;
  }

  if (includes(objectsInThisPath, object)) {
    // prevent circular references
    return {
      transformedValue: null,
    };
  }

  const transformationResult = await transformValue(object, superJson);
  const transformed = transformationResult?.value ?? object;

  const transformedValue: any = isArray(transformed) ? [] : {};
  const innerAnnotations: Record<string, Tree<TypeAnnotation>> = {};

  await forEach(transformed, async (value, index) => {
    if (
      index === '__proto__' ||
      index === 'constructor' ||
      index === 'prototype'
    ) {
      throw new Error(
        `Detected property ${index}. This is a prototype pollution risk, please remove it from your object.`
      );
    }

    const recursiveResult = await walker(
      value,
      identities,
      superJson,
      dedupe,
      [...path, index],
      [...objectsInThisPath, object],
      seenObjects
    );

    transformedValue[index] = recursiveResult.transformedValue;

    if (isArray(recursiveResult.annotations)) {
      innerAnnotations[escapeKey(index)] = recursiveResult.annotations;
    } else if (isPlainObject(recursiveResult.annotations)) {
      await forEach(recursiveResult.annotations, async (tree, key) => {
        innerAnnotations[escapeKey(index) + '.' + key] = tree;
      });
    }
  });

  const result: Result = isEmptyObject(innerAnnotations)
    ? {
        transformedValue,
        annotations: !!transformationResult
          ? [transformationResult.type]
          : undefined,
      }
    : {
        transformedValue,
        annotations: !!transformationResult
          ? [transformationResult.type, innerAnnotations]
          : innerAnnotations,
      };
  if (!primitive) {
    seenObjects.set(object, result);
  }

  return result;
};
