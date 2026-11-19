// Bindings of the Worker (wrangler.jsonc).

import type { LobbyDO, RoomDO, UserDO } from "./durable_objects.js";

export type Env = {
  ROOM: DurableObjectNamespace<RoomDO>;
  USER: DurableObjectNamespace<UserDO>;
  LOBBY: DurableObjectNamespace<LobbyDO>;
};
