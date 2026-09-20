import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GetDiffResponse, GetTenancyResponse, RoomDiffView } from '@handover/shared';
import { createApiClient, isDemoMode, type HandoverApiClient } from './lib/api-client.js';
import { DEMO_TENANCY_ID } from './lib/demo/index.js';
import { toDiffAdditions, type MarkedChange } from './lib/marked-change.js';
import { CompareSlider } from './features/compare/CompareSlider.js';
import { ChangeMarker } from './features/compare/ChangeMarker.js';
import { ConditionSummary } from './features/compare/ConditionSummary.js';
import { RoomCapture } from './features/capture/RoomCapture.js';

/**
 * Demo shell wiring the four capture/compare components together.
 *
 * Routing proper (§14 `routes/`) and the tenancy setup and claim flows are not
 * part of this slice. The tenancy id comes from the query string; there is no
 * `localStorage` anywhere in this app, and §7 defines no list endpoint, so a
 * tenancy is reached by id or not at all.
 */
export function App() {
  const demo = isDemoMode();
  const tenancyId = useMemo(() => {
    const fromQuery = new URLSearchParams(globalThis.location?.search ?? '').get('tenancy');
    return fromQuery ?? (demo ? DEMO_TENANCY_ID : '');
  }, [demo]);

  const [api, setApi] = useState<HandoverApiClient>();
  const [tenancy, setTenancy] = useState<GetTenancyResponse>();
  const [diff, setDiff] = useState<GetDiffResponse>();
  const [roomId, setRoomId] = useState<string>();
  const [marks, setMarks] = useState<readonly MarkedChange[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void createApiClient().then((client) => {
      if (!cancelled) setApi(client);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    if (!api || !tenancyId) return;
    try {
      const [nextTenancy, nextDiff] = await Promise.all([
        api.getTenancy(tenancyId),
        api.getDiff(tenancyId),
      ]);
      setTenancy(nextTenancy);
      setDiff(nextDiff);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api, tenancyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const room: RoomDiffView | undefined = diff?.rooms.find((r) => r.roomId === roomId);

  const saveMarks = useCallback(async () => {
    if (!api || !room || marks.length === 0) return;
    // Render from the response, so the server's ids for new additions are the
    // ones on screen — never an optimistic local patch.
    await api.patchRoomDiff(tenancyId, room.roomId, {
      changes: [],
      additions: toDiffAdditions(marks),
    });
    setMarks([]);
    await load();
  }, [api, load, marks, room, tenancyId]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-screen-sm px-4 py-6">
      {/* Small, persistent, unmistakable. A screenshot of the demo must never
          be mistakable for real evidence. */}
      {demo ? (
        <p
          data-testid="demo-badge"
          className="mb-3 rounded bg-fuchsia-100 px-2 py-1 text-center text-xs font-semibold uppercase tracking-wide text-fuchsia-900"
        >
          Demo data — not a real tenancy
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      ) : null}

      {!tenancyId ? (
        <p className="text-sm text-slate-600">
          Open this page with a tenancy id, or append <code>?demo=1</code> to see seeded data.
        </p>
      ) : !tenancy || !diff || !api ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : room ? (
        <div className="space-y-5">
          <button
            type="button"
            onClick={() => {
              setRoomId(undefined);
              setMarks([]);
            }}
            className="text-sm font-medium text-sky-700 underline"
          >
            ← All rooms
          </button>

          <h1 className="text-lg font-semibold text-slate-900">{room.roomLabel}</h1>

          {room.before[0] && room.after[0] ? (
            <CompareSlider
              before={{
                url: room.before[0].url,
                alt: `${room.roomLabel} at move-in`,
                receivedAt: room.before[0].receivedAt,
                sha256: room.before[0].sha256,
              }}
              after={{
                url: room.after[0].url,
                alt: `${room.roomLabel} at move-out`,
                receivedAt: room.after[0].receivedAt,
                sha256: room.after[0].sha256,
              }}
              overlays={marks
                .filter((m) => m.box)
                .map((m) => ({ id: m.id, box: m.box!, label: m.description }))}
              onImageError={() => void load()}
            />
          ) : (
            <RoomCapture
              api={api}
              tenancyId={tenancyId}
              roomId={room.roomId}
              roomLabel={room.roomLabel}
              phase="MOVEOUT"
              serverPhotoCount={
                tenancy.rooms.find((r) => r.roomId === room.roomId)?.photoCountMoveout
              }
              onUploaded={() => void load()}
            />
          )}

          {room.after[0] ? (
            <ChangeMarker
              imageUrl={room.after[0].url}
              imageAlt={`${room.roomLabel} at move-out`}
              marks={marks}
              onMarksChange={setMarks}
            />
          ) : null}

          {marks.length > 0 ? (
            <button
              type="button"
              onClick={() => void saveMarks()}
              className="w-full rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white"
            >
              Save {marks.length === 1 ? '1 change' : `${marks.length} changes`}
            </button>
          ) : null}
        </div>
      ) : (
        <ConditionSummary
          tenancy={tenancy.tenancy}
          rooms={diff.rooms}
          phase="MOVEOUT"
          documents={tenancy.documents}
          onSelectRoom={setRoomId}
        />
      )}
    </main>
  );
}
