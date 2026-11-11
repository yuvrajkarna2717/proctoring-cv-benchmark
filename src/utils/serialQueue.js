/**
 * Runs async tasks one at a time, in call order. A task that fails does not stop later tasks.
 *
 * @returns {<T>(task: () => T | Promise<T>) => Promise<T>}
 */
export function createSerialQueue() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(() => task());
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
