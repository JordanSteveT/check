import { ENGINE_VERSION } from "@check/engine";
import { PROTOCOL_VERSION } from "@check/protocol";

// Placeholder: the real Worker entry point is written in ticket SET-07.
export function describeServer(): string {
  return `engine ${ENGINE_VERSION}, protocol v${PROTOCOL_VERSION}`;
}
