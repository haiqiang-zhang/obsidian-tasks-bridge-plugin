export const assertNever = (value: never, description: string): never => {
  throw new Error(`${description}: ${JSON.stringify(value)}`);
};
