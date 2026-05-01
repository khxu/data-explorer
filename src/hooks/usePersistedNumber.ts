import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";

interface PersistedNumberOptions {
  min: number;
  max: number;
}

function clamp(value: number, { min, max }: PersistedNumberOptions) {
  return Math.min(Math.max(value, min), max);
}

function parsePersistedNumber(
  storedValue: string | null,
  fallback: number,
  options: PersistedNumberOptions
) {
  if (storedValue === null) return fallback;

  const parsed = Number(storedValue);
  if (!Number.isFinite(parsed)) return fallback;

  return clamp(parsed, options);
}

export function usePersistedNumber(
  key: string,
  fallback: number,
  options: PersistedNumberOptions
): [number, Dispatch<SetStateAction<number>>] {
  const [value, setValue] = useState(() => {
    if (typeof window === "undefined") return fallback;

    try {
      return parsePersistedNumber(window.localStorage.getItem(key), fallback, options);
    } catch (error) {
      console.warn(`Unable to load persisted number for "${key}"`, error);
      return fallback;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(clamp(value, options)));
    } catch (error) {
      console.warn(`Unable to save persisted number for "${key}"`, error);
    }
  }, [key, options, value]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      setValue(parsePersistedNumber(event.newValue, fallback, options));
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [fallback, key, options]);

  const setPersistedValue: Dispatch<SetStateAction<number>> = useCallback(
    (nextValue) => {
      setValue((currentValue) =>
        clamp(
          typeof nextValue === "function" ? nextValue(currentValue) : nextValue,
          options
        )
      );
    },
    [options]
  );

  return [value, setPersistedValue];
}
