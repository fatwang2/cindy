import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'notifications.wecomGroupEnabled';
const subscribers = new Set<() => void>();

export function getWecomGroupNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setWecomGroupNotificationsEnabled(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Keep the in-memory UI usable when localStorage is unavailable.
  }
  for (const subscriber of subscribers) subscriber();
}

export function useWecomGroupNotificationSettings() {
  const [enabled, setEnabledState] = useState(getWecomGroupNotificationsEnabled);
  const [configured, setConfigured] = useState(false);
  const [maskedKey, setMaskedKey] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.wecomGroupNotification
      .getState()
      .then((state) => {
        if (cancelled) return;
        setConfigured(state.configured);
        setMaskedKey(state.maskedKey);
        if (!state.configured) setWecomGroupNotificationsEnabled(false);
      })
      .catch(() => {
        if (!cancelled) {
          setConfigured(false);
          setWecomGroupNotificationsEnabled(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const onChange = () => setEnabledState(getWecomGroupNotificationsEnabled());
    subscribers.add(onChange);
    window.addEventListener('storage', onChange);
    return () => {
      cancelled = true;
      subscribers.delete(onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setWecomGroupNotificationsEnabled(next);
  }, []);

  const saveAndTest = useCallback(async (webhookUrl: string) => {
    setBusy(true);
    try {
      const state = await window.electronAPI.wecomGroupNotification.saveAndTest(webhookUrl);
      setConfigured(state.configured);
      setMaskedKey(state.maskedKey);
      setWecomGroupNotificationsEnabled(true);
    } finally {
      setBusy(false);
    }
  }, []);

  const test = useCallback(async () => {
    setBusy(true);
    try {
      await window.electronAPI.wecomGroupNotification.test();
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(async () => {
    setBusy(true);
    try {
      await window.electronAPI.wecomGroupNotification.clear();
      setConfigured(false);
      setMaskedKey(undefined);
      setWecomGroupNotificationsEnabled(false);
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    enabled,
    setEnabled,
    configured,
    maskedKey,
    loading,
    busy,
    saveAndTest,
    test,
    clear,
  };
}
