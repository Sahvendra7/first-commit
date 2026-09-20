import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DemoApiClient } from '../../lib/demo/client.js';
import { DEMO_ROOMS, DEMO_TENANCY_ID } from '../../lib/demo/tenancy.js';
import { RoomCapture } from './RoomCapture.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ROOM = DEMO_ROOMS[0]!;

/**
 * jsdom has no canvas 2D context, so `downscaleImage` cannot run for real.
 * The dimension arithmetic it depends on is tested directly in
 * `image-resize.test.ts`; here the encode is stubbed so the component's own
 * behaviour is what is under test.
 */
function stubDownscale() {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: () => {},
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('createImageBitmap', async () => ({
    width: 4032,
    height: 3024,
    close: () => {},
  }));
}

function photo(name: string): File {
  return new File([new Uint8Array(32)], name, { type: 'image/jpeg' });
}

function renderCapture(props: Partial<React.ComponentProps<typeof RoomCapture>> = {}) {
  stubDownscale();
  const api = props.api ?? new DemoApiClient();
  const utils = render(
    <RoomCapture
      api={api}
      tenancyId={DEMO_TENANCY_ID}
      roomId={ROOM.roomId}
      roomLabel={ROOM.label}
      phase="MOVEIN"
      {...props}
    />,
  );
  return { ...utils, api, input: screen.getByTestId('capture-input') as HTMLInputElement };
}

async function selectFiles(input: HTMLInputElement, files: File[]) {
  await act(async () => {
    fireEvent.change(input, { target: { files } });
  });
}

describe('RoomCapture — the capture control', () => {
  it('uses the file input the spec chose, not getUserMedia', () => {
    const { input } = renderCapture();
    expect(input.type).toBe('file');
    expect(input.accept).toBe('image/*');
    expect(input.getAttribute('capture')).toBe('environment');
    expect(input.multiple).toBe(true);
  });

  it('names the room and the phase', () => {
    renderCapture();
    expect(screen.getByRole('heading', { name: ROOM.label })).toBeDefined();
    expect(screen.getByText('Move-in')).toBeDefined();
  });

  it('says the original is not kept, because it is not', () => {
    renderCapture();
    expect(screen.getByText(/full-size original is not kept/i)).toBeDefined();
    expect(screen.getByText(/1600px/)).toBeDefined();
  });
});

describe('RoomCapture — the server owns the count', () => {
  it('reports the server-side count, not a local tally', () => {
    renderCapture({ serverPhotoCount: 4 });
    expect(screen.getByTestId('server-count').textContent).toContain('4 photographs recorded');
  });

  it('does not claim zero before the server has answered', () => {
    renderCapture({});
    expect(screen.getByTestId('server-count').textContent).toContain('Checking');
  });

  it('says none recorded when the server says none', () => {
    renderCapture({ serverPhotoCount: 0 });
    expect(screen.getByTestId('server-count').textContent).toContain('No photographs recorded');
  });

  it('keeps the server count separate from what this session sent', async () => {
    const { input } = renderCapture({ serverPhotoCount: 0 });
    await selectFiles(input, [photo('a.jpg')]);

    // Sent, per S3. Still zero recorded, per the server — ingestion is async.
    await waitFor(() => expect(screen.getByText(/1 of 1 sent/)).toBeDefined());
    expect(screen.getByTestId('server-count').textContent).toContain('No photographs recorded');
    expect(screen.getByTestId('ingest-note').textContent).toContain('still being recorded');
  });
});

describe('RoomCapture — per-photo status (risk R5)', () => {
  it('lists every selected photograph by name', async () => {
    const { input } = renderCapture();
    await selectFiles(input, [photo('front-wall.jpg'), photo('skirting.jpg')]);

    await waitFor(() => {
      expect(screen.getByText('front-wall.jpg')).toBeDefined();
      expect(screen.getByText('skirting.jpg')).toBeDefined();
    });
  });

  it('marks each photograph sent once S3 has acknowledged it', async () => {
    const { input } = renderCapture();
    await selectFiles(input, [photo('a.jpg'), photo('b.jpg')]);

    await waitFor(() => {
      const sent = screen.getAllByText('Sent');
      expect(sent).toHaveLength(2);
    });
  });

  it('shows the downscaled size and dimensions per photograph', async () => {
    const { input } = renderCapture();
    await selectFiles(input, [photo('a.jpg')]);
    await waitFor(() => expect(screen.getByText(/1600×1200/)).toBeDefined());
  });

  it('shows a per-photo failure with its reason, not one aggregate error', async () => {
    const api = new DemoApiClient();
    vi.spyOn(api, 'uploadPhoto').mockRejectedValue(new Error('network unreachable'));
    const { input } = renderCapture({ api });

    await selectFiles(input, [photo('a.jpg')]);

    // Real backoff: 500ms then 1000ms before the photo is surfaced as failed.
    await waitFor(() => expect(screen.getByText('Not sent')).toBeDefined(), {
      timeout: 8000,
    });
    expect(screen.getByText(/network unreachable/)).toBeDefined();
  });

  it('keeps the photographs that succeeded when one fails', async () => {
    const api = new DemoApiClient();
    const real = api.uploadPhoto.bind(api);
    vi.spyOn(api, 'uploadPhoto').mockImplementation(async (upload, blob, options) => {
      if (upload.clientRef.endsWith('002')) throw new Error('cursed');
      return real(upload, blob, options);
    });
    const { input } = renderCapture({ api });

    await selectFiles(input, [photo('a.jpg'), photo('b.jpg'), photo('c.jpg')]);

    await waitFor(
      () => {
        expect(screen.getAllByText('Sent')).toHaveLength(2);
        expect(screen.getAllByText('Not sent')).toHaveLength(1);
      },
      { timeout: 8000 },
    );
  });
});

describe('RoomCapture — retry', () => {
  it('offers a retry on a failed photograph and recovers it', async () => {
    const api = new DemoApiClient();
    const real = api.uploadPhoto.bind(api);
    let failing = true;
    vi.spyOn(api, 'uploadPhoto').mockImplementation(async (upload, blob, options) => {
      if (failing) throw new Error('network unreachable');
      return real(upload, blob, options);
    });
    const { input } = renderCapture({ api });

    await selectFiles(input, [photo('a.jpg')]);
    await waitFor(() => expect(screen.getByText('Not sent')).toBeDefined(), {
      timeout: 8000,
    });

    failing = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    await waitFor(() => expect(screen.getByText('Sent')).toBeDefined());
  });

  it('offers a single retry-all after a batch fails', async () => {
    const api = new DemoApiClient();
    const real = api.uploadPhoto.bind(api);
    let failing = true;
    vi.spyOn(api, 'uploadPhoto').mockImplementation(async (upload, blob, options) => {
      if (failing) throw new Error('network unreachable');
      return real(upload, blob, options);
    });
    const { input } = renderCapture({ api });

    await selectFiles(input, [photo('a.jpg'), photo('b.jpg')]);
    await waitFor(() => expect(screen.getAllByText('Not sent')).toHaveLength(2), {
      timeout: 12000,
    });

    failing = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry all 2/ }));
    });

    await waitFor(() => expect(screen.getAllByText('Sent')).toHaveLength(2));
  });

  it('shows no retry affordance when nothing has failed', async () => {
    const { input } = renderCapture();
    await selectFiles(input, [photo('a.jpg')]);
    await waitFor(() => expect(screen.getByText('Sent')).toBeDefined());
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });
});

describe('RoomCapture — batching and callbacks', () => {
  it('chunks a large selection to the presign batch limit', async () => {
    const api = new DemoApiClient();
    const spy = vi.spyOn(api, 'presignPhotos');
    const { input } = renderCapture({ api });

    await selectFiles(
      input,
      Array.from({ length: 12 }, (_, i) => photo(`p${i}.jpg`)),
    );

    await waitFor(() => expect(screen.getAllByText('Sent')).toHaveLength(12));
    for (const call of spy.mock.calls) {
      expect(call[1].files.length).toBeLessThanOrEqual(10);
    }
  });

  it('tells the caller when a batch settles, so the aggregate can be re-fetched', async () => {
    const onUploaded = vi.fn();
    const { input } = renderCapture({ onUploaded });

    await selectFiles(input, [photo('a.jpg'), photo('b.jpg')]);

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(2));
  });

  /**
   * Regression: this callback used to forward the queue's cumulative
   * `uploadedCount`. A caller reconciling it against the server's room counter
   * as `countBefore + sent` over-counted from the second selection onward and
   * waited for photographs that were never coming.
   */
  it('reports only the photographs of the current selection, not the running total', async () => {
    const onUploaded = vi.fn();
    const { input } = renderCapture({ onUploaded });

    await selectFiles(input, [photo('a.jpg'), photo('b.jpg')]);
    await waitFor(() => expect(onUploaded).toHaveBeenLastCalledWith(2));

    await selectFiles(input, [photo('c.jpg')]);
    await waitFor(() => expect(onUploaded).toHaveBeenLastCalledWith(1));

    // Three photographs are on screen as sent; the last report is still 1.
    await waitFor(() => expect(screen.getAllByText('Sent')).toHaveLength(3));
    expect(onUploaded).toHaveBeenLastCalledWith(1);
  });

  it('reports zero when a whole selection fails, so nothing is expected of the server', async () => {
    const api = new DemoApiClient();
    vi.spyOn(api, 'uploadPhoto').mockRejectedValue(new Error('network unreachable'));
    const onUploaded = vi.fn();
    const { input } = renderCapture({ api, onUploaded });

    await selectFiles(input, [photo('a.jpg')]);

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(0), { timeout: 8000 });
  });

  it('reports only the recovered photographs after a retry', async () => {
    const api = new DemoApiClient();
    const real = api.uploadPhoto.bind(api);
    let failing = true;
    vi.spyOn(api, 'uploadPhoto').mockImplementation(async (upload, blob, options) => {
      if (failing) throw new Error('network unreachable');
      return real(upload, blob, options);
    });
    const onUploaded = vi.fn();
    const { input } = renderCapture({ api, onUploaded });

    await selectFiles(input, [photo('a.jpg')]);
    await waitFor(() => expect(screen.getByText('Not sent')).toBeDefined(), { timeout: 8000 });
    expect(onUploaded).toHaveBeenLastCalledWith(0);

    failing = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    await waitFor(() => expect(onUploaded).toHaveBeenLastCalledWith(1));
  });

  it('ignores an empty selection', async () => {
    const onUploaded = vi.fn();
    const { input } = renderCapture({ onUploaded });
    await selectFiles(input, []);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('clears the input so the same photograph can be chosen again', async () => {
    const { input } = renderCapture();
    await selectFiles(input, [photo('a.jpg')]);
    await waitFor(() => expect(screen.getByText('Sent')).toBeDefined());
    expect(input.value).toBe('');
  });
});
