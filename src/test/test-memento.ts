// VS Code Mementos serialize writes and return the supplied default for absent keys.
export function createTestMemento() {
  const values = new Map<string, unknown>();
  const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
  return {
    keys: () => [...values.keys()],
    get<T>(key: string, fallback?: T): T | undefined {
      return values.has(key) ? clone(values.get(key) as T) : fallback;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) { values.delete(key); }
      else { values.set(key, clone(value)); }
    }
  };
}
