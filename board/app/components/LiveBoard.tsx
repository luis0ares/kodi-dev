'use client';

// LiveBoard — the CLIENT live-wiring wrapper (KODI-013 / ADR-0002 §2.5).
//
// Holds the server-fetched initial BoardModel in state and renders the pure
// <Board> renderer (KODI-010, unchanged — cards still keyed by ticket.key). On
// mount it opens a same-origin EventSource to /events and, on each `change`
// signal, refetches the model via the getBoard() server action and setState's
// the fresh model. The browser NEVER reads the filesystem and NEVER parses board
// data from the stream — the stream is a bare trigger (R-014/SC-1).
//
// This is the FUNCTIONAL transport only: a plain re-render (the card moves to its
// new column, no refresh). The polished move/highlight/ARIA-live/reduced-motion
// UX is KODI-014 and is deliberately NOT built here.

import { useEffect, useRef, useState } from 'react';
import { getBoard } from '@/app/actions/board';
import type { BoardModel } from '@/lib/tickets/types';
import { Board } from './Board';

export function LiveBoard({ initialModel }: { initialModel: BoardModel }) {
  const [model, setModel] = useState<BoardModel>(initialModel);

  // Guards against a late refetch resolving after unmount, and against
  // overlapping refetches from a rapid burst of change signals.
  const activeRef = useRef(true);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);

  useEffect(() => {
    activeRef.current = true;

    async function refetch(): Promise<void> {
      if (inFlightRef.current) {
        // A refetch is already running — remember to run once more after it,
        // so we never miss the latest state but never pile up requests.
        pendingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      try {
        do {
          pendingRef.current = false;
          const fresh = await getBoard();
          if (!activeRef.current) return;
          setModel(fresh);
        } while (pendingRef.current && activeRef.current);
      } catch {
        // A transient read failure must not break the live channel; the next
        // change signal will retry. (getBoard itself never throws by contract.)
      } finally {
        inFlightRef.current = false;
      }
    }

    // Relative same-origin URL — no baked absolute host (SC-15).
    const source = new EventSource('/events');
    source.addEventListener('change', () => {
      void refetch();
    });

    return () => {
      activeRef.current = false;
      source.close();
    };
  }, []);

  return <Board model={model} />;
}
