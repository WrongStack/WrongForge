/** First-run dialog: ask for the server API key, validate, connect. */

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { store } from "../lib/store.js";

export function KeyGate({ open, hint, onDismiss }: { open: boolean; hint?: string | null; onDismiss?: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const ok = await store.connect(key.trim());
    setBusy(false);
    if (!ok) setError(store.getState().authError ?? "connection failed — wrong key or server unreachable");
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onDismiss?.()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content dialog-key" onOpenAutoFocus={(e) => e.preventDefault()}>
          {/* a close button only where there is something to dismiss into: the
              locked state has none; "change key" on the banner does (F3107) */}
          <div className="key-head">
            <Dialog.Title className="dialog-title">Connect to WrongForge</Dialog.Title>
            {onDismiss && (
              <Dialog.Close asChild>
                <button className="dialog-close" aria-label="close">
                  ✕
                </button>
              </Dialog.Close>
            )}
          </div>
          <Dialog.Description className="dialog-desc">
            The dashboard talks to the local API on this origin. Paste the server key
            <code> npm run serve</code> printed — it is stored in this browser only.
          </Dialog.Description>
          <div className="key-row">
            <input
              autoFocus
              type="password"
              placeholder="API key (≥ 16 chars)"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void connect()}
            />
            <button className="btn-primary" disabled={busy || !key.trim()} onClick={() => void connect()}>
              {busy ? "connecting…" : "Connect"}
            </button>
          </div>
          {(error ?? hint) && <div className="key-error">{error ?? hint}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
