import { type ConnectionState, ModelVizClient } from "@modelviz/client";
import { type BlockInfo, type DeviceInfo, type LiveSystemState, type PythonStatus, type SystemInfo, type LinkHealth, PROTOCOL_PATH, type RecordingInfo, type ProjectInfo, type SignalInfo, type SourceState } from "@modelviz/protocol";
import { create } from "zustand";
import { SignalStore } from "./signal-store";

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${PROTOCOL_PATH}`;

/** The single client connection shared by the whole UI. */
export const client = new ModelVizClient(wsUrl);

/** Sample buffers for every subscribed Signal. */
export const signalStore = new SignalStore();
client.onSignalChunk((chunk) => signalStore.ingest(chunk));

interface SessionState {
  connection: ConnectionState;
  connectionError: string | null;
  project: ProjectInfo | null;
  devices: DeviceInfo[];
  signals: SignalInfo[];
  sources: Record<string, SourceState>;
  health: Record<string, LinkHealth>;
  recordings: RecordingInfo[];
  blocks: BlockInfo[];
  systems: SystemInfo[];
  python: PythonStatus | null;
  live: Record<string, LiveSystemState>;
}

export const useSession = create<SessionState>(() => ({
  connection: client.state,
  connectionError: null,
  project: null,
  devices: [],
  signals: [],
  sources: {},
  health: {},
  recordings: [],
  blocks: [],
  systems: [],
  python: null,
  live: {},
}));

async function loadProjectState(project: ProjectInfo | null): Promise<void> {
  signalStore.clear();
  if (!project) {
    useSession.setState({ project, devices: [], signals: [], sources: {}, health: {}, recordings: [], blocks: [], systems: [], python: null, live: {} });
    return;
  }
  const [devices, signals, sources, recordings, blocks, systems, python, live] = await Promise.all([
    client.request("devices.list", {}),
    client.request("signals.list", {}),
    client.request("sources.list", {}),
    client.request("recordings.list", {}),
    client.request("blocks.list", {}),
    client.request("systems.list", {}),
    client.request("python.status", {}),
    client.request("system.live.list", {}),
  ]);
  useSession.setState({
    project,
    devices,
    signals,
    sources: Object.fromEntries(sources.map((s) => [s.device, s])),
    health: {},
    recordings,
    blocks,
    systems,
    python,
    live: Object.fromEntries(live.map((l) => [l.system, l])),
  });
}

client.onState((connection) => {
  useSession.setState({ connection, connectionError: client.lastError?.message ?? null });
  if (connection === "connected") {
    client.request("project.current", {}).then(loadProjectState, () => {});
  }
});
client.on("project.changed", (project) => void loadProjectState(project).catch(() => {}));
client.on("source.changed", (s) => useSession.setState((st) => ({ sources: { ...st.sources, [s.device]: s } })));
client.on("link.health", (h) => useSession.setState((st) => ({ health: { ...st.health, [h.device]: h } })));
client.on("python.changed", (python) => useSession.setState({ python }));
client.on("system.live.changed", (l) => useSession.setState((st) => ({ live: { ...st.live, [l.system]: l } })));
client.on("recording.changed", (r) =>
  useSession.setState((st) => {
    const others = st.recordings.filter((x) => x.id !== r.id);
    return { recordings: [...others, r].sort((a, b) => a.startedAt - b.startedAt) };
  }),
);
client.on("signals.reset", ({ device }) => {
  for (const s of useSession.getState().signals) if (s.device === device) signalStore.buffer(s.handle).clear();
});
client.connect();

/** Reloads Blocks and Systems after model files change. */
/** Progress of long-running Analyses by id. */
export const useProgress = create<Record<string, { done: number; total: number }>>(() => ({}));
client.on("analysis.progress", (p) => useProgress.setState({ [p.id]: { done: p.done, total: p.total } }));

export async function refreshModels(): Promise<void> {
  const [blocks, systems] = await Promise.all([client.request("blocks.list", {}), client.request("systems.list", {})]);
  useSession.setState({ blocks, systems });
}
