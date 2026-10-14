import { type ConnectionState, ModelVizClient } from "@modelviz/client";
import { type DeviceInfo, type LinkHealth, PROTOCOL_PATH, type ProjectInfo, type SignalInfo, type SourceState } from "@modelviz/protocol";
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
}

export const useSession = create<SessionState>(() => ({
  connection: client.state,
  connectionError: null,
  project: null,
  devices: [],
  signals: [],
  sources: {},
  health: {},
}));

async function loadProjectState(project: ProjectInfo | null): Promise<void> {
  signalStore.clear();
  if (!project) {
    useSession.setState({ project, devices: [], signals: [], sources: {}, health: {} });
    return;
  }
  const [devices, signals, sources] = await Promise.all([
    client.request("devices.list", {}),
    client.request("signals.list", {}),
    client.request("sources.list", {}),
  ]);
  useSession.setState({
    project,
    devices,
    signals,
    sources: Object.fromEntries(sources.map((s) => [s.device, s])),
    health: {},
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
client.connect();
