/** Shell: key gate → status bar + one-screen control room.
 *
 * Overview = task rail | live feed | inspector (selected task, or the system
 * panel when nothing is selected). Graph and Sessions stay as secondary tabs.
 */

import { useEffect, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import * as Tooltip from "@radix-ui/react-tooltip";
import { loadKey } from "./lib/api.js";
import { store, useStore } from "./lib/store.js";
import { KeyGate } from "./components/KeyGate.js";
import { TopBar } from "./components/TopBar.js";
import { LiveFeed } from "./components/LiveFeed.js";
import { TaskRail } from "./components/TaskRail.js";
import { Inspector } from "./components/Inspector.js";
import { SessionsView } from "./components/SessionsView.js";
import { InsightsView } from "./components/InsightsView.js";
import { InfoView } from "./components/InfoView.js";
import { ProxyView } from "./components/ProxyView.js";
import { ViewBoundary } from "./components/ViewBoundary.js";

export default function App() {
  const conn = useStore((s) => s.conn);
  const connDetail = useStore((s) => s.connDetail);
  const authError = useStore((s) => s.authError);
  const actionError = useStore((s) => s.actionError);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [tab, setTab] = useState("overview");
  const [forceGate, setForceGate] = useState(false);
  const locked = conn === "locked";

  useEffect(() => {
    const key = loadKey();
    if (key) void store.connect(key);
    return () => store.disconnectSse();
  }, []);

  useEffect(() => {
    if (conn === "open") setForceGate(false);
  }, [conn]);

  // a task picked anywhere (feed row, rail, graph node) selects it and jumps
  // to the overview so the inspector is visible
  const pickTask = (id: string): void => {
    setOpenTaskId(id);
    setTab("overview");
  };

  return (
    <Tooltip.Provider delayDuration={250}>
      <div className="app">
        <TopBar />
        {conn === "reconnecting" && connDetail && (
          <div className="conn-banner">
            <span>
              live feed lost — {connDetail} — retrying in the background
              {connDetail.includes("401") ? " (the key looks wrong: the server may have generated a new one)" : ""}
            </span>
            <button className="banner-btn" onClick={() => setForceGate(true)}>
              change key
            </button>
          </div>
        )}
        {!locked && (
          <Tabs.Root value={tab} onValueChange={setTab} className="tabs">
            <Tabs.List className="tabs-list">
              <Tabs.Trigger value="overview" className="tabs-trigger">
                Overview
              </Tabs.Trigger>
              <Tabs.Trigger value="insights" className="tabs-trigger">
                Insights
              </Tabs.Trigger>
              <Tabs.Trigger value="sessions" className="tabs-trigger">
                Sessions
              </Tabs.Trigger>
              <Tabs.Trigger value="info" className="tabs-trigger">
                Info
              </Tabs.Trigger>
              <Tabs.Trigger value="proxy" className="tabs-trigger">
                Proxy
              </Tabs.Trigger>
            </Tabs.List>
            {/* every pane and tab in its own boundary: a view that throws during
                render must not take the rest of the dashboard down (F3103) */}
            <Tabs.Content value="overview" className="tabs-content">
              <div className="overview">
                <ViewBoundary label="tasks">
                  <TaskRail selectedId={openTaskId} onSelect={setOpenTaskId} />
                </ViewBoundary>
                <ViewBoundary label="live feed">
                  <LiveFeed onOpenTask={pickTask} />
                </ViewBoundary>
                <ViewBoundary label="inspector">
                  <Inspector taskId={openTaskId} onClose={() => setOpenTaskId(null)} />
                </ViewBoundary>
              </div>
            </Tabs.Content>
            <Tabs.Content value="insights" className="tabs-content">
              <ViewBoundary label="Insights">
                <InsightsView />
              </ViewBoundary>
            </Tabs.Content>
            <Tabs.Content value="sessions" className="tabs-content">
              <ViewBoundary label="Sessions">
                <SessionsView />
              </ViewBoundary>
            </Tabs.Content>
            <Tabs.Content value="info" className="tabs-content">
              <ViewBoundary label="Info">
                <InfoView />
              </ViewBoundary>
            </Tabs.Content>
            <Tabs.Content value="proxy" className="tabs-content">
              <ViewBoundary label="Proxy">
                <ProxyView />
              </ViewBoundary>
            </Tabs.Content>
          </Tabs.Root>
        )}
        {locked && (
          <div className="locked-note">
            The API on this origin requires a key.
            {authError && <div className="key-error">{authError}</div>}
          </div>
        )}
        {actionError && (
          <div className="toast" role="alert">
            <span>⚠ {actionError}</span>
            <button className="banner-btn" onClick={() => store.dismissToast()}>
              ×
            </button>
          </div>
        )}
        <KeyGate open={locked || forceGate} hint={authError} onDismiss={() => setForceGate(false)} />
      </div>
    </Tooltip.Provider>
  );
}
