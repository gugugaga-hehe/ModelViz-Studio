import {
  type DockviewApi,
  DockviewReact,
  type DockviewTheme,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
  type SerializedDockview,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { LAYOUT_VERSION } from "@modelviz/protocol";
import { AudioLines, ChartLine, ChartScatter, RotateCcw, Rotate3d, Table, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { client, useSession } from "../state/session";
import { type AttitudeSettings, ATTITUDE_DEFAULTS, AttitudePanel } from "./panels/AttitudePanel";
import { type SpectrumSettings, SpectrumPanel } from "./panels/SpectrumPanel";
import { TablePanel } from "./panels/TablePanel";
import { XyPlotPanel } from "./panels/XyPlotPanel";
import { TimePlotPanel } from "./TimePlotPanel";

/** Panel kinds the workspace can hold; the key is the dockview component id saved in the layout. */
type Kind = "time" | "xy" | "table" | "fft" | "attitude";
type PanelParams = { n: number; signals?: string[]; x?: string; y?: string } & Partial<SpectrumSettings> & Partial<AttitudeSettings>;

const TITLE_KEY: Record<Kind, string> = {
  time: "plot.title",
  xy: "panels.xyTitle",
  table: "panels.tableTitle",
  fft: "panels.fftTitle",
  attitude: "panels.attitudeTitle",
};

const SPECTRUM_DEFAULTS: SpectrumSettings = { signal: "", window: "hann", length: 4096, scale: "amplitude", db: false };
/** Wait this long after the last change before writing layout.yaml. */
const SAVE_DELAY_MS = 400;

const theme: DockviewTheme = { name: "modelviz", className: "dockview-theme-modelviz" };

/**
 * Upgrades a saved `dock` from layout version `v` to `v + 1`. Add an entry here whenever a change
 * to Panels or dockview alters the saved shape, and bump LAYOUT_VERSION.
 */
const MIGRATIONS: Record<number, (dock: Record<string, unknown>) => Record<string, unknown>> = {};

function migrate(version: number, dock: Record<string, unknown>): Record<string, unknown> {
  for (let v = version; v < LAYOUT_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`no migration from layout version ${v}`);
    dock = step(dock);
  }
  return dock;
}

/** Panels report selection changes here so the layout is saved (dockview does not report parameter edits). */
const paramsChanged = new EventTarget();

function useParams(props: IDockviewPanelProps<PanelParams>) {
  return (patch: Partial<PanelParams>) => {
    props.api.updateParameters({ ...props.params, ...patch });
    paramsChanged.dispatchEvent(new Event("change"));
  };
}

const components: Record<Kind, React.FunctionComponent<IDockviewPanelProps<PanelParams>>> = {
  time: (props) => {
    const set = useParams(props);
    return <TimePlotPanel n={props.params.n} selected={props.params.signals ?? []} onChange={(signals) => set({ signals })} />;
  },
  xy: (props) => {
    const set = useParams(props);
    return <XyPlotPanel n={props.params.n} x={props.params.x ?? ""} y={props.params.y ?? ""} onChange={set} />;
  },
  table: (props) => {
    const set = useParams(props);
    return <TablePanel n={props.params.n} selected={props.params.signals ?? []} onChange={(signals) => set({ signals })} />;
  },
  fft: (props) => {
    const set = useParams(props);
    const { n, signal, window, length, scale, db } = { ...SPECTRUM_DEFAULTS, ...props.params };
    return <SpectrumPanel n={n} settings={{ signal, window, length, scale, db }} onChange={set} />;
  },
  attitude: (props) => {
    const set = useParams(props);
    const { n, mode, qw, qx, qy, qz, roll, pitch, yaw, unit } = { ...ATTITUDE_DEFAULTS, ...props.params };
    return <AttitudePanel n={n} settings={{ mode, qw, qx, qy, qz, roll, pitch, yaw, unit }} onChange={set} />;
  },
};


function Watermark(_: IWatermarkPanelProps) {
  const { t } = useTranslation();
  return <div className="flex h-full items-center justify-center text-sm text-muted">{t("panels.empty")}</div>;
}

function title(kind: Kind, n: number): string {
  return i18n.t(TITLE_KEY[kind], { n });
}

/** Adds a Panel: time plots stack below the last one, other Panels open to the right. */
function addPanel(api: DockviewApi, kind: Kind): void {
  const same = api.panels.filter((p) => p.api.component === kind);
  const n = Math.max(0, ...same.map((p) => (p.params as PanelParams | undefined)?.n ?? 0)) + 1;
  const reference = kind === "time" ? same.at(-1) : (api.activePanel ?? api.panels.at(-1));
  api.addPanel({
    id: `${kind}-${n}`,
    component: kind,
    title: title(kind, n),
    params: {
      n,
      ...(kind === "xy"
        ? { x: "", y: "" }
        : kind === "fft"
          ? SPECTRUM_DEFAULTS
          : kind === "attitude"
            ? ATTITUDE_DEFAULTS
            : { signals: [] }),
    },
    ...(reference ? { position: { referencePanel: reference.id, direction: kind === "time" ? "below" : "right" } } : {}),
  });
}

function retitle(api: DockviewApi): void {
  for (const p of api.panels) {
    const kind = p.api.component as Kind;
    if (kind in TITLE_KEY) p.api.setTitle(title(kind, (p.params as PanelParams).n));
  }
}

/** The dockable Panel area of the Telemetry view; its layout is saved in the Project. */
export function Workspace() {
  const { t } = useTranslation();
  const project = useSession((s) => s.project);
  const [api, setApi] = useState<DockviewApi | null>(null);
  const restoring = useRef(true);
  /** Set while the Project's layout file could not be restored: nothing is saved over it. */
  const [problem, setProblem] = useState<string | null>(null);
  const blocked = useRef(false);
  const [backup, setBackup] = useState<string | null>(null);
  const [saves, setSaves] = useState(0);

  // restore the Project's layout (or start with one time plot)
  useEffect(() => {
    if (!api || !project) return;
    let cancelled = false;
    restoring.current = true;
    setBackup(null);
    void (async () => {
      let failure: string | null = null;
      const saved = await client.request("layout.get", {}).catch((e: Error) => {
        failure = e.message;
        return null;
      });
      if (cancelled) return;
      api.clear();
      if (saved?.status === "unreadable") failure = saved.reason;
      else if (saved?.status === "ok") {
        try {
          api.fromJSON(migrate(saved.layout.version, saved.layout.dock) as unknown as SerializedDockview);
        } catch (e) {
          api.clear();
          failure = (e as Error).message;
        }
      }
      blocked.current = failure !== null;
      setProblem(failure);
      if (api.totalPanels === 0) addPanel(api, "time");
      retitle(api);
      // let dockview settle before treating changes as the user's
      setTimeout(() => {
        if (!cancelled) restoring.current = false;
      }, 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, project?.path]);

  // save on any change, debounced, to the Project that was open when the change happened
  useEffect(() => {
    if (!api || !project) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const path = project.path;
    const save = () => {
      timer = undefined;
      // layout.set writes to the server's open Project: never save into a Project switched to since
      if (useSession.getState().project?.path !== path) return;
      // keep an unreadable layout file until the user chooses to reset it
      if (blocked.current) return;
      let dock: Record<string, unknown>;
      try {
        dock = api.toJSON() as unknown as Record<string, unknown>;
      } catch {
        return; // dockview already torn down
      }
      client.request("layout.set", { layout: { version: LAYOUT_VERSION, dock } }).then(() => setSaves((n) => n + 1), () => {});
    };
    const schedule = () => {
      if (restoring.current) return;
      clearTimeout(timer);
      timer = setTimeout(save, SAVE_DELAY_MS);
    };
    // Leaving the view (e.g. to Model Lab) or the page must not lose the last change. dockview
    // reports changes asynchronously, so one may not even be scheduled yet: always save then.
    const flush = () => {
      clearTimeout(timer);
      if (!restoring.current) save();
    };
    const layout = api.onDidLayoutChange(schedule);
    paramsChanged.addEventListener("change", schedule);
    window.addEventListener("pagehide", flush);
    return () => {
      layout.dispose();
      paramsChanged.removeEventListener("change", schedule);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [api, project?.path]);

  // tab titles follow the UI language
  useEffect(() => {
    if (!api) return;
    const update = () => retitle(api);
    i18n.on("languageChanged", update);
    return () => i18n.off("languageChanged", update);
  }, [api]);

  /** Backs up the unreadable layout file, then saves the Panels shown now in its place. */
  const resetLayout = async () => {
    if (!api) return;
    const { backup } = await client.request("layout.reset", {});
    blocked.current = false;
    setProblem(null);
    setBackup(backup);
    await client.request("layout.set", { layout: { version: LAYOUT_VERSION, dock: api.toJSON() as unknown as Record<string, unknown> } });
    setSaves((n) => n + 1);
  };

  const btn = "inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted hover:border-accent hover:text-fg";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2" data-testid="workspace" data-layout-saves={saves}>
      {problem !== null && (
        <div role="alert" data-testid="layout-problem" className="flex flex-wrap items-center gap-2 rounded border border-warn px-3 py-2 text-xs">
          <TriangleAlert size={14} className="shrink-0 text-warn" />
          <span className="min-w-0 flex-1">
            {t("layout.unreadable")} <span className="text-muted">{problem}</span>
          </span>
          <button className={btn} onClick={() => void resetLayout().catch((e: Error) => setProblem(e.message))}>
            <RotateCcw size={14} />
            {t("layout.reset")}
          </button>
        </div>
      )}
      {backup !== null && (
        <p data-testid="layout-backup" className="text-xs text-muted">
          {t("layout.backedUp", { file: backup })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button className={btn} onClick={() => api && addPanel(api, "time")}>
          <ChartLine size={14} />
          {t("plot.add")}
        </button>
        <button className={btn} onClick={() => api && addPanel(api, "xy")}>
          <ChartScatter size={14} />
          {t("panels.addXy")}
        </button>
        <button className={btn} onClick={() => api && addPanel(api, "table")}>
          <Table size={14} />
          {t("panels.addTable")}
        </button>
        <button className={btn} onClick={() => api && addPanel(api, "fft")}>
          <AudioLines size={14} />
          {t("panels.addFft")}
        </button>
        <button className={btn} onClick={() => api && addPanel(api, "attitude")}>
          <Rotate3d size={14} />
          {t("panels.addAttitude")}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
        <DockviewReact className="h-full" theme={theme} components={components} watermarkComponent={Watermark} onReady={(e) => setApi(e.api)} />
      </div>
    </div>
  );
}

