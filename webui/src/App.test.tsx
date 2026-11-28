/**
 * The shell as shipped (real views) through the store's own connect path:
 * the locked state and its key dialog, the overview layout, tab switching,
 * a feed row selecting its task in the inspector, the lost-stream banner and
 * the action toast. The store is a singleton: the locked case runs first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import App from "./App.js";
import { api, connectStore, ev, fullInfo } from "./lib/storeHarness.js";
import { store } from "./lib/store.js";

vi.mock("./lib/api.js", async () => await import("./lib/storeHarness.js"));

const openTab = (name: string): void => {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
};

beforeEach(() => cleanup());
afterEach(() => store.shutdown());

describe("App", () => {
  it("asks for the key while the server's is unknown, hides the tabs, and offers no way out", async () => {
    render(<App />);
    expect(document.querySelector(".locked-note")?.textContent).toContain("The API on this origin requires a key.");
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Connect to WrongForge");
    expect(dialog.querySelector(".dialog-close")).toBeNull(); // locked: there is nothing to dismiss into
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("lays out the overview and switches between tabs", async () => {
    await connectStore({ info: fullInfo });
    render(<App />);
    expect(document.querySelector(".rail")).toBeTruthy();
    expect(document.querySelector(".feed")).toBeTruthy();
    expect(document.querySelector(".insp-title")?.textContent).toBe("system");
    expect(document.querySelector(".locked-note")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Overview", "Insights", "Sessions", "Info", "Proxy"]);

    openTab("Info");
    expect(screen.getByRole("heading", { level: 2, name: "server" })).toBeTruthy();
    openTab("Proxy");
    expect(screen.getByText("no Anthropic-compatible calls yet")).toBeTruthy();
    openTab("Sessions");
    expect(screen.getByText("no sessions yet")).toBeTruthy();
    openTab("Insights");
    expect(screen.getByRole("heading", { level: 2, name: "usage history" })).toBeTruthy();
    openTab("Overview");
    expect(document.querySelector(".rail")).toBeTruthy();
  });

  it("selects the task behind a live-feed row in the inspector, and keeps the selection across tabs", async () => {
    const link = await connectStore({ info: fullInfo });
    link.push(ev("tsk_from_feed", "task.started", { model: "m-one", workdir: "/work" }));
    render(<App />);
    expect(document.querySelector(".insp-title")?.textContent).toBe("system");

    // the task id shows in the rail row too: the feed's own button is the one that opens the inspector
    fireEvent.click(document.querySelector<HTMLElement>(".feed .feed-task")!);
    expect(document.querySelector(".insp-title")?.textContent).toBe("tsk_from_feed");

    openTab("Info"); // the inspector lives on the overview only
    expect(document.querySelector(".inspector")).toBeNull();
    openTab("Overview");
    expect(document.querySelector(".insp-title")?.textContent).toBe("tsk_from_feed"); // still selected

    fireEvent.click(document.querySelector(".dialog-close")!); // and it can be closed
    expect(document.querySelector(".insp-title")?.textContent).toBe("system");
  });

  it("shows the lost-stream banner, names a wrong key, and opens the key dialog on request", async () => {
    const link = await connectStore({ info: fullInfo });
    await link.open();
    render(<App />);
    expect(document.querySelector(".conn-banner")).toBeNull();

    act(() => link.setConn("reconnecting", "HTTP 401"));
    const banner = document.querySelector(".conn-banner")!;
    expect(banner.textContent).toContain("live feed lost — HTTP 401 — retrying in the background");
    expect(banner.textContent).toContain("the key looks wrong");
    act(() => link.setConn("reconnecting", "network error"));
    expect(document.querySelector(".conn-banner")?.textContent).not.toContain("the key looks wrong");

    fireEvent.click(screen.getByText("change key"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Connect to WrongForge");
    expect(dialog.querySelector(".dialog-close")).toBeTruthy(); // opened on request: it can be closed again (F3107)
    fireEvent.click(dialog.querySelector(".dialog-close")!);
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => link.setConn("open"));
    expect(document.querySelector(".conn-banner")).toBeNull();
    expect(document.querySelector(".conn-open")?.textContent).toContain("live");
  });

  it("toasts a failed action until it is dismissed", async () => {
    await connectStore({ info: fullInfo });
    render(<App />);
    api.mockRejectedValueOnce(new Error("HTTP 500: tools_unavailable"));
    await act(async () => {
      await store.fireTestRequest();
    });
    const toast = screen.getByRole("alert");
    expect(toast.textContent).toContain("⚠ HTTP 500: tools_unavailable");

    fireEvent.click(within(toast).getByText("×"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
