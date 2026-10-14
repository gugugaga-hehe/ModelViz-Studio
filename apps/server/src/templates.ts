import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProjectTemplate } from "@modelviz/protocol";

/** Extra files written by a Project template, relative to the Project folder. */
export function templateFiles(template: ProjectTemplate): { manifestExtra: string; files: Record<string, string> } {
  switch (template) {
    case "empty":
      return { manifestExtra: "devices: []\n", files: {} };
    case "virtual-bench":
      return { manifestExtra: VIRTUAL_BENCH_DEVICES, files: VIRTUAL_BENCH_FILES };
  }
}

export async function writeTemplate(projectPath: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(projectPath, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

const VIRTUAL_BENCH_DEVICES = `devices:
  - id: bench
    frameFormat: frame-formats/bench.yaml
    # Behaviour when this Device is run as a Virtual Device.
    virtual:
      messages:
        HEARTBEAT:
          rateHz: 1
          fields:
            type: { kind: constant, value: 2 }
            mavlink_version: { kind: constant, value: 3 }
        BENCH_STATE:
          rateHz: 500
          fields:
            setpoint: { kind: sine, freqHz: 0.5, amplitude: 1 }
            gyro_x: { kind: sine, freqHz: 2, amplitude: 0.8 }
            gyro_y: { kind: sine, freqHz: 3, amplitude: 0.5 }
            gyro_z: { kind: sine, freqHz: 5, amplitude: 0.3 }
            mode: { kind: constant, value: 1 }
        BENCH_IMU_BATCH:
          rateHz: 125
          fields:
            gyro_x: { kind: sine, freqHz: 7, amplitude: 1 }
            gyro_y: { kind: sine, freqHz: 11, amplitude: 0.5 }
            gyro_z: { kind: sine, freqHz: 13, amplitude: 0.25 }
`;

const VIRTUAL_BENCH_FILES: Record<string, string> = {
  "frame-formats/bench.yaml": `# Frame Format: how to talk to the bench Device.
framing: mavlink2
dialect: ../dialects/bench.xml
messages:
  HEARTBEAT:
    nominalRateHz: 1
  BENCH_STATE:
    deviceTimestamp: { field: time_us, unit: us }
    nominalRateHz: 500
  # 8 gyro samples per frame at 1 kHz; element 0 is at time_us.
  BENCH_IMU_BATCH:
    deviceTimestamp: { field: time_us, unit: us }
    nominalRateHz: 125
    batch:
      fields: [gyro_x, gyro_y, gyro_z]
      sampleRateHz: 1000
`,
  "dialects/bench.xml": `<?xml version="1.0"?>
<!-- Example dialect for a bench Device. Replace with your firmware's dialect. -->
<mavlink>
  <version>3</version>
  <messages>
    <message id="0" name="HEARTBEAT">
      <description>Presence and identity of a Device.</description>
      <field type="uint8_t" name="type">Vehicle or component type.</field>
      <field type="uint8_t" name="autopilot">Autopilot type.</field>
      <field type="uint8_t" name="base_mode">System mode bitmap.</field>
      <field type="uint32_t" name="custom_mode">Firmware-specific mode.</field>
      <field type="uint8_t" name="system_status">System status flag.</field>
      <field type="uint8_t_mavlink_version" name="mavlink_version">MAVLink version.</field>
    </message>
    <message id="42000" name="BENCH_STATE">
      <description>Control loop state of the bench Device.</description>
      <field type="uint64_t" name="time_us" units="us">Device time since boot.</field>
      <field type="float" name="setpoint" units="rad/s">Rate setpoint.</field>
      <field type="float" name="gyro_x" units="rad/s">Gyro X.</field>
      <field type="float" name="gyro_y" units="rad/s">Gyro Y.</field>
      <field type="float" name="gyro_z" units="rad/s">Gyro Z.</field>
      <field type="uint8_t" name="mode">Controller mode.</field>
    </message>
    <message id="42001" name="BENCH_IMU_BATCH">
      <description>High-rate gyro samples, batched 8 per frame.</description>
      <field type="uint64_t" name="time_us" units="us">Device time of the first sample.</field>
      <field type="float[8]" name="gyro_x" units="rad/s">Gyro X samples.</field>
      <field type="float[8]" name="gyro_y" units="rad/s">Gyro Y samples.</field>
      <field type="float[8]" name="gyro_z" units="rad/s">Gyro Z samples.</field>
    </message>
  </messages>
</mavlink>
`,
};
