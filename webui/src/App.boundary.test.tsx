/**
 * The shell under failure: a view that throws during render is contained to
 * its own pane or tab — the top bar, the other tabs and the server keep
 * working. Before ViewBoundary existed there was no error boundary anywhere,
 * so React unmounted the root and one missing helper blanked the whole
 * dashboard (F3103). The two views are mocked to throw on demand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import App from "./App.js";
import { connectStore, fullInfo } from "./lib/storeHarness.js";
import { store } from "./lib/store.js";

const bomb = vi.hoisted(() => ({ insights: true, inspector: false }));

vi.mock("./lib/api.js", async () => await import("./lib/storeHarness.js"));
vi.mock("./components/InsightsView.js", () => ({
  InsightsView: () => {
    if (bomb.insights) throw new Error("boom: insights");
    return <div className="info-page">insights ok</div>;
  },
}));
vi.mock("./components/Inspector.js", () => ({
  Inspector: () => {
    if (bomb.inspector) throw new Error("boom: inspector");
    return <aside className="inspector">inspector ok</aside>;
  },
}));

const card = (): HTMLElement | null => document.querySelector<HTMLElement>(".view-error");
const openTab = (name: string): void => {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
};

beforeEach(() => {
  cleanup();
  bomb.insights = false;
  bomb.inspector = false;
  // React reports an error a boundary caught through console.error; expected here
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  store.shutdown();
  vi.restoreAllMocks();
});

describe("App shell — a view that crashes", () => {
  it("is contained: its tab shows an error card, the shell and the other tabs keep working", async () => {
    await connectStore({ info: fullInfo });
    bomb.insights = true;
    render(<App />);
    openTab("Insights");

    expect(card()?.getAttribute("role")).toBe("alert");
    expect(card()?.textContent).toContain("the Insights view crashed");
    expect(card()?.textContent).toContain("boom: insights");
    expect(screen.queryByText("insights ok")).toBeNull();
    expect(document.querySelector(".topbar")).toBeTruthy(); // the shell survived

    openTab("Proxy"); // another tab is untouched
    expect(card()).toBeNull();
    expect(screen.getByText("no Anthropic-compatible calls yet")).toBeTruthy();
  });

  it("tries again on request, and a reopened tab starts clean", async () => {
    await connectStore({ info: fullInfo });
    bomb.insights = true;
    render(<App />);
    openTab("Insights");

    fireEvent.click(screen.getByText("try again")); // still broken
    expect(card()?.textContent).toContain("boom: insights");

    bomb.insights = false;
    fireEvent.click(screen.getByText("try again")); // fixed → the view comes back
    expect(card()).toBeNull();
    expect(screen.getByText("insights ok")).toBeTruthy();

    bomb.insights = true;
    openTab("Overview");
    openTab("Insights"); // a remount does not carry the old error
    expect(screen.getByText("boom: insights")).toBeTruthy();
  });

  it("keeps the task rail and the live feed when one pane of the overview crashes", async () => {
    await connectStore({ info: fullInfo });
    bomb.inspector = true;
    render(<App />);

    expect(card()?.textContent).toContain("the inspector view crashed");
    expect(card()?.textContent).toContain("boom: inspector");
    expect(document.querySelector(".rail")).toBeTruthy();
    expect(document.querySelector(".feed")).toBeTruthy();
    expect(screen.getByText("nothing has reached this server yet")).toBeTruthy(); // the live feed is alive

    bomb.inspector = false;
    fireEvent.click(screen.getByText("try again"));
    expect(card()).toBeNull();
    expect(document.querySelector(".inspector")?.textContent).toBe("inspector ok");
  });
});
