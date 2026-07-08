'use client';

// Read-error register (design-system §7 register 4): a problem-styled, non-blocking
// message, visually distinct from the empty registers. getBoard() does not throw, so
// this is a safety net — but it is still a distinct, error-styled register.
//
// Security req 4: the raw exception / stack / any fs path is NEVER echoed into the UI.
// Generic copy only. The `error` prop is intentionally not rendered.
export default function Error() {
  return (
    <main className="flex h-screen items-start justify-center bg-base-100 p-4">
      <div role="alert" className="alert alert-error alert-soft mt-8 max-w-md">
        <span>{"Couldn't read the board."}</span>
      </div>
    </main>
  );
}
