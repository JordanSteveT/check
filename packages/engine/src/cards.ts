// Card model — see protocole_temps_reel.md §1 and cahier des charges §3 (B1, B2).

export const SUITS = ["H", "D", "S", "C"] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
export type Rank = (typeof RANKS)[number];

/** Red joker / black joker. */
export type Joker = "XR" | "XB";

/** A card identifier, unique within the 54-card deck (e.g. `7H`, `10S`, `XR`). */
export type Card = `${Rank}${Suit}` | Joker;

/** Red (`R`: hearts, diamonds, red joker) or black (`B`: spades, clubs, black joker). */
export type Color = "R" | "B";

const SUIT_COLOR: Readonly<Record<Suit, Color>> = { H: "R", D: "R", S: "B", C: "B" };

/** The 54 cards in a fixed reference order (suits, then ranks, then jokers). */
export const ALL_CARDS: readonly Card[] = Object.freeze([
  ...SUITS.flatMap((suit) => RANKS.map((rank): Card => `${rank}${suit}`)),
  "XR",
  "XB",
]);

const CARD_SET: ReadonlySet<string> = new Set(ALL_CARDS);

export function isCard(value: unknown): value is Card {
  return typeof value === "string" && CARD_SET.has(value);
}

export function isJoker(card: Card): card is Joker {
  return card === "XR" || card === "XB";
}

/** Suit of a card, or `null` for a joker. */
export function suitOf(card: Card): Suit | null {
  return isJoker(card) ? null : (card.slice(-1) as Suit);
}

/** Rank of a card, or `null` for a joker (a joker has no value, §5.4). */
export function rankOf(card: Card): Rank | null {
  return isJoker(card) ? null : (card.slice(0, -1) as Rank);
}

export function suitColor(suit: Suit): Color {
  return SUIT_COLOR[suit];
}

export function colorOf(card: Card): Color {
  if (card === "XR") return "R";
  if (card === "XB") return "B";
  return SUIT_COLOR[card.slice(-1) as Suit];
}

/** A fresh, unshuffled 54-card deck. */
export function createDeck(): Card[] {
  return [...ALL_CARDS];
}
