// Loading register (design-system §7 register 5): a neutral daisyUI `skeleton` of
// the four column frames — NOT a spinner-only white screen — so the expected board
// shape is already on screen. Short-lived on a localhost read.
export default function Loading() {
  return (
    <main className="flex h-screen flex-col gap-4 bg-base-100 p-4">
      <div className="grid min-h-0 flex-1 grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, col) => (
          <div key={col} className="flex min-h-0 flex-col gap-2">
            <div className="skeleton h-8 w-full" />
            <div className="skeleton h-20 w-full" />
            <div className="skeleton h-20 w-full" />
            <div className="skeleton h-20 w-full" />
          </div>
        ))}
      </div>
    </main>
  );
}
