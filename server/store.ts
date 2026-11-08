/**
 * What the game keeps per account, beside better-auth's tables in the same SQLite file: the
 * avatar's colours and where it was last. A player who was never placed has no position yet.
 */

import type { Database } from 'bun:sqlite';

import { isOutfit } from '../src/net/protocol.ts';
import type { Outfit, PlayerState } from '../src/net/protocol.ts';

export interface PlayerRecord {
  outfit: Outfit;
  /** Where they left the city, standing on foot, or null before they first moved. */
  at: PlayerState | null;
}

export interface Store {
  /** The player's record, made with `outfit` the first time it is asked for. */
  player(userId: string, outfit: () => Outfit): PlayerRecord;
  saveOutfit(userId: string, outfit: Outfit): void;
  savePosition(userId: string, state: PlayerState): void;
  /** Saves many at once, in one transaction: one disk flush however many. */
  savePositions(saves: { userId: string; state: PlayerState }[]): void;
}

interface Row {
  outfit: string;
  x: number | null;
  z: number | null;
  heading: number | null;
  place: string | null;
  floor: number | null;
}

export function createStore(db: Database, now: () => number = Date.now): Store {
  db.run(`CREATE TABLE IF NOT EXISTS players (
    user_id TEXT PRIMARY KEY,
    outfit TEXT NOT NULL,
    x REAL,
    z REAL,
    heading REAL,
    place TEXT,
    floor INTEGER,
    updated_at INTEGER NOT NULL
  )`);
  const select = db.query<Row, [string]>(
    'SELECT outfit, x, z, heading, place, floor FROM players WHERE user_id = ?',
  );
  const insert = db.query(
    'INSERT OR IGNORE INTO players (user_id, outfit, updated_at) VALUES (?, ?, ?)',
  );
  const updateOutfit = db.query(
    'UPDATE players SET outfit = ?2, updated_at = ?3 WHERE user_id = ?1',
  );
  const updatePosition = db.query(
    'UPDATE players SET x = ?2, z = ?3, heading = ?4, place = ?5, floor = ?6, updated_at = ?7 WHERE user_id = ?1',
  );

  const savePosition = (userId: string, s: PlayerState) =>
    updatePosition.run(userId, s.x, s.z, s.heading, s.place, s.floor, now());
  const savePositions = db.transaction((saves: { userId: string; state: PlayerState }[]) => {
    for (const { userId, state } of saves) savePosition(userId, state);
  });

  return {
    player(userId, outfit) {
      let row = select.get(userId);
      if (!row) {
        insert.run(userId, JSON.stringify(outfit()), now());
        row = select.get(userId)!;
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(row.outfit);
      } catch {
        // Falls through to a fresh outfit below.
      }
      const at: PlayerState | null =
        row.x === null || row.z === null
          ? null
          : {
              x: row.x,
              z: row.z,
              heading: row.heading ?? 0,
              speed: 0,
              mode: 'foot',
              place: row.place ?? '',
              floor: row.floor ?? 0,
            };
      // A row someone edited by hand into nonsense gets a fresh outfit rather than an error.
      return { outfit: isOutfit(parsed) ? parsed : outfit(), at };
    },
    saveOutfit(userId, outfit) {
      updateOutfit.run(userId, JSON.stringify(outfit), now());
    },
    savePosition,
    savePositions(saves) {
      savePositions(saves);
    },
  };
}
