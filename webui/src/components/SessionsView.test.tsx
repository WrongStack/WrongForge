/**
 * SessionsView through the store's own connect path: the session table (size,
 * context bar, model, workdir) and the stored-messages dialog (text, tool
 * call/result, thinking and empty blocks; loading; empty). An older server or
 * a failed fetch must not read as "this session is empty".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SessionsView } from "./SessionsView.js";
import { connectStore, flush, fullInfo } from "../lib/storeHarness.js";
import { Tips } from "../lib/testTips.js";
import { store } from "../lib/store.js";
import type { AgentMessage, SessionMeta } from "../lib/types.js";

vi.mock("../lib/api.js", async () => await import("../lib/storeHarness.js"));

const UPDATED = "2026-11-28T11:30:00.000Z";
const session = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  created_at: UPDATED,
  updated_at: UPDATED,
  turns: 3,
  message_count: 7,
  title: `task ${id}`,
  model: "m-one",
  workdir: "/work",
  context_tokens: 40_000,
  compactions: 1,
  ...over,
});
const cells = (id: string): string[] => [...(screen.getByText(id).closest("tr") as HTMLTableRowElement).cells].map((c) => c.textContent ?? "");

beforeEach(() => cleanup());
afterEach(() => store.shutdown());

describe("SessionsView", () => {
  it("says so when there are no sessions", async () => {
    await connectStore({ sessions: [] });
    render(<Tips><SessionsView /></Tips>);
    expect(screen.getByText("no sessions yet")).toBeTruthy();
    expect(screen.getByText("0 sessions")).toBeTruthy();
  });

  it("lists each session with its size, context, model and workdir", async () => {
    await connectStore({
      info: fullInfo,
      sessions: [session("ses_big", { context_tokens: 170_000 }), session("ses_bare", { context_tokens: undefined, title: "", model: undefined, workdir: undefined })],
    });
    render(<Tips><SessionsView /></Tips>);
    expect(screen.getByText("2 sessions")).toBeTruthy();

    expect(cells("ses_big").slice(0, 7)).toEqual(["ses_big", "task ses_big", "3", "7", "85%", "m-one", "/work"]);
    expect(cells("ses_big")[7]).toBe(new Date(UPDATED).toLocaleString());
    expect(screen.getByText("ses_big").closest("tr")!.querySelector(".bar-fill")?.className).toContain("tone-warn");

    // no context estimate, title, model or workdir: dashes, never "NaN%" or a crash
    expect(cells("ses_bare").slice(0, 7)).toEqual(["ses_bare", "—", "3", "7", "—", "—", "—"]);
  });

  it("opens a session's stored messages in a dialog", async () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "list the   files" },
      { role: "assistant", content: [{ type: "text", text: "running ls" }, { type: "tool-call", toolName: "bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool-result", toolName: "bash", output: "a.ts" }] },
      { role: "assistant", content: [{ type: "thinking", text: "let me think" }] },
      { role: "assistant", content: [{ type: "redacted_thinking" }] },
      { role: "user", content: [] },
    ];
    await connectStore({
      info: fullInfo,
      sessions: [session("ses_open", { title: "refactor the feed", turns: 4, message_count: 9, compactions: 2 })],
      routes: new Map([["/v1/sessions/ses_open/messages?limit=1000", () => ({ messages })]]),
    });
    render(<Tips><SessionsView /></Tips>);
    fireEvent.click(screen.getByText("ses_open").closest("tr")!);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector(".dialog-title")?.textContent).toBe("ses_open");
    expect(within(dialog).getByText("title").closest(".chip")!.querySelector(".chip-value")?.textContent).toBe("refactor the feed");
    expect(within(dialog).getByText("turns").closest(".chip")!.querySelector(".chip-value")?.textContent).toBe("4");
    expect(within(dialog).getByText("compactions").closest(".chip")!.querySelector(".chip-value")?.textContent).toBe("2");
    expect([...dialog.querySelectorAll(".msg")].map((m) => [m.className.replace("msg ", ""), m.querySelector(".msg-text")?.textContent])).toEqual([
      ["msg-user", "list the files"],
      ["msg-assistant", 'running ls ⇢ bash({"command":"ls"})'],
      ["msg-user", "⇠ bash"],
      ["msg-assistant", "(thinking)"],
      ["msg-assistant", "(redacted_thinking)"],
      ["msg-user", "∅"],
    ]);
  });

  it("shows loading until the messages arrive, then the empty state", async () => {
    let release!: (body: unknown) => void;
    await connectStore({
      sessions: [session("ses_empty")],
      routes: new Map([["/v1/sessions/ses_empty/messages?limit=1000", () => new Promise((resolve) => (release = resolve))]]),
    });
    render(<Tips><SessionsView /></Tips>);
    fireEvent.click(screen.getByText("ses_empty").closest("tr")!);
    expect(await screen.findByText("loading messages…")).toBeTruthy();
    await act(async () => {
      release({ messages: [] });
      await flush();
    });
    expect(screen.getByText("no stored messages")).toBeTruthy();
  });

  it("says when the messages could not be loaded — a failed fetch is not an empty session", async () => {
    await connectStore({
      sessions: [session("ses_dead")],
      routes: new Map([["/v1/sessions/ses_dead/messages?limit=1000", () => { throw new Error("HTTP 503: session_unavailable"); }]]),
    });
    render(<Tips><SessionsView /></Tips>);
    fireEvent.click(screen.getByText("ses_dead").closest("tr")!);
    expect((await screen.findByText(/could not load messages/)).textContent).toContain("HTTP 503: session_unavailable");
    expect(screen.queryByText("no stored messages")).toBeNull();
  });
});
