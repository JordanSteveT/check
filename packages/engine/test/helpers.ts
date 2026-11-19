import {
  ALL_CARDS,
  createSeededRng,
  EngineError,
  type Card,
  type Color,
  type EngineConfig,
  type ErrorCode,
  type GameState,
  type PlayerId,
  type Rng,
  type RoomOptions,
  type Suit,
} from "../src/index.js";
import { expect } from "vitest";

/** MVP values from cahier des charges §11.3. */
export const TEST_CONFIG: EngineConfig = {
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

/** All options checked (default, cahier §2.2). */
export const ALL_OPTIONS: RoomOptions = {
  two_transparent: true,
  jack_commands: true,
  jack_wild: true,
  ace_skips: true,
  seven_draw_two: true,
  joker_draw_four: true,
  joker_wild: true,
  allow_multiples: true,
};

export function options(overrides: Partial<RoomOptions> = {}): RoomOptions {
  return { ...ALL_OPTIONS, ...overrides };
}

/** Fixed clock for tests. */
export const NOW = 1_763_550_000_000;

export const PLAYERS = ["A", "B", "C", "D", "E", "F"] as const;

export function players(n: number): string[] {
  return PLAYERS.slice(0, n);
}

/** Neutral cards used to pad hands so that playing a tested card does not empty the hand. */
const FILLERS: readonly Card[] = [
  "QC", "KC", "QS", "KS", "3C", "4C", "6C", "3S", "4S", "6S", "QD", "KD",
  "3D", "4D", "6D", "QH", "KH", "3H", "4H", "6H", "8C", "8S", "10C", "10S",
]; // prettier-ignore

export type MakeStateInput = {
  /** Number of players (default 3: A, B, C). */
  n?: number;
  /** Whose turn it is (default A). */
  current?: PlayerId;
  /** Cards each player must hold. Hands are padded with fillers up to `handSize`. */
  hands?: Partial<Record<PlayerId, Card[]>>;
  /** Hand size after padding (default 5). Use `exact` to disable padding. */
  handSize?: number;
  /** Players whose hand is exactly what is given (no padding). */
  exact?: PlayerId[];
  /** Discard pile, bottom to top (default ["5H"]). */
  discard?: Card[];
  /** Draw pile, top first. Default: every remaining card (54 cards in total). */
  deck?: Card[];
  penalty?: number;
  requestedSuit?: Suit | null;
  openColor?: Color | null;
  options?: Partial<RoomOptions>;
  config?: Partial<EngineConfig>;
  forfeited?: PlayerId[];
};

/** Builds a game state directly, without random dealing (cas de test, conventions). */
export function makeState(input: MakeStateInput = {}): GameState {
  const seats = players(input.n ?? 3);
  const discard = input.discard ?? ["5H"];
  const used = new Set<Card>(discard);
  for (const cards of Object.values(input.hands ?? {})) for (const c of cards ?? []) used.add(c);
  for (const c of input.deck ?? []) used.add(c);

  const fillers = FILLERS.filter((c) => !used.has(c));
  const hands: Record<PlayerId, Card[]> = {};
  for (const id of seats) {
    const hand = [...(input.hands?.[id] ?? [])];
    if (!(input.exact ?? []).includes(id) && !(input.forfeited ?? []).includes(id)) {
      while (hand.length < (input.handSize ?? 5)) {
        const filler = fillers.shift();
        if (filler === undefined) throw new Error("makeState: not enough filler cards");
        hand.push(filler);
        used.add(filler);
      }
    }
    hands[id] = hand;
  }
  const deck = input.deck ?? ALL_CARDS.filter((c) => !used.has(c));

  const missedTurns: Record<PlayerId, number> = {};
  const connected: Record<PlayerId, boolean> = {};
  for (const id of seats) {
    missedTurns[id] = 0;
    connected[id] = true;
  }
  return {
    gameId: "test-game",
    config: { ...TEST_CONFIG, ...input.config },
    options: options(input.options),
    seats,
    hands,
    deck,
    discard,
    currentPlayerId: input.current ?? "A",
    turnStartedAt: NOW,
    turnDeadline: NOW + 30_000,
    penalty: input.penalty ?? 0,
    requestedSuit: input.requestedSuit ?? null,
    openColor: input.openColor ?? null,
    checkWindow: null,
    checkDeclared: [],
    status: "PLAYING",
    missedTurns,
    connected,
    forfeited: input.forfeited ?? [],
    roundsWithoutPlay: 0,
  };
}

/** Asserts that `fn` throws an EngineError with the given code. */
export function expectError(fn: () => unknown, code: ErrorCode): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe(code);
    return;
  }
  expect.fail(`expected EngineError ${code}, but nothing was thrown`);
}

export function top(state: GameState): Card | undefined {
  return state.discard[state.discard.length - 1];
}

/** Time of the move in tests (5 s into the turn). */
export const LATER = NOW + 5_000;

/** Seeded generator for actions that may reshuffle the deck. */
export function rng(): Rng {
  return createSeededRng(1);
}
