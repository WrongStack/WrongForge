/**
 * ProxyView through the live path (storeHarness): `proxy.call` frames pushed
 * into the store's own SSE handler land as rows — newest first, toned by
 * status and auth mode — the rate-limit chip read from the
 * anthropic-ratelimit-* headers, the expanded request/response summaries, and
 * replay protection. The call list accumulates across a file's tests, so the
 * exact-count and order cases run first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProxyView } from "./ProxyView.js";
import { connectStore, proxyCall } from "../lib/storeHarness.js";
import { store } from "../lib/store.js";

vi.mock("../lib/api.js", async () => await import("../lib/storeHarness.js"));

const cardOf = (model: string): HTMLElement => screen.getByText(model).closest(".tool-card") as HTMLElement;
const rateChip = (model: string): HTMLElement | null => cardOf(model).querySelector<HTMLElement>(".chip[title^='anthropic-ratelimit']");
const ratelimit = (requestsRemaining: number, tokensRemaining: number): Record<string, string> => ({
  "anthropic-ratelimit-requests-remaining": String(requestsRemaining),
  "anthropic-ratelimit-requests-limit": "50",
  "anthropic-ratelimit-tokens-remaining": String(tokensRemaining),
  "anthropic-ratelimit-tokens-limit": "20000",
});

beforeEach(() => cleanup());
afterEach(() => store.shutdown());

describe("ProxyView", () => {
  it("explains itself before the first call", () => {
    render(<ProxyView />);
    expect(screen.getByText("no Anthropic-compatible calls yet")).toBeTruthy();
    expect(screen.getByText("0 calls")).toBeTruthy();
  });

  it("lists calls newest first with method, path, model, auth, status and duration", async () => {
    const link = await connectStore();
    link.push(proxyCall({ id: "pc_first", model: "m-one", stream: true, auth_mode: "oauth", status: 200, duration_ms: 840 }));
    link.push(proxyCall({ id: "pc_second", method: "GET", path: "/v1/models", model: undefined, stream: undefined, auth_mode: "api_key", status: 500, duration_ms: 1200 }));
    render(<ProxyView />);

    expect(screen.getByText("2 calls")).toBeTruthy();
    const cards = [...document.querySelectorAll<HTMLElement>(".tool-card")];
    expect(cards.length).toBe(2);
    const [newest, older] = cards;

    expect(newest.querySelector(".feed-method")?.textContent).toBe("GET");
    expect(newest.querySelector(".feed-path")?.textContent).toBe("/v1/models");
    expect(newest.querySelector(".feed-status")?.textContent).toBe("500");
    expect(newest.querySelector(".feed-status")?.className).toContain("hstat-5xx");
    expect(newest.querySelector(".feed-dur")?.textContent).toBe("1200ms");
    expect(newest.querySelector(".feed-dur")?.className).toContain("dur-slow");
    expect(newest.className).toContain("tool-failed");
    expect(within(newest).getByText("api_key").closest(".chip")!.className).toContain("tone-amber");
    expect(within(newest).queryByText("stream")).toBeNull();

    expect(older.querySelector(".feed-method")?.textContent).toBe("POST");
    expect(older.querySelector(".feed-status")?.textContent).toBe("200");
    expect(older.querySelector(".feed-dur")?.className).not.toContain("dur-slow");
    expect(older.className).toContain("tool-done");
    expect(older.className).not.toContain("tool-failed");
    expect(within(older).getByText("oauth").closest(".chip")!.className).toContain("tone-cyan");
    expect(within(older).getByText("stream")).toBeTruthy();
    expect(rateChip("m-one")).toBeNull(); // no anthropic-ratelimit headers → no chip
  });

  it("turns the rate-limit headers into one chip, amber then red as the budget runs out", async () => {
    const link = await connectStore();
    link.push(proxyCall({ id: "pc_rl_ok", model: "rl-ok", response_headers: ratelimit(42, 18100) }));
    link.push(proxyCall({ id: "pc_rl_amber", model: "rl-amber", response_headers: ratelimit(12, 19000) }));
    link.push(proxyCall({ id: "pc_rl_red", model: "rl-red", response_headers: ratelimit(40, 1500) }));
    render(<ProxyView />);

    expect(rateChip("rl-ok")!.textContent).toBe("⚡ 42/50 req · 18.1k/20k tok");
    expect(rateChip("rl-ok")!.className).not.toMatch(/tone-(amber|red)/);
    expect(rateChip("rl-amber")!.textContent).toBe("⚡ 12/50 req · 19k/20k tok");
    expect(rateChip("rl-amber")!.className).toContain("tone-amber");
    expect(rateChip("rl-amber")!.className).not.toContain("tone-red");
    expect(rateChip("rl-red")!.textContent).toBe("⚡ 40/50 req · 1.5k/20k tok");
    expect(rateChip("rl-red")!.className).toContain("tone-red");
  });

  it("shows the request and response summaries when a call is expanded", async () => {
    const link = await connectStore();
    link.push(
      proxyCall({
        id: "pc_expanded",
        model: "m-expanded",
        path: "/v1/messages/count_tokens",
        stream: false,
        request_headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "context-1m-2025-08-07" },
        request_truncated: true,
        response_body: "data: not json",
        response_truncated: true,
      }),
    );
    render(<ProxyView />);
    expect(screen.queryByText("2 headers")).toBeNull(); // collapsed

    fireEvent.click(within(cardOf("m-expanded")).getByText("show"));
    const [request, response] = [...cardOf("m-expanded").querySelectorAll<HTMLElement>(".tool-io-col")];
    expect(request.querySelector(".io-label")?.textContent).toContain("request (truncated — showing the first bytes only)");
    expect(within(request).getByText("2 headers")).toBeTruthy();
    expect(request.querySelectorAll(".json-peek")[1].textContent).toContain("model=claude-sonnet-5-5 · 1 msg · 1 tools");
    expect(request.querySelectorAll(".json-peek")[1].textContent).toContain("user: list the files");

    expect(response.querySelector(".io-label")?.textContent).toContain("response (truncated — showing the first bytes only)");
    expect(response.querySelectorAll(".json-peek")[0].textContent).toBe("data: not json");

    fireEvent.click(within(cardOf("m-expanded")).getByText("hide"));
    expect(cardOf("m-expanded").querySelector(".tool-body")).toBeNull();
  });

  it("lists a replayed call once", async () => {
    const link = await connectStore();
    const call = proxyCall({ id: "pc_replay", model: "m-replay" });
    link.push(call);
    link.push(call);
    render(<ProxyView />);
    expect(screen.getAllByText("m-replay").length).toBe(1);
  });
});
