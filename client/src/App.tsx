import { useEffect, useState } from "react";

export function App() {
  const [serverOk, setServerOk] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/healthz")
      .then((r) => setServerOk(r.ok))
      .catch(() => setServerOk(false));
  }, []);

  return (
    <main style={{ padding: 24, maxWidth: 480, margin: "0 auto" }}>
      <h1 style={{ fontWeight: 300, letterSpacing: "-0.02em" }}>Ember</h1>
      <p style={{ color: "var(--text-2)" }}>
        Scaffold only — the live cook screen lands in milestone 4.
      </p>
      <p style={{ color: serverOk ? "var(--ok)" : "var(--warn-fg)" }}>
        {serverOk === null
          ? "Checking server…"
          : serverOk
            ? "Server connected"
            : "Server unreachable"}
      </p>
    </main>
  );
}
