import { getBoard } from '@/app/actions/board';
import { Board } from '@/app/components/Board';

// The board screen (KODI-010). Async SERVER component: fetches the §7 board model
// via the KODI-009 read path (getBoard never throws) and hands the model to the
// CLIENT Board, which renders the five fixed columns and owns expansion view-state.
// Only the nine §7 fields cross the server→client boundary (security req 4).
export default async function Home() {
  const model = await getBoard();
  return <Board model={model} />;
}
