/**
 * TopBar through the live path (storeHarness): the connection label, the
 * server chips, the http meter and last-request ticker fed by real
 * `http.request` frames through the store's own SSE handler, the update chip
 * and the plan-usage bars. The http counters accumulate across a file's
 * tests, so the exact-count case runs first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TopBar } from "./TopBar.js";
import { connectStore, ev, fullInfo, httpFrame, planUsage } from "../lib/storeHarness.js";
import { Tips } from "../lib/testTips.js";
import { store } from "../lib/store.js";

vi.mock("../lib/api.js", async () => await import("../lib/storeHarness.js"));

const chipValue = (label: string): string | undefined =>
  within(document.querySelector(".topbar-chips")!).getByText(label).closest(".chip")?.querySelector(".chip-value")?.textContent;

beforeEach(() => cleanup());
afterEach(() => {
  store.shutdown();
  vi.useRealTimers();
});

describe("TopBar", () => {
  it("shows the locked state before any key", () => {
    render(<Tips><TopBar /></Tips>);
    expect(screen.getByText("WrongForge")).toBeTruthy();
    expect(document.querySelector(".conn-locked")?.textContent).toContain("no key");
    expect(document.querySelector(".topbar-chips")).toBeNull();
    expect(document.querySelector(".http-last")).toBeNull();
  });

  it("says connecting until the stream is up, then live", async () => {
    const link = await connectStore({ info: fullInfo });
    render(<Tips><TopBar /></Tips>);
    expect(document.querySelector(".conn-wait")?.textContent).toContain("connecting…");
    await link.open();
    expect(document.querySelector(".conn-open")?.textContent).toContain("live");
  });

  it("counts requests, errors and the per-minute rate from http frames, and ticks the last one", async () => {
    const link = await connectStore({ info: fullInfo });
    await link.open();
    link.push(httpFrame("GET", "/v1/tasks?limit=300", 200, 12));
    link.push(httpFrame("POST", "/v1/tasks", 202, 30));
    link.push(httpFrame("GET", "/v1/nope", 404, 5));
    render(<Tips><TopBar /></Tips>);

    expect(chipValue("http")).toBe("3 · 3/min · 1 err");
    expect(within(document.querySelector(".topbar-chips")!).getByText("http").closest(".chip")!.className).toContain("tone-red");

    const last = document.querySelector(".http-last")!;
    expect(last.querySelector(".http-last-method")?.textContent).toBe("GET");
    expect(last.querySelector(".http-last-path")?.textContent).toBe("/v1/nope");
    expect(last.querySelector(".http-last-status")?.textContent).toBe("404");
    expect(last.querySelector(".http-last-status")?.className).toContain("hstat-4xx");
    expect(last.querySelector(".http-last-age")?.textContent).toBe("5ms · 0s ago");
  });

  it("forgets requests older than a minute from the rate, but not from the total", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const link = await connectStore({ info: fullInfo });
    link.push(httpFrame("GET", "/v1/tasks?limit=300", 200, 12));
    render(<Tips><TopBar /></Tips>);
    act(() => vi.advanceTimersByTime(61_000));
    const http = store.getState().http;
    expect(chipValue("http")).toBe(`${http.total} · 0/min · ${http.errors} err`);
  });

  it("sums model calls and tokens from step frames", async () => {
    const link = await connectStore({ info: fullInfo });
    link.push(ev("t-top", "step.request", { step: 1, model: "m-one", messages: 1, tools: 1, max_tokens: 10 }));
    link.push(ev("t-top", "step.finished", { step: 1, finish_reason: "end_turn", usage: { input_tokens: 1200, output_tokens: 300 }, context_tokens: 1500 }));
    render(<Tips><TopBar /></Tips>);
    expect(chipValue("model")).toBe("claude-sonnet-5-5");
    expect(chipValue("queue")).toBe("0/2 · 0 queued");
    expect(chipValue("requests")).toBe("1");
    expect(chipValue("tokens")).toBe("↑1.2k ↓300");
    expect(chipValue("cache read")).toBe("0");
  });

  it("offers the update when the server saw a newer release", async () => {
    await connectStore({ info: { ...fullInfo, update: { current: "0.4.27", latest: "0.4.28", url: "https://example.test/releases/0.4.28", notes: "" } } });
    render(<Tips><TopBar /></Tips>);
    const chip = within(document.querySelector(".topbar-chips")!).getByText("update").closest(".chip")!;
    expect(chip.querySelector(".chip-value")?.textContent).toBe("v0.4.28 available");
    expect(chip.className).toContain("tone-red");
    expect(document.querySelector(".ver")?.textContent).toBe("v0.4.27");
  });

  it("draws the plan windows that exist", async () => {
    await connectStore({ info: fullInfo, usage: planUsage({ fiveHour: 42, weekly: 10 }) });
    render(<Tips><TopBar /></Tips>);
    expect([...document.querySelectorAll<HTMLElement>(".usage-mini .bar-fill")].map((b) => b.style.width)).toEqual(["42%", "10%"]);
  });

  it("draws only the 5h bar without a weekly window", async () => {
    await connectStore({ info: fullInfo, usage: planUsage({ fiveHour: 7 }) });
    render(<Tips><TopBar /></Tips>);
    expect([...document.querySelectorAll<HTMLElement>(".usage-mini .bar-fill")].map((b) => b.style.width)).toEqual(["7%"]);
    expect(document.querySelectorAll(".usage-mini .usage-label").length).toBe(1);
  });
});
