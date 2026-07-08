import { getBoard } from '@/app/actions/board';
import { LiveBoard } from '@/app/components/LiveBoard';

// The board reads the tickets dir from `KODI_TICKETS_DIR` at REQUEST time (the
// serve launcher sets it per invocation). Force dynamic rendering so `getBoard()`
// runs on every request against the live env — without this Next static-prerenders
// `/` at build time (empty, no KODI_TICKETS_DIR) and serves that stale empty board
// regardless of the runtime env.
export const dynamic = 'force-dynamic';

// The board screen (KODI-010/013). Async SERVER component: fetches the §7 board
// model via the KODI-009 read path (getBoard never throws) and hands the initial
// model to the CLIENT LiveBoard wrapper, which renders the pure Board and opens
// the SSE live channel (KODI-013). Only the nine §7 fields cross the
// server→client boundary (security req 4).
export default async function Home() {
  const model = await getBoard();
  return <LiveBoard initialModel={model} />;
}
