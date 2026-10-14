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
      # Simulated Device Parameters, as the firmware would expose them.
      parameters:
        RATE_KP: { value: 0.8, min: 0, max: 5 }
        RATE_KI: { value: 40, min: 0, max: 200 }
        GYRO_LPF_HZ: { value: 80, min: 5, max: 500 }
        CTRL_MODE: { value: 1, type: uint8, min: 0, max: 3 }
        FW_VERSION: { value: 10203, type: int32, readOnly: true }
      messages:
        DIALECT_INFO:
          rateHz: 1
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
        BENCH_ATTITUDE:
          rateHz: 50
          fields:
            roll: { kind: sine, freqHz: 0.2, amplitude: 0.5 }
            pitch: { kind: sine, freqHz: 0.3, amplitude: 0.3 }
            yaw: { kind: ramp, start: 0, step: 0.02 }
# Block Parameters a Push may write to Device Parameters. Values only move on a confirmed Push.
parameterMappings:
  - { system: systems/rate_loop.yaml, block: controller, parameter: Kp, device: bench, deviceParameter: RATE_KP }
  - { system: systems/rate_loop.yaml, block: controller, parameter: Ki, device: bench, deviceParameter: RATE_KI }
  - { system: systems/rate_loop.yaml, block: sensor, parameter: fc, device: bench, deviceParameter: GYRO_LPF_HZ }
`;

const VIRTUAL_BENCH_FILES: Record<string, string> = {
  "blocks/plant.yaml": `# Rate Plant: motor + airframe as a second-order system.
kind: transfer-function
domain: continuous
parameters:
  K: { default: 1, description: DC gain }
  wn: { default: 60, units: rad/s, description: Natural frequency }
  zeta: { default: 0.7, description: Damping ratio }
numerator: ["K*wn^2"]
denominator: [1, "2*zeta*wn", "wn^2"]
`,
  "blocks/pi.yaml": `# PI rate controller: Kp + Ki/s
kind: transfer-function
domain: continuous
parameters:
  Kp: { default: 0.8, min: 0, max: 5 }
  Ki: { default: 40, min: 0, max: 200 }
numerator: [Kp, Ki]
denominator: [1, 0]
`,
  "blocks/gyro-lpf.yaml": `# Gyro low-pass filter (first order)
kind: transfer-function
domain: continuous
parameters:
  fc: { default: 80, units: Hz, description: Cutoff frequency }
numerator: [1]
denominator: ["1/(2*pi*fc)", 1]
`,
  "systems/rate_loop.yaml": `# r → error = r − feedback → controller → plant → sensor → feedback
description: Rate loop created from the Loop Template
sampleRateHz: 1000
inputs: [r]
blocks:
  error: { kind: sum, signs: "+-" }
  controller: { block: blocks/pi.yaml }
  plant: { block: blocks/plant.yaml }
  sensor: { block: blocks/gyro-lpf.yaml }
connections:
  - { from: r, to: error.in1 }
  - { from: sensor.y, to: error.in2 }
  - { from: error.out, to: controller.u }
  - { from: controller.y, to: plant.u }
  - { from: plant.y, to: sensor.u }
outputs:
  y: plant.y
  u: controller.y
  e: error.out
  ym: sensor.y
`,
  "frame-formats/bench.yaml": `# Frame Format: how to talk to the bench Device.
framing: mavlink2
dialect: ../dialects/bench.xml
# The Device must report this dialect's hash before telemetry is accepted.
dialectCheck: { message: DIALECT_INFO, field: hash }
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
  BENCH_ATTITUDE:
    deviceTimestamp: { field: time_us, unit: us }
    nominalRateHz: 50
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
    <!-- Device Parameter protocol, as defined in MAVLink common.xml. -->
    <message id="20" name="PARAM_REQUEST_READ">
      <description>Request to read the onboard parameter with param_id or param_index.</description>
      <field type="uint8_t" name="target_system">System ID.</field>
      <field type="uint8_t" name="target_component">Component ID.</field>
      <field type="char[16]" name="param_id">Onboard parameter id.</field>
      <field type="int16_t" name="param_index">Parameter index, or -1 to use param_id.</field>
    </message>
    <message id="21" name="PARAM_REQUEST_LIST">
      <description>Request all parameters of this component.</description>
      <field type="uint8_t" name="target_system">System ID.</field>
      <field type="uint8_t" name="target_component">Component ID.</field>
    </message>
    <message id="22" name="PARAM_VALUE">
      <description>The current value of an onboard parameter.</description>
      <field type="char[16]" name="param_id">Onboard parameter id.</field>
      <field type="float" name="param_value">Onboard parameter value.</field>
      <field type="uint8_t" name="param_type">MAV_PARAM_TYPE of the parameter.</field>
      <field type="uint16_t" name="param_count">Total number of onboard parameters.</field>
      <field type="uint16_t" name="param_index">Index of this onboard parameter.</field>
    </message>
    <message id="23" name="PARAM_SET">
      <description>Set a parameter value; the Device answers with PARAM_VALUE.</description>
      <field type="uint8_t" name="target_system">System ID.</field>
      <field type="uint8_t" name="target_component">Component ID.</field>
      <field type="char[16]" name="param_id">Onboard parameter id.</field>
      <field type="float" name="param_value">Onboard parameter value.</field>
      <field type="uint8_t" name="param_type">MAV_PARAM_TYPE of the parameter.</field>
    </message>
    <message id="42002" name="DIALECT_INFO">
      <description>Fingerprint of the dialect the firmware was built with.</description>
      <field type="uint32_t" name="hash">Dialect hash.</field>
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
    <message id="42003" name="BENCH_ATTITUDE">
      <description>Attitude estimation from the AHRS.</description>
      <field type="uint64_t" name="time_us" units="us">Device time since boot.</field>
      <field type="float[4]" name="q">Attitude quaternion (w, x, y, z).</field>
      <field type="float" name="roll" units="rad">Roll angle.</field>
      <field type="float" name="pitch" units="rad">Pitch angle.</field>
      <field type="float" name="yaw" units="rad">Yaw angle.</field>
    </message>
  </messages>
</mavlink>
`,
};

