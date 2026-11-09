'use client';
// ⌘K command bar sources a page owns (ClickUp redesign P6). The bar is mounted once in
// the (auth) layout; a page registers what only it holds — the tasks page its loaded
// rows ('tasks') and its view switches ('tasksView') — and the bar reads a snapshot
// when it opens. Unmounting the page removes its sources (so "Open Tasks to search
// tasks" shows elsewhere).
import { useEffect } from 'react';

const store = new Map();

export function getCommandSource(key) { return store.get(key); }

export function useCommandSource(key, value) {
  useEffect(() => {
    store.set(key, value);
    return () => { if (store.get(key) === value) store.delete(key); };
  }, [key, value]);
}
