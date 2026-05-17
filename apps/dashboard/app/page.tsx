"use client";

import { useDashboard } from "../lib/state";
import { Header } from "../components/Header";
import { Headline } from "../components/Headline";
import { AgentStrip } from "../components/AgentStrip";
import { Ticker } from "../components/Ticker";
import { MetricPanels } from "../components/MetricPanels";
import { PagePreview } from "../components/PagePreview";

export default function Page() {
  const state = useDashboard();
  return (
    <div className="h-screen flex flex-col">
      <Header connected={state.connected} jobsCompleted={state.jobsCompleted} />
      <Headline state={state} />
      <div className="flex-1 grid grid-cols-[260px_1fr_320px] min-h-0">
        <AgentStrip state={state} />
        <Ticker events={state.events} />
        <MetricPanels state={state} />
      </div>
      <PagePreview preview={state.preview} />
    </div>
  );
}
