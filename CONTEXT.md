# ModelViz Studio

A debugging and analysis workbench for embedded control firmware: it talks to a Device over a byte stream, decodes telemetry, and lets users visualise and analyse mathematical models (filters, controllers, plants, formulas) in time and frequency domains, with or without hardware attached.

## Language

### Workspace

**Project**:
A folder on disk holding everything a piece of work needs — Frame Formats, Blocks, Systems and Recordings — as diffable files. It is the unit users version, share and reopen.
_Avoid_: workspace, session, file

**Panel**:
One visualisation or tool on screen — a time plot, an attitude view, a table, a spectrum or an Analysis result. Panels are arranged in a dockable layout saved in the Project.
_Avoid_: widget, view, window, card

### Devices and data

**Device**:
An embedded target running the user's own firmware that ModelViz Studio exchanges bytes with. A Project may involve several Devices, each with its own Frame Format; Signal names are qualified by their Device.
_Avoid_: board, FC, target, MCU

**Frame Format**:
The complete description of how to talk to a Device: a Framing plus the Messages carried inside it. It is the only thing that ties ModelViz Studio to a particular firmware.
_Avoid_: protocol definition, packet spec, parser config

**Framing**:
The rule that splits a byte stream into individual frames and validates them — either MAVLink2 or a user-authored custom framing.
_Avoid_: protocol, packetizer, envelope

**Message**:
One kind of frame defined in a Frame Format, made up of Fields. For MAVLink2 Framing, Messages come from the Device's dialect definition.
_Avoid_: packet, frame type, record

**Command**:
A Message sent from ModelViz Studio to a Device asking it to do something (for example, start injecting a Stimulus), which the Device acknowledges.
_Avoid_: request, instruction, RPC

**Transport**:
The carrier of a Device's byte stream: a serial port, a TCP connection or a UDP socket. Transports know nothing about Framing.
_Avoid_: port (reserved for Blocks), link, channel, connection (reserved for Systems)

**Source**:
Anything that produces telemetry for the workbench: a live Device connection, a Log Replay, or a Virtual Device. All Sources are treated identically downstream.
_Avoid_: input, data provider, connection

**Recording**:
A captured byte stream from a Device together with the time each byte chunk arrived. Signals are always re-derivable from it by decoding with a Frame Format.
_Avoid_: log, capture, dump

**Log Replay**:
A Source that re-emits a Recording, or imported external telemetry, with its original timing.
_Avoid_: playback, offline mode

**Virtual Device**:
A Source that simulates a Device so the workbench can be used and tested without hardware.
_Avoid_: mock device, simulator, fake FC

**Device Parameter**:
A named, writable setting stored in the Device's firmware (e.g. a gain or a cutoff frequency). With MAVLink2 Framing the Device enumerates its own Device Parameters; with custom Framing they are declared in the Frame Format.
_Avoid_: setting, config value, register

**Field**:
One named value inside a Message, decoded from a fixed part of each frame of that Message.
_Avoid_: channel, column, variable

**Signal**:
A named sequence of timestamped values, produced either by a Field over time or by a Block output.
_Avoid_: channel, dataset, topic, series, trace

**Device Timestamp**:
A time value sent by the Device inside each frame, declared as a Field in the Frame Format. When present, it is the authoritative time base for that frame's Signals.
_Avoid_: tick, sample time

**Host Timestamp**:
The time the local server received a frame. Always recorded; used as the time base only when no Device Timestamp exists.
_Avoid_: arrival time, PC time

**Nominal Sample Rate**:
The rate at which a Frame Format declares frames should arrive, used to detect dropped frames and timing jitter.
_Avoid_: frequency, baud

**Parameter Mapping**:
A user-declared correspondence between a Block Parameter and a Device Parameter.
_Avoid_: binding, link, sync

**Push**:
Writing Block Parameter values to their mapped Device Parameters after the user reviews the differences. Never automatic.
_Avoid_: sync, upload, flash

**Recording**:
A captured Device byte stream together with the host time each chunk arrived. Signals are derived from a Recording by decoding it with a Frame Format, so a Recording can be re-decoded after its Frame Format changes.
_Avoid_: log, capture, dump, session

**Device Timestamp**:
A time value the Device itself puts in each frame, declared as a Field in the Frame Format. When present it is the authoritative time for Signals; the host arrival time is kept alongside it.
_Avoid_: tick, frame time

**Host Timestamp**:
The time at which the local server received a chunk of bytes; used for Signals only when the Frame Format declares no Device Timestamp.
_Avoid_: receive time, PC time

**Nominal Rate**:
The frame rate a Frame Format declares the Device should produce, used to detect dropped frames and timing jumps.
_Avoid_: sample rate (that belongs to Blocks), frequency

**Parameter Mapping**:
A user-declared pairing between a Block Parameter and a Device Parameter, stored in the Project.
_Avoid_: binding, link, sync

**Push**:
Writing mapped Block Parameter values to their Device Parameters after the user has reviewed the differences. Values never flow between Blocks and the Device without a Push.
_Avoid_: sync, upload, flash, apply

### Models

**Block**:
A single dynamic element with inputs, outputs, Block Parameters and a sample rate — a filter, a controller, a Plant or a formula. Blocks can be continuous-time or discrete-time.
_Avoid_: model, component, module, node

**Plant**:
A Block that represents the physical system being controlled.
_Avoid_: model, process, dynamics

**Block Parameter**:
A named value that configures a Block's behaviour. It lives in the workbench, not on the Device, even when it mirrors a Device Parameter.
_Avoid_: coefficient, setting

**Discretization**:
Converting a continuous-time Block into a discrete-time one at a given sample rate using a named method (e.g. Tustin, ZOH).
_Avoid_: digitization, sampling

**System**:
A graph of Blocks whose Ports are joined by Connections; the thing that gets simulated and analysed. A System's inputs can be driven by a Stimulus or by a recorded or live Signal.
_Avoid_: model, diagram, graph, network, flow

**Port**:
A named input or output of a Block.
_Avoid_: pin, socket, terminal

**Connection**:
A directed link carrying values from one Block's output Port to another Block's input Port.
_Avoid_: wire, edge, link

**Loop Template**:
A ready-made System for the standard feedback loop (reference → controller → Plant → sensor filter → feedback) whose Blocks the user fills in.
_Avoid_: preset, wizard

**Stimulus**:
A synthetic input applied to a System, such as a step, impulse, chirp or sine sweep.
_Avoid_: excitation, test signal, input

### Presentation

**Panel**:
One visualisation or editor occupying a region of the screen, such as a time plot, an attitude view or an Analysis result.
_Avoid_: widget, view, chart, window

**Layout**:
The arrangement of Panels on screen, saved in the Project.
_Avoid_: dashboard, perspective

### Analysis

**Analysis**:
A computation run on a System or on Signals that produces a result to inspect, such as a step response, a Frequency Response, a pole-zero map, a spectrum or a Parameter Sweep.
_Avoid_: simulation, study, experiment

**Frequency Response**:
How a System's gain and phase vary with frequency. It is either analytic (computed from linear Blocks) or measured (estimated by simulating a System with a Stimulus); results always state which.
_Avoid_: Bode (a Bode plot is one way to show it), transfer characteristic

**Parameter Sweep**:
An Analysis that varies one or two Block Parameters across a range and records Metrics for each combination.
_Avoid_: grid search, scan, batch run

**Metric**:
A scalar figure of merit extracted from an Analysis result, such as overshoot, settling time, bandwidth or phase margin.
_Avoid_: score, KPI, measure
