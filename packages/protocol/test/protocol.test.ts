import { describe, expect, it } from "vitest";
import {
  applyDraw,
  applyPlay,
  createGame,
  createSeededRng,
  getPlayerView,
  ERROR_CODES as ENGINE_ERROR_CODES,
  type EngineConfig,
  type EngineEvent,
  type RoomOptions,
} from "@check/engine";
import {
  CLOSE_CODES,
  ERROR_CODES,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  isValidFee,
  parseClientMessage,
  parseServerMessage,
  CreateRoomRequestSchema,
  RoomOptionsSchema,
  type PlayerView,
  type RoomServerMessage,
} from "../src/index.js";

const ID = "3f1c2a4e-8b7d-4c6e-9f10-112233445566";
const NOW = 1_763_550_000_000;
const OPTIONS: RoomOptions = {
  two_transparent: true,
  jack_commands: true,
  jack_wild: true,
  ace_skips: true,
  seven_draw_two: true,
  joker_draw_four: true,
  joker_wild: true,
  allow_multiples: true,
};
const CONFIG: EngineConfig = {
  minPlayers: 2,
  maxPlayers: 6,
  initialHandSize: 5,
  turnSeconds: 30,
  disconnectGraceSeconds: 60,
  maxConsecutiveMissedTurns: 3,
  penaltySeven: 2,
  penaltyJoker: 4,
  checkCall: { enabled: true, penalty: 2, mode: "denunciation" },
  forbidFinishOnAceInDuel: true,
};

function room(message: unknown) {
  return parseClientMessage("room", JSON.stringify(message));
}

describe("SRV-01 — messages client → serveur (salon)", () => {
  it("accepte un PLAY valide (cartes ordonnées, couleur, annonce)", () => {
    const result = room({ t: "PLAY", id: ID, cards: ["7H", "7S"], suit: "D", declareCheck: false });
    expect(result).toEqual({
      ok: true,
      message: { t: "PLAY", id: ID, cards: ["7H", "7S"], suit: "D", declareCheck: false },
    });
  });

  it("accepte tous les messages du protocole §6.1", () => {
    const messages = [
      { t: "AUTH", token: "jwt", v: 1 },
      { t: "JOIN", id: ID },
      { t: "LEAVE", id: ID },
      { t: "UPDATE_OPTIONS", id: ID, options: OPTIONS, fee: 300 },
      { t: "START", id: ID },
      { t: "PLAY", id: ID, cards: ["XR"] },
      { t: "DRAW", id: ID },
      { t: "CALL_CHECK", id: ID, targetId: "u2" },
      { t: "SYNC", id: ID },
      { t: "PING", c: NOW },
    ];
    for (const m of messages) expect(room(m)).toEqual({ ok: true, message: m });
  });

  it("un message invalide est rejeté avec ERROR, en reprenant son id", () => {
    expect(room({ t: "PLAY", id: ID, cards: ["1Z"] })).toEqual({
      ok: false,
      error: { t: "ERROR", id: ID, code: "INVALID_MESSAGE", message: expect.any(String) as string },
    });
  });

  it("rejette un type inconnu, un champ manquant, un champ en trop, un id qui n'est pas un UUID", () => {
    const bad = [
      { t: "HACK", id: ID },
      { t: "PLAY", id: ID },
      { t: "DRAW" },
      { t: "DRAW", id: ID, cards: ["7H"] },
      { t: "DRAW", id: "abc" },
      { t: "PLAY", id: ID, cards: [] },
      { t: "PLAY", id: ID, cards: ["7H"], suit: "X" },
      { t: "PING", c: "now" },
      { t: "AUTH", token: "", v: 1 },
      ["DRAW", ID],
      null,
      42,
    ];
    for (const m of bad) {
      const result = room(m);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error?.code).toBe("INVALID_MESSAGE");
    }
  });

  it("un texte qui n'est pas du JSON est rejeté sans id", () => {
    const result = parseClientMessage("room", "{pas du json");
    expect(result).toEqual({
      ok: false,
      error: { t: "ERROR", code: "INVALID_MESSAGE", message: expect.any(String) as string },
    });
  });

  it("un message de plus de 4 Ko demande la fermeture 4008", () => {
    const raw = JSON.stringify({ t: "AUTH", token: "x".repeat(MAX_MESSAGE_BYTES), v: 1 });
    expect(parseClientMessage("room", raw)).toEqual({ ok: false, close: 4008 });
    // The limit is in bytes (UTF-8), not characters.
    const accents = JSON.stringify({ t: "AUTH", token: "é".repeat(2100), v: 1 });
    expect(accents.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(parseClientMessage("room", accents)).toEqual({ ok: false, close: 4008 });
  });

  it("des options invalides donnent INVALID_OPTIONS ; un montant invalide donne INVALID_FEE", () => {
    const code = (message: unknown) => {
      const result = room(message);
      return result.ok ? null : result.error?.code;
    };
    const missing: Partial<RoomOptions> = { ...OPTIONS };
    delete missing.allow_multiples;
    expect(code({ t: "UPDATE_OPTIONS", id: ID, options: missing, fee: 200 })).toBe(
      "INVALID_OPTIONS",
    );
    const extra = { ...OPTIONS, x: true };
    expect(code({ t: "UPDATE_OPTIONS", id: ID, options: extra, fee: 200 })).toBe("INVALID_OPTIONS");
    expect(code({ t: "UPDATE_OPTIONS", id: ID, options: OPTIONS, fee: "200" })).toBe("INVALID_FEE");
  });

  it("le montant n'est pas vérifié par le schéma (règles métier côté serveur, T24)", () => {
    expect(room({ t: "UPDATE_OPTIONS", id: ID, options: OPTIONS, fee: 0 }).ok).toBe(true);
  });
});

describe("SRV-01 — connexions joueur et liste", () => {
  it("la liste accepte QUICK_PLAY mais pas PLAY", () => {
    expect(
      parseClientMessage("lobby", JSON.stringify({ t: "QUICK_PLAY", id: ID, fee: 200 })).ok,
    ).toBe(true);
    const play = parseClientMessage("lobby", JSON.stringify({ t: "PLAY", id: ID, cards: ["7H"] }));
    expect(play.ok).toBe(false);
  });

  it("la connexion joueur n'accepte que AUTH et PING", () => {
    expect(parseClientMessage("user", JSON.stringify({ t: "PING", c: NOW })).ok).toBe(true);
    expect(parseClientMessage("user", JSON.stringify({ t: "JOIN", id: ID })).ok).toBe(false);
  });
});

describe("SRV-01 — montant de participation (spécification des jetons §6)", () => {
  const fees = { min: 200, max: 10_000, step: 100 };
  it("de 200 à 10 000 par paliers de 100 (T24, T25)", () => {
    for (const ok of [200, 300, 1_000, 10_000]) expect(isValidFee(ok, fees)).toBe(true);
    for (const ko of [0, 100, 150, 250, 10_100, -200, 200.5, Number.NaN]) {
      expect(isValidFee(ko, fees)).toBe(false);
    }
  });
});

describe("SRV-01 — requêtes HTTP", () => {
  it("POST /api/rooms : type, fee, options", () => {
    expect(
      CreateRoomRequestSchema.safeParse({ type: "PRIVATE", fee: 200, options: OPTIONS }).success,
    ).toBe(true);
    expect(
      CreateRoomRequestSchema.safeParse({ type: "SECRET", fee: 200, options: OPTIONS }).success,
    ).toBe(false);
  });

  it("le schéma des options correspond aux options du moteur (R1 à R8)", () => {
    expect(RoomOptionsSchema.parse(OPTIONS)).toEqual(OPTIONS);
  });
});

describe("SRV-01 — messages serveur → client alignés sur le moteur", () => {
  /** Turns an engine event into the wire message (what the RoomDO will do in SRV-05). */
  function toWire(event: EngineEvent, seq: number): unknown {
    if (event.t === "YOU_DREW") return { t: "YOU_DREW", cards: event.cards };
    if (event.t === "GAME_OVER") return { ...event, seq, pot: 600, commission: 60, payout: 540 };
    return { ...event, seq };
  }

  it("les événements produits par le moteur sont des messages valides une fois numérotés", () => {
    const rng = createSeededRng(7);
    let state = createGame(CONFIG, OPTIONS, ["u1", "u2", "u3"], rng, NOW, "g1");
    const events: EngineEvent[] = [];
    for (let i = 0; i < 400 && state.status === "PLAYING"; i++) {
      const id = state.currentPlayerId;
      const view = getPlayerView(state, id);
      const card = view.game.legal.playable[0];
      const result =
        card === undefined
          ? applyDraw(state, id, rng, NOW + i)
          : applyPlay(state, id, { cards: [card], suit: "H" }, rng, NOW + i);
      events.push(...result.events);
      state = result.state;
    }
    const types = new Set(events.map((e) => e.t));
    expect(types).toContain("CARDS_PLAYED");
    expect(types).toContain("CARDS_DRAWN");
    events.forEach((event, i) => {
      const result = parseServerMessage("room", JSON.stringify(toWire(event, i + 1)));
      expect({ t: event.t, ok: result.success }).toEqual({ t: event.t, ok: true });
    });
  });

  it("un YOU_DREW qui garde playerId est refusé (le RoomDO doit le retirer)", () => {
    const leaked = { t: "YOU_DREW", playerId: "u1", cards: ["7H"] };
    expect(parseServerMessage("room", JSON.stringify(leaked)).success).toBe(false);
  });

  it("la vue du moteur complétée par les champs du salon forme un PlayerView valide", () => {
    const state = createGame(CONFIG, OPTIONS, ["u1", "u2"], createSeededRng(1), NOW, "g1");
    const engineView = getPlayerView(state, "u1");
    const view: PlayerView = {
      roomId: "r1",
      roomStatus: "PLAYING",
      roomType: "PRIVATE",
      code: "ABC123",
      hostId: "u1",
      fee: 200,
      options: OPTIONS,
      players: engineView.players.map((p) => ({ ...p, pseudo: `Joueur ${p.id}` })),
      me: engineView.me,
      game: {
        gameId: engineView.game.gameId,
        pot: 400,
        topCard: engineView.game.topCard,
        deckCount: engineView.game.deckCount,
        currentPlayerId: engineView.game.currentPlayerId,
        turnDeadline: engineView.game.turnDeadline,
        penalty: engineView.game.penalty,
        requestedSuit: engineView.game.requestedSuit,
        openColor: engineView.game.openColor,
        checkWindowTargetId: engineView.game.checkWindowTargetId,
        legal: engineView.game.legal,
      },
      seq: 3,
      serverTime: NOW,
    };
    const message: RoomServerMessage = { t: "STATE", view };
    expect(parseServerMessage("room", JSON.stringify(message)).success).toBe(true);
  });

  it("accepte les messages de salle d'attente, de liste et de connexion joueur", () => {
    const roomMessages = [
      { t: "AUTH_OK", userId: "u1", serverTime: NOW },
      { t: "ACK", id: ID },
      { t: "ERROR", id: ID, code: "NOT_YOUR_TURN", message: "Ce n'est pas votre tour." },
      { t: "PONG", c: NOW, s: NOW + 40 },
      {
        t: "PLAYER_JOINED",
        seq: 1,
        player: {
          id: "u2",
          pseudo: "Awa",
          seat: 1,
          handCount: 0,
          connected: true,
          checkDeclared: false,
          forfeited: false,
        },
      },
      { t: "PLAYER_LEFT", seq: 2, playerId: "u2", reason: "KICKED_BALANCE" },
      { t: "HOST_CHANGED", seq: 3, hostId: "u3" },
      { t: "OPTIONS_UPDATED", seq: 4, options: OPTIONS, fee: 500 },
      { t: "COUNTDOWN_STARTED", seq: 5, endsAt: NOW + 60_000 },
      { t: "COUNTDOWN_CANCELLED", seq: 6, endsAt: NOW + 60_000 },
      { t: "GAME_STARTING", seq: 7 },
      {
        t: "GAME_STARTED",
        seq: 8,
        gameId: "g1",
        pot: 400,
        seats: ["u1", "u2"],
        starterCard: "5H",
        currentPlayerId: "u2",
        turnDeadline: NOW + 30_000,
        handCounts: { u1: 5, u2: 5 },
      },
      { t: "HAND", cards: ["7H", "XR", "10S", "AD", "JC"] },
    ];
    for (const m of roomMessages) {
      expect({ t: m.t, ok: parseServerMessage("room", JSON.stringify(m)).success }).toEqual({
        t: m.t,
        ok: true,
      });
    }
    const lobbyRoom = {
      roomId: "r1",
      fee: 200,
      options: OPTIONS,
      playerCount: 2,
      maxPlayers: 6,
      status: "COUNTDOWN",
      countdownEndsAt: NOW + 60_000,
    };
    for (const m of [
      { t: "LOBBY_SNAPSHOT", rooms: [lobbyRoom] },
      { t: "LOBBY_ROOM_UPSERT", room: { ...lobbyRoom, status: "WAITING", countdownEndsAt: null } },
      { t: "LOBBY_ROOM_REMOVED", roomId: "r1" },
      { t: "QUICK_PLAY_MATCHED", roomId: "r1" },
    ]) {
      expect(parseServerMessage("lobby", JSON.stringify(m)).success).toBe(true);
    }
    for (const m of [
      { t: "CURRENT_ROOM", roomId: null },
      { t: "CURRENT_ROOM", roomId: "r1" },
      { t: "GUEST_EXPIRING", secondsLeft: 240 },
    ]) {
      expect(parseServerMessage("user", JSON.stringify(m)).success).toBe(true);
    }
  });

  it("parseServerMessage refuse un texte qui n'est pas du JSON", () => {
    expect(parseServerMessage("room", "<html>").success).toBe(false);
  });
});

describe("SRV-01 — constantes", () => {
  it("version du protocole et codes de fermeture (§2)", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(CLOSE_CODES).toEqual({
      NORMAL: 1000,
      UNAUTHORIZED: 4001,
      UPGRADE_REQUIRED: 4002,
      REPLACED: 4003,
      ROOM_CLOSED: 4004,
      TOO_MANY_MESSAGES: 4008,
    });
  });

  it("les codes d'erreur contiennent ceux du moteur, du salon et des jetons", () => {
    for (const code of ENGINE_ERROR_CODES) expect(ERROR_CODES).toContain(code);
    for (const code of [
      "ROOM_FULL",
      "ROOM_STARTING",
      "NOT_HOST",
      "INSUFFICIENT_BALANCE",
      "IN_GAME",
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});
