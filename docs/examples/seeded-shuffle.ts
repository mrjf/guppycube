/**
 * Reference implementation of the "fy-sha256/1" seeded shuffle used by guppycube records.
 * Runs anywhere WebCrypto exists: Cloudflare Workers, browsers, Bun, Node 20+.
 *
 *   block_k  = SHA-256(seed || uint32be(k))           k = 0, 1, 2, …
 *   words    = consecutive big-endian uint32 values read from block_0, block_1, …
 *   below(n) = first word w with w < 2^32 - (2^32 mod n), reduced mod n   (rejection sampling)
 *   shuffle  = Fisher–Yates: for i = len-1 … 1: j = below(i+1); swap(a[i], a[j])
 *
 * A game start consumes one word stream for two shuffles, in this order:
 *   1. seating order: the seat ids in join order
 *   2. the pool: the canonical tile list (c1a c1b c2a … i13b *a *b)
 * then deals rackSize rounds, each seat in seating order taking pool.pop() (the last element).
 * Every later draw is also pool.pop().
 */

export const CANONICAL_COLORS = ["c", "s", "o", "i"] as const;

export function canonicalTiles(): string[] {
  const tiles: string[] = [];
  for (const color of CANONICAL_COLORS) {
    for (let value = 1; value <= 13; value += 1) {
      for (const copy of ["a", "b"]) tiles.push(`${color}${value}${copy}`);
    }
  }
  tiles.push("*a", "*b");
  return tiles;
}

export class SeededWords {
  private counter = 0;
  private buffer = new Uint8Array(0);
  private offset = 0;

  constructor(private readonly seed: Uint8Array) {}

  private async refill(): Promise<void> {
    const input = new Uint8Array(this.seed.length + 4);
    input.set(this.seed, 0);
    new DataView(input.buffer).setUint32(this.seed.length, this.counter, false);
    this.counter += 1;
    this.buffer = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    this.offset = 0;
  }

  async word(): Promise<number> {
    if (this.offset >= this.buffer.length) await this.refill();
    const value = new DataView(this.buffer.buffer).getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  async below(n: number): Promise<number> {
    const limit = 2 ** 32 - ((2 ** 32) % n);
    for (;;) {
      const w = await this.word();
      if (w < limit) return w % n;
    }
  }
}

export async function fisherYates<T>(items: readonly T[], words: SeededWords): Promise<T[]> {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = await words.below(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export interface SeededStart {
  order: string[];
  pool: string[];
  racks: Record<string, string[]>;
}

export async function seededStart(seed: Uint8Array, seatsInJoinOrder: string[], rackSize = 14): Promise<SeededStart> {
  const words = new SeededWords(seed);
  const order = await fisherYates(seatsInJoinOrder, words);
  const pool = await fisherYates(canonicalTiles(), words);
  const racks: Record<string, string[]> = Object.fromEntries(order.map((seat) => [seat, []]));
  for (let round = 0; round < rackSize; round += 1) {
    for (const seat of order) {
      const tile = pool.pop();
      if (tile) racks[seat]!.push(tile);
    }
  }
  return { order, pool, racks };
}

export async function shuffleCommit(seed: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", seed));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// --- self-check when run directly: bun seeded-shuffle.ts <seed-hex> ---
if (import.meta.main) {
  const hex = process.argv[2] ?? "";
  const seed = Uint8Array.from(hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
  const start = await seededStart(seed, ["p1", "p2", "p3"]);
  console.log(JSON.stringify({ commit: await shuffleCommit(seed), ...start }));
}
