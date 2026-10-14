import type { ParameterType } from "@modelviz/protocol";
import type { DecodedMessage, OutgoingMessage, ParameterProtocol, ParameterStore } from "../frame-format.ts";
import type { Dialect } from "./dialect.ts";

/** Messages of the MAVLink parameter microservice (common.xml) the workbench uses. */
export const PARAMETER_MESSAGES = ["PARAM_REQUEST_READ", "PARAM_REQUEST_LIST", "PARAM_VALUE", "PARAM_SET"] as const;

/** MAV_PARAM_TYPE values. */
const MAV_TYPE: Record<ParameterType, number> = { uint8: 1, int8: 2, uint16: 3, int16: 4, uint32: 5, int32: 6, float: 9 };
const FROM_MAV = new Map(Object.entries(MAV_TYPE).map(([k, v]) => [v, k as ParameterType]));

/** param_index meaning "look up by param_id". */
const BY_NAME = -1;
/** param_index of a PARAM_VALUE that is not part of an enumeration. */
const NO_INDEX = 65535;

/**
 * The MAVLink parameter protocol, available when the dialect defines its four Messages.
 * Values travel as the float `param_value`, converted by C cast (not byte-wise): integer
 * Device Parameters are exact up to 2^24.
 */
export function mavlinkParameters(dialect: Dialect): ParameterProtocol | undefined {
  if (!PARAMETER_MESSAGES.every((m) => dialect.byName.has(m))) return undefined;
  const value = (name: string, v: number, type: ParameterType, index: number, count: number): OutgoingMessage => ({
    message: "PARAM_VALUE",
    values: { param_id: name, param_value: v, param_type: MAV_TYPE[type], param_index: index, param_count: count },
  });
  return {
    messages: [...PARAMETER_MESSAGES],
    maxNameLength: 16,
    requestList: (to) => ({ message: "PARAM_REQUEST_LIST", values: { target_system: to.system, target_component: to.component } }),
    requestRead: (to, which) => ({
      message: "PARAM_REQUEST_READ",
      values: {
        target_system: to.system,
        target_component: to.component,
        param_id: typeof which === "string" ? which : "",
        param_index: typeof which === "string" ? BY_NAME : which,
      },
    }),
    requestWrite: (to, name, v, type) => ({
      message: "PARAM_SET",
      values: { target_system: to.system, target_component: to.component, param_id: name, param_value: v, param_type: MAV_TYPE[type] },
    }),
    report(msg) {
      if (msg.message !== "PARAM_VALUE") return null;
      const v = msg.values;
      const index = Number(v.param_index);
      return {
        name: String(v.param_id),
        value: Number(v.param_value),
        type: FROM_MAV.get(Number(v.param_type)) ?? "float",
        index: index === NO_INDEX ? -1 : index,
        count: Number(v.param_count),
      };
    },
    serve(msg: DecodedMessage, store: ParameterStore): OutgoingMessage[] {
      const all = store.entries();
      const reply = (i: number) => value(all[i]!.name, all[i]!.value, all[i]!.type, i, all.length);
      const find = (name: string) => all.findIndex((p) => p.name === name);
      const v = msg.values;
      switch (msg.message) {
        case "PARAM_REQUEST_LIST":
          return all.map((_, i) => reply(i));
        case "PARAM_REQUEST_READ": {
          const index = Number(v.param_index);
          const i = index === BY_NAME ? find(String(v.param_id)) : index;
          return i >= 0 && i < all.length ? [reply(i)] : [];
        }
        case "PARAM_SET": {
          const i = find(String(v.param_id));
          if (i < 0) return [];
          store.set(all[i]!.name, Number(v.param_value));
          const now = store.entries();
          return [value(now[i]!.name, now[i]!.value, now[i]!.type, i, now.length)];
        }
        default:
          return [];
      }
    },
  };
}
