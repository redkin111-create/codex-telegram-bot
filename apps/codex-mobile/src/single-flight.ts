export function coalesceInFlight<T>(slot: { current?: Promise<T> }, run: () => Promise<T>): Promise<T> {
  if (slot.current) return slot.current;
  const request = Promise.resolve().then(run).finally(() => {
    if (slot.current === request) slot.current = undefined;
  });
  slot.current = request;
  return request;
}
