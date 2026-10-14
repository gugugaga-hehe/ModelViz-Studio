import type { SignalInfo } from "@modelviz/protocol";
import { Rotate3d } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { signalStore } from "../../state/session";
import { useRetained } from "../TimePlotPanel";
import { SignalSelect, useSignalsById } from "./SignalPicker";
import { Select } from "../ui/controls";

export type AttitudeMode = "quaternion" | "euler";

export interface AttitudeSettings {
  mode: AttitudeMode;
  qw: string;
  qx: string;
  qy: string;
  qz: string;
  roll: string;
  pitch: string;
  yaw: string;
  unit: "rad" | "deg";
}

export const ATTITUDE_DEFAULTS: AttitudeSettings = {
  mode: "quaternion",
  qw: "",
  qx: "",
  qy: "",
  qz: "",
  roll: "",
  pitch: "",
  yaw: "",
  unit: "rad",
};

/** Attitude 3D Panel: renders orientation from quaternion or Euler Signals on a spherical reference frame. */
export function AttitudePanel({
  n,
  settings,
  onChange,
}: {
  n: number;
  settings: AttitudeSettings;
  onChange: (patch: Partial<AttitudeSettings>) => void;
}) {
  const { t } = useTranslation();
  const title = t("panels.attitudeTitle", { n });

  const activeIds =
    settings.mode === "quaternion"
      ? [settings.qw, settings.qx, settings.qy, settings.qz].filter(Boolean)
      : [settings.roll, settings.pitch, settings.yaw].filter(Boolean);

  const retainedSignals = useSignalsById(activeIds);
  useRetained(retainedSignals);

  const qwSig = useSignalsById(settings.qw ? [settings.qw] : [])[0];
  const qxSig = useSignalsById(settings.qx ? [settings.qx] : [])[0];
  const qySig = useSignalsById(settings.qy ? [settings.qy] : [])[0];
  const qzSig = useSignalsById(settings.qz ? [settings.qz] : [])[0];

  const rollSig = useSignalsById(settings.roll ? [settings.roll] : [])[0];
  const pitchSig = useSignalsById(settings.pitch ? [settings.pitch] : [])[0];
  const yawSig = useSignalsById(settings.yaw ? [settings.yaw] : [])[0];

  const hasConfig =
    settings.mode === "quaternion"
      ? Boolean(settings.qw || settings.qx || settings.qy || settings.qz)
      : Boolean(settings.roll || settings.pitch || settings.yaw);

  const labelCls = "flex flex-col gap-1 text-xs text-muted";

  return (
    <section aria-label={title} data-testid={`attitude-panel-${n - 1}`} className="@container h-full min-h-0 bg-surface p-3">
      <div className="flex h-full min-h-0 flex-col gap-3 @[36rem]:flex-row">
        <div className="flex max-h-48 shrink-0 flex-col gap-2 overflow-auto @[36rem]:max-h-none @[36rem]:w-64">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
          </div>

          <label className={labelCls}>
            {t("panels.attitude.mode")}
            <Select
              aria-label={t("panels.attitude.mode")}
              size="md"
              value={settings.mode}
              onChange={(e) => onChange({ mode: e.target.value as AttitudeMode })}
            >
              <option value="quaternion">{t("panels.attitude.quaternion")}</option>
              <option value="euler">{t("panels.attitude.euler")}</option>
            </Select>
          </label>

          {settings.mode === "quaternion" ? (
            <>
              <SignalSelect label={t("panels.attitude.qw")} value={settings.qw} onChange={(qw) => onChange({ qw })} />
              <SignalSelect label={t("panels.attitude.qx")} value={settings.qx} onChange={(qx) => onChange({ qx })} />
              <SignalSelect label={t("panels.attitude.qy")} value={settings.qy} onChange={(qy) => onChange({ qy })} />
              <SignalSelect label={t("panels.attitude.qz")} value={settings.qz} onChange={(qz) => onChange({ qz })} />
            </>
          ) : (
            <>
              <SignalSelect label={t("panels.attitude.roll")} value={settings.roll} onChange={(roll) => onChange({ roll })} />
              <SignalSelect label={t("panels.attitude.pitch")} value={settings.pitch} onChange={(pitch) => onChange({ pitch })} />
              <SignalSelect label={t("panels.attitude.yaw")} value={settings.yaw} onChange={(yaw) => onChange({ yaw })} />
              <label className={labelCls}>
                {t("panels.attitude.unit")}
                <Select
                  aria-label={t("panels.attitude.unit")}
                  size="md"
                  value={settings.unit}
                  onChange={(e) => onChange({ unit: e.target.value as "rad" | "deg" })}
                >
                  <option value="rad">{t("panels.attitude.radians")}</option>
                  <option value="deg">{t("panels.attitude.degrees")}</option>
                </Select>
              </label>
            </>
          )}
        </div>

        {hasConfig ? (
          <AttitudeCanvas
            mode={settings.mode}
            unit={settings.unit}
            qw={qwSig}
            qx={qxSig}
            qy={qySig}
            qz={qzSig}
            roll={rollSig}
            pitch={pitchSig}
            yaw={yawSig}
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-center justify-center text-sm text-muted">
            {t("panels.attitude.pickSignals")}
          </div>
        )}
      </div>
    </section>
  );
}

function AttitudeCanvas({
  mode,
  unit,
  qw,
  qx,
  qy,
  qz,
  roll,
  pitch,
  yaw,
}: {
  mode: AttitudeMode;
  unit: "rad" | "deg";
  qw?: SignalInfo;
  qx?: SignalInfo;
  qy?: SignalInfo;
  qz?: SignalInfo;
  roll?: SignalInfo;
  pitch?: SignalInfo;
  yaw?: SignalInfo;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [state, setState] = useState({
    roll: 0,
    pitch: 0,
    yaw: 0,
    qw: 1,
    qx: 0,
    qy: 0,
    qz: 0,
    updates: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50);
    camera.position.set(2.4, 1.8, 2.4);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Ambient and directional lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    // Spherical reference frame
    const sphereGeo = new THREE.SphereGeometry(1.4, 24, 16);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.15,
    });
    scene.add(new THREE.Mesh(sphereGeo, sphereMat));

    // Equator ring (horizon reference in XZ plane)
    const equatorPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const th = (i / 64) * Math.PI * 2;
      equatorPts.push(new THREE.Vector3(1.4 * Math.cos(th), 0, 1.4 * Math.sin(th)));
    }
    const equatorGeo = new THREE.BufferGeometry().setFromPoints(equatorPts);
    const equatorMat = new THREE.LineBasicMaterial({ color: 0x0284c7, transparent: true, opacity: 0.5 });
    scene.add(new THREE.Line(equatorGeo, equatorMat));

    // Reference axes helper (Inertial frame)
    scene.add(new THREE.AxesHelper(1.6));

    // Body group: vehicle and body-fixed coordinate axes that rotate with attitude
    const bodyGroup = new THREE.Group();
    bodyGroup.add(new THREE.AxesHelper(0.9));

    // Stylized aircraft body pointing +X
    const fuselageGeo = new THREE.CylinderGeometry(0.06, 0.1, 0.8, 16);
    fuselageGeo.rotateZ(-Math.PI / 2);
    const fuselageMat = new THREE.MeshStandardMaterial({ color: 0x6366f1, roughness: 0.3, metalness: 0.2 });
    bodyGroup.add(new THREE.Mesh(fuselageGeo, fuselageMat));

    const noseGeo = new THREE.ConeGeometry(0.1, 0.25, 16);
    noseGeo.rotateZ(-Math.PI / 2);
    noseGeo.translate(0.52, 0, 0);
    const noseMat = new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.3 });
    bodyGroup.add(new THREE.Mesh(noseGeo, noseMat));

    const wingGeo = new THREE.BoxGeometry(0.2, 0.02, 1.0);
    const wingMat = new THREE.MeshStandardMaterial({ color: 0x4f46e5, roughness: 0.3 });
    bodyGroup.add(new THREE.Mesh(wingGeo, wingMat));

    const tailGeo = new THREE.BoxGeometry(0.18, 0.22, 0.02);
    tailGeo.translate(-0.32, 0.11, 0);
    bodyGroup.add(new THREE.Mesh(tailGeo, wingMat));

    scene.add(bodyGroup);

    let raf = 0;
    let updates = 0;
    const tempEuler = new THREE.Euler(0, 0, 0, "ZYX");
    const tempQuat = new THREE.Quaternion(0, 0, 0, 1);

    const frame = () => {
      raf = requestAnimationFrame(frame);

      // Handle resize
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width > 0 && height > 0) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
          renderer.setPixelRatio(dpr);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        }
      }

      controls.update();

      // Read newest samples at display rate
      let curRoll = 0;
      let curPitch = 0;
      let curYaw = 0;
      let curQw = 1;
      let curQx = 0;
      let curQy = 0;
      let curQz = 0;

      if (mode === "quaternion") {
        const wVal = qw ? (signalStore.buffer(qw.handle).latestValue() ?? 1) : 1;
        const xVal = qx ? (signalStore.buffer(qx.handle).latestValue() ?? 0) : 0;
        const yVal = qy ? (signalStore.buffer(qy.handle).latestValue() ?? 0) : 0;
        const zVal = qz ? (signalStore.buffer(qz.handle).latestValue() ?? 0) : 0;

        // Normalise quaternion
        const len = Math.hypot(wVal, xVal, yVal, zVal);
        if (len > 1e-6) {
          curQw = wVal / len;
          curQx = xVal / len;
          curQy = yVal / len;
          curQz = zVal / len;
        } else {
          curQw = 1;
          curQx = 0;
          curQy = 0;
          curQz = 0;
        }

        bodyGroup.quaternion.set(curQx, curQy, curQz, curQw);
        tempEuler.setFromQuaternion(bodyGroup.quaternion, "ZYX");
        curRoll = tempEuler.x;
        curPitch = tempEuler.y;
        curYaw = tempEuler.z;
      } else {
        const rVal = roll ? (signalStore.buffer(roll.handle).latestValue() ?? 0) : 0;
        const pVal = pitch ? (signalStore.buffer(pitch.handle).latestValue() ?? 0) : 0;
        const yVal = yaw ? (signalStore.buffer(yaw.handle).latestValue() ?? 0) : 0;

        const factor = unit === "deg" ? Math.PI / 180 : 1;
        curRoll = rVal * factor;
        curPitch = pVal * factor;
        curYaw = yVal * factor;

        bodyGroup.rotation.set(curRoll, curPitch, curYaw, "ZYX");
        tempQuat.setFromEuler(bodyGroup.rotation);
        curQw = tempQuat.w;
        curQx = tempQuat.x;
        curQy = tempQuat.y;
        curQz = tempQuat.z;
      }

      updates++;
      setState({
        roll: curRoll,
        pitch: curPitch,
        yaw: curYaw,
        qw: curQw,
        qx: curQx,
        qy: curQy,
        qz: curQz,
        updates,
      });

      renderer.render(scene, camera);
    };

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      controls.dispose();
      renderer.dispose();
      sphereGeo.dispose();
      sphereMat.dispose();
      equatorGeo.dispose();
      equatorMat.dispose();
      fuselageGeo.dispose();
      fuselageMat.dispose();
      noseGeo.dispose();
      noseMat.dispose();
      wingGeo.dispose();
      wingMat.dispose();
      tailGeo.dispose();
    };
  }, [mode, unit, qw, qx, qy, qz, roll, pitch, yaw]);

  const deg = (rad: number) => ((rad * 180) / Math.PI).toFixed(1);

  return (
    <div
      ref={containerRef}
      data-testid="attitude-view"
      data-mode={mode}
      data-roll={state.roll.toFixed(4)}
      data-pitch={state.pitch.toFixed(4)}
      data-yaw={state.yaw.toFixed(4)}
      data-qw={state.qw.toFixed(4)}
      data-qx={state.qx.toFixed(4)}
      data-qy={state.qy.toFixed(4)}
      data-qz={state.qz.toFixed(4)}
      data-quaternion={`${state.qw.toFixed(4)},${state.qx.toFixed(4)},${state.qy.toFixed(4)},${state.qz.toFixed(4)}`}
      data-rendered="true"
      data-updates={state.updates}
      className="relative min-h-48 min-w-0 flex-1 overflow-hidden rounded border border-border/50 bg-background/50"
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full outline-none" />

      {/* Floating readout overlay */}
      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-2 rounded bg-surface/80 px-2 py-1 text-[11px] font-mono text-muted backdrop-blur">
        <span>R: {deg(state.roll)}°</span>
        <span>P: {deg(state.pitch)}°</span>
        <span>Y: {deg(state.yaw)}°</span>
      </div>
    </div>
  );
}
