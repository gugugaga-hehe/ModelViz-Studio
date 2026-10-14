import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { client, refreshModels, useSession } from "../../state/session";
import { Button, Input, Select } from "../ui/controls";

export function LoopTemplateForm({ onCreated }: { onCreated: (path: string) => void }) {
  const { t } = useTranslation();
  const all = useSession((s) => s.blocks);
  // Only single-input single-output Blocks can fill a loop slot.
  const blocks = useMemo(() => all.filter((b) => !b.error && b.inputs.length === 1 && b.outputs.length === 1), [all]);
  const [name, setName] = useState("loop");
  const [rate, setRate] = useState("1000");
  const [controller, setController] = useState("");
  const [plant, setPlant] = useState("");
  const [sensor, setSensor] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const info = await client.request("system.fromLoopTemplate", {
        name,
        sampleRateHz: Number(rate),
        controller: controller || blocks[0]!.path,
        plant: plant || blocks[0]!.path,
        ...(sensor ? { sensor } : {}),
      });
      await refreshModels();
      onCreated(info.path);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const options = blocks.map((b) => (
    <option key={b.path} value={b.path}>
      {b.path}
    </option>
  ));
  return (
    <form onSubmit={submit} aria-label={t("loop.title")} className="flex flex-col gap-2 rounded border border-border p-2 text-xs">
      <p className="text-muted">{t("loop.diagram")}</p>
      <div className="flex gap-1">
        <label className="flex flex-[2] flex-col gap-1">
          {t("loop.name")}
          <Input className="w-full" value={name} onChange={(e) => setName(e.target.value)} required pattern="[A-Za-z][A-Za-z0-9_-]*" patternHint={t("form.identifier")} />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          {t("loop.rate")}
          <Input className="w-full" value={rate} onChange={(e) => setRate(e.target.value)} inputMode="numeric" required />
        </label>
      </div>
      {(
        [
          ["controller", controller, setController, false],
          ["plant", plant, setPlant, false],
          ["sensor", sensor, setSensor, true],
        ] as const
      ).map(([role, value, set, optional]) => (
        <label key={role} className="flex flex-col gap-1">
          {t(`loop.${role}`)}
          <Select aria-label={t(`loop.${role}`)} className="w-full" value={value} onChange={(e) => set(e.target.value)}>
            {optional ? <option value="">{t("loop.none")}</option> : null}
            {options}
          </Select>
        </label>
      ))}
      <Button type="submit" disabled={!blocks.length} variant="primary">
        {t("loop.create")}
      </Button>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
