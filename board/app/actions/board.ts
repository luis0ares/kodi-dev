'use server';

// Server action for the board read path (R-014: reads happen server-side via
// server actions; the browser never touches the filesystem). Reads the tickets
// root from `process.env.KODI_TICKETS_DIR` (the env channel the CLI's `serve`
// launcher sets — ADR-0002 §2.4) and assembles the §7 board model.
//
// Absent/empty env or missing status.yaml → an empty board, never an error
// (ADR-0002 §2.5). The whole path is read-only (R-014/SR-6).

import { buildBoard } from '@/lib/tickets/board';
import type { BoardModel } from '@/lib/tickets/types';

export async function getBoard(): Promise<BoardModel> {
  return buildBoard(process.env.KODI_TICKETS_DIR);
}
