/** Durable conversations: size, turns, workdir — and the stored messages. */

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { api } from "../lib/api.js";
import { store, useStore } from "../lib/store.js";
import type { AgentMessage, SessionMeta } from "../lib/types.js";
import { shortId } from "../lib/types.js";
import { Bar, Chip, JsonPeek, Tip } from "./bits.js";

export function SessionsView() {
  const sessions = useStore((s) => s.sessions);
  const info = useStore((s) => s.info);
  const [open, setOpen] = useState<SessionMeta | null>(null);
  const window0 = info?.context.window ?? 1_000_000;

  return (
    <div className="sessions">
      <div className="feed-toolbar">
        <span className="feed-count">{sessions.length} sessions</span>
      </div>
      <div className="tasks-scroll">
        <table className="task-table">
          <thead>
            <tr>
              <th>session</th>
              <th>title</th>
              <th>turns</th>
              <th>messages</th>
              <th>context</th>
              <th>model</th>
              <th>workdir</th>
              <th>updated</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="task-row" onClick={() => setOpen(s)}>
                <td className="mono">{shortId(s.id, 16)}</td>
                <td className="prompt-cell">{s.title || <span className="dim">—</span>}</td>
                <td className="mono">{s.turns}</td>
                <td className="mono">{s.message_count}</td>
                <td className="ctx-cell">
                  {typeof s.context_tokens === "number" ? (
                    <Tip text={`${s.context_tokens} / ${window0} tokens`}>
                      <span className="ctx-cell-inner">
                        <Bar percent={(s.context_tokens / window0) * 100} tone={s.context_tokens / window0 > 0.8 ? "tone-warn" : undefined} />
                        <span className="mono dim">{Math.round((s.context_tokens / window0) * 100)}%</span>
                      </span>
                    </Tip>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td className="mono dim">{s.model ?? "—"}</td>
                <td className="mono dim">{s.workdir ?? "—"}</td>
                <td className="mono dim">{new Date(s.updated_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions.length === 0 && <div className="empty">no sessions yet</div>}
      </div>
      <MessagesDialog session={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function MessagesDialog({ session, onClose }: { session: SessionMeta | null; onClose: () => void }) {
  const [messages, setMessages] = useState<AgentMessage[] | null>(null);
  // Set when the fetch failed: a failed fetch is not an empty session.
  const [error, setError] = useState<string | null>(null);
  const sid = session?.id ?? null;

  useEffect(() => {
    setMessages(null);
    setError(null);
    if (!sid) return;
    let alive = true;
    void (async () => {
      try {
        const res = await api<{ messages: AgentMessage[] }>(`/v1/sessions/${sid}/messages?limit=1000`, store.getState().key);
        if (alive) setMessages(res.messages);
      } catch (e) {
        if (alive) setError((e as Error).message || "the server did not answer");
      }
    })();
    return () => {
      alive = false;
    };
  }, [sid]);

  return (
    <Dialog.Root open={Boolean(session)} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content dialog-task">
          <div className="dialog-header">
            <Dialog.Title className="dialog-title mono">{sid ?? ""}</Dialog.Title>
            <Dialog.Close asChild>
              <button className="dialog-close" aria-label="close">
                ✕
              </button>
            </Dialog.Close>
          </div>
          {session && (
            <div className="task-meta">
              <Chip label="title" value={session.title || "—"} />
              <Chip label="turns" value={String(session.turns)} />
              <Chip label="messages" value={String(session.message_count)} />
              <Chip label="compactions" value={String(session.compactions ?? 0)} />
            </div>
          )}
          <div className="session-messages">
            {error && <div className="task-error">could not load messages: {error}</div>}
            {messages === null && !error && <div className="empty">loading messages…</div>}
            {messages?.length === 0 && <div className="empty">no stored messages</div>}
            {messages?.map((m, i) => (
              <MessageRow key={i} m={m} />
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MessageRow({ m }: { m: AgentMessage }) {
  const role = m.role;
  let text = "";
  if (typeof m.content === "string") text = m.content;
  else if (Array.isArray(m.content)) {
    // Stored shape (src/messages.ts): "tool-call"/"tool-result" (hyphenated,
    // toolName/input/output) — not the API wire format's "tool_use"/
    // "tool_result" (underscored, name/content), which these messages never
    // actually carry once read back from a session file.
    text = (m.content as Array<{ type?: string; text?: string; toolName?: string; input?: unknown; output?: unknown }>)
      .map((b) =>
        b.type === "text"
          ? b.text ?? ""
          : b.type === "tool-call"
            ? `⇢ ${b.toolName ?? "tool"}(${JSON.stringify(b.input ?? {}).slice(0, 60)})`
            : b.type === "tool-result"
              ? `⇠ ${b.toolName ?? "tool"}`
              : b.type === "thinking"
                ? "(thinking)"
                : `(${b.type ?? "block"})`,
      )
      .join("\n");
  }
  const preview = text.replace(/\s+/g, " ").slice(0, 160);
  return (
    <div className={`msg msg-${role}`}>
      <span className="msg-role">{role}</span>
      <span className="msg-text">{preview || <span className="dim">∅</span>}</span>
      <JsonPeek value={m.content} label="{ }" max={0} />
    </div>
  );
}
