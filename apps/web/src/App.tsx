/**
 * Demo shell. The four components this app is built around are wired in as
 * they land; routing proper (§14 `routes/`) is not part of this slice.
 */
export function App() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-screen-sm px-4 py-6">
      <h1 className="text-xl font-semibold text-slate-900">Handover</h1>
      <p className="mt-2 text-sm text-slate-600">
        Record the property at move-in, record it again at move-out, and keep a dated,
        tamper-evident record of the difference.
      </p>
    </main>
  );
}
