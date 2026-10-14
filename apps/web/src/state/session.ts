import { type ConnectionState, ModelVizClient } from "@modelviz/client";
import { PROTOCOL_PATH, type ProjectInfo } from "@modelviz/protocol";
import { create } from "zustand";

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${PROTOCOL_PATH}`;

/** The single client connection shared by the whole UI. */
export const client = new ModelVizClient(wsUrl);

interface SessionState {
  connection: ConnectionState;
  connectionError: string | null;
  project: ProjectInfo | null;
}

export const useSession = create<SessionState>(() => ({
  connection: client.state,
  connectionError: null,
  project: null,
}));

client.onState((connection) => {
  useSession.setState({ connection, connectionError: client.lastError?.message ?? null });
  if (connection === "connected") {
    client.request("project.current", {}).then(
      (project) => useSession.setState({ project }),
      () => {},
    );
  }
});
client.on("project.changed", (project) => useSession.setState({ project }));
client.connect();
