/**
 * InfoView against a real GET /v1/info + /v1/usage snapshot (the store's own
 * connect path): server chips, the model table with the default badge and
 * effort pills, plan usage, limits, tools and storage — plus the
 * not-connected state and the shapes an older or leaner server can send.
 * F3103's lesson: every view needs a render WITH data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { InfoView } from "./InfoView.js";
import { connectStore, fullInfo, planUsage } from "../lib/storeHarness.js";
import { Tips } from "../lib/testTips.js";
import { store } from "../lib/store.js";

vi.mock("../lib/api.js", async () => await import("../lib/storeHarness.js"));

const show = () => render(<Tips><InfoView /></Tips>);
const section = (title: string): HTMLElement => screen.getByRole("heading", { level: 2, name: title }).closest("section") as HTMLElement;
const chipValue = (scope: HTMLElement, label: string): string | undefined =>
  within(scope).getByText(label).closest(".chip")?.querySelector(".chip-value")?.textContent;

beforeEach(() => cleanup());
afterEach(() => store.shutdown());

describe("InfoView", () => {
  it("says so while there is nothing to show (not connected)", () => {
    show();
    expect(screen.getByText("not connected…")).toBeTruthy();
  });

  it("renders the server facts from /v1/info", async () => {
    await connectStore({ info: fullInfo, usage: planUsage({ fiveHour: 42, weekly: 10 }) });
    show();

    const server = section("server");
    expect(chipValue(server, "name")).toBe("WrongForge");
    expect(chipValue(server, "version")).toBe("v0.4.27");
    expect(chipValue(server, "protocol")).toBe("2");
    expect(chipValue(server, "account")).toBe("signed in");
    expect(chipValue(server, "default model")).toBe("claude-sonnet-5-5");
    expect(chipValue(server, "effort default")).toBe("medium");
    expect(chipValue(server, "effort levels")).toBe("low · medium · high");
    expect(chipValue(server, "queue")).toBe("0/2 running · 0 queued");
    expect(chipValue(server, "cache")).toBe("5m (5m|1h|off)");
    expect(chipValue(server, "features")).toBe("tasks · proxy · webhooks");

    const limits = section("workdir & limits");
    expect(chipValue(limits, "default workdir")).toBe("/work");
    expect(chipValue(limits, "workdir lock")).toBe("opt-in");
    expect(chipValue(limits, "allowed roots")).toBe("/work ; /tmp");
    expect(chipValue(limits, "context window")).toBe("200k · compact at 160k · clear at 185k");
    expect(chipValue(limits, "max body")).toBe("40 MB");
    expect(chipValue(limits, "steps")).toBe("default 50 · max 500");
    expect(chipValue(limits, "webhook")).toBe("sha256=abc");

    const tools = section("tools (4)");
    for (const tool of ["bash", "read", "write", "edit"]) expect(within(tools).getByText(tool)).toBeTruthy();
    expect(tools.textContent).toContain("tool guides: edit: never rewrite whole files");

    const storage = section("storage & mcp");
    expect(chipValue(storage, "data")).toBe("/data");
    expect(chipValue(storage, "sessions")).toBe("/data/sessions");
    expect(chipValue(storage, "mcp")).toBe("1 server(s) · /data/mcp.json");
  });

  it("marks the default model and the default effort level", async () => {
    await connectStore({ info: fullInfo });
    show();
    const rows = [...section("models & effort").querySelectorAll<HTMLTableRowElement>("tbody tr")];
    expect(rows.map((r) => r.cells[0].textContent)).toEqual(["claude-sonnet-5-5default", "claude-opus-5-5", "m-mini"]);
    expect(rows.map((r) => r.className)).toEqual(["info-row-default", "", ""]);
    expect(rows[0].cells[1].textContent).toBe("balanced");
    // one pill per level; only the default level is switched on
    expect([...rows[0].querySelectorAll(".effort-pill")].map((p) => [p.textContent, p.className.includes("effort-on")])).toEqual([
      ["low", false],
      ["medium", true],
      ["high", false],
    ]);
    // a model without effort support or a description
    expect(rows[2].cells[1].textContent).toBe("—");
    expect(rows[2].cells[2].textContent).toBe("—");
  });

  it("falls back to the plain model list when the server sends no model_details", async () => {
    await connectStore({ info: { ...fullInfo, model_details: undefined } });
    show();
    const rows = [...section("models & effort").querySelectorAll<HTMLTableRowElement>("tbody tr")];
    expect(rows.length).toBe(3);
    expect(rows[1].cells[0].textContent).toBe("claude-opus-5-5");
    expect(rows[1].cells[1].textContent).toBe("—");
    expect(rows[1].cells[2].textContent).toBe("—");
  });

  it("draws the plan windows that exist and the extra-usage meter when it is on", async () => {
    await connectStore({ info: fullInfo, usage: planUsage({ fiveHour: 42, weekly: 10, extra: true }) });
    show();
    const plan = section("plan usage");
    const bars = [...plan.querySelectorAll(".insp-usage-row")].map((row) => [
      row.querySelector(".usage-name")?.textContent,
      row.querySelector<HTMLElement>(".bar-fill")?.style.width,
      row.querySelector(".mono")?.textContent,
    ]);
    expect(bars).toEqual([
      ["5h window", "42%", "42%"],
      ["weekly", "10%", "10%"],
    ]);
    expect(chipValue(plan, "extra usage")).toBe("used 120 / 500 credits");
  });

  it("shows no weekly row without a weekly window, and a warning tone near the limit", async () => {
    await connectStore({ info: fullInfo, usage: planUsage({ fiveHour: 95, weekly: null }) });
    show();
    const plan = section("plan usage");
    expect(within(plan).queryByText("weekly")).toBeNull();
    expect(plan.querySelector<HTMLElement>(".bar-fill")?.className).toContain("tone-warn");
  });

  it("says so when usage is unavailable, and flags an unsigned server", async () => {
    await connectStore({
      info: { ...fullInfo, signed_in: false, features: [], workdir: { ...fullInfo.workdir, default: null, allowed_roots: [] } },
      usage: null,
    });
    show();
    expect(screen.getByText("usage unavailable (signed in? the server caches it 5 min)")).toBeTruthy();
    expect(chipValue(section("server"), "account")).toBe("NOT signed in");
    expect(chipValue(section("server"), "features")).toBe("—");
    const limits = section("workdir & limits");
    expect(chipValue(limits, "default workdir")).toBe("— (required per task)");
    expect(chipValue(limits, "allowed roots")).toBe("unrestricted");
  });
});
