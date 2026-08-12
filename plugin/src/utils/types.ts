export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : {
      readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
    };

const mergeDeepPartial = <T extends object>(base: T, partial: DeepPartial<T>): T => {
  const merged = { ...base };
  for (const key in partial) {
    if (
      typeof partial[key] === "object" &&
      partial[key] !== null &&
      typeof base[key] === "object" &&
      base[key] !== null
    ) {
      merged[key] = mergeDeepPartial(base[key], partial[key]);
    } else if (partial[key] !== undefined) {
      merged[key] = partial[key] as T[typeof key];
    }
  }
  return merged;
};

const isDeepPartialComplete = <T extends object>(obj: T, partial: DeepPartial<T>): boolean => {
  for (const key in obj) {
    if (!(key in partial)) {
      return false;
    }

    if (
      typeof obj[key] === "object" &&
      obj[key] !== null &&
      typeof partial[key] === "object" &&
      partial[key] !== null
    ) {
      if (!isDeepPartialComplete(obj[key] as object, partial[key] as DeepPartial<object>)) {
        return false;
      }
    } else if (partial[key] === undefined) {
      return false;
    }
  }

  return true;
};

export const DeepPartial = {
  merge: mergeDeepPartial,
  isComplete: isDeepPartialComplete,
};

export const assertNever = (value: never, description: string): never => {
  throw new Error(`${description}: ${JSON.stringify(value)}`);
};
