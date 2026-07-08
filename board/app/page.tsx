export default function Home() {
  return (
    <main className="hero min-h-screen bg-base-200">
      <div className="hero-content text-center">
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body items-center gap-4">
            <div className="flex items-center gap-3">
              <h1 className="card-title text-3xl">kodi board</h1>
              <span className="badge badge-primary badge-outline">
                scaffold
              </span>
            </div>
            <p className="max-w-md text-base-content/70">
              This is a placeholder page. The real ticket board lands in a
              later slice — for now it just proves the Next.js + daisyUI
              scaffold renders with the stock light and dark themes.
            </p>
            <div className="card-actions">
              <button className="btn btn-primary" type="button" disabled>
                Coming soon
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
