const tails = new Map<string, Promise<void>>();

export async function withRepoCacheMutation<T>(cachePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(cachePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  tails.set(cachePath, tail);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(cachePath) === tail) {
      tails.delete(cachePath);
    }
  }
}
