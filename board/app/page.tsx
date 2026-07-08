import { getBoard } from '@/app/actions/board';

// THROWAWAY render — this exists only to exercise the getBoard() server action
// on the read path (KODI-009). The real daisyUI Board/Column/Card design-system
// UI lands in KODI-010; do not build it here.
export default async function Home() {
  const board = await getBoard();

  return (
    <main className="min-h-screen bg-base-200 p-8">
      <h1 className="mb-6 text-2xl font-bold">kodi board (read-path smoke)</h1>
      <div className="flex flex-wrap gap-6">
        {board.columns.map((column) => (
          <section key={column.status} className="min-w-64">
            <h2 className="mb-2 font-semibold">
              {column.status} ({column.tickets.length})
            </h2>
            {column.tickets.length === 0 ? (
              <p className="text-base-content/50">No tickets</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {column.tickets.map((ticket) => (
                  <li key={ticket.key} className="rounded border p-2">
                    <span className="font-mono">{ticket.key}</span> — {ticket.title}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
