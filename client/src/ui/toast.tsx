// Short messages at the bottom of the screen (failed commands, the grill not confirming one).

import { useSyncExternalStore } from "react";

interface Toast {
  id: number;
  text: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const fn of listeners) fn();
};

export function toast(text: string, ms = 5000): void {
  if (toasts.some((t) => t.text === text)) return;
  const id = nextId++;
  toasts = [...toasts, { id, text }].slice(-3);
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, ms);
}

export function Toasts() {
  const list = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => toasts,
  );
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}
