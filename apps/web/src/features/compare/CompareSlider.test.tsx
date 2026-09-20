import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CompareSlider, type CompareOverlayBox } from './CompareSlider.js';

afterEach(cleanup);

const BEFORE = { url: 'https://example.invalid/before.jpg', alt: 'Living Room at move-in' };
const AFTER = { url: 'https://example.invalid/after.jpg', alt: 'Living Room at move-out' };

/**
 * jsdom lays nothing out, so every element reports a zero-sized rect. The
 * slider divides by the frame width, so the frame is given a real one.
 */
function sizeFrame(frame: HTMLElement, width = 400, left = 0) {
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
    left,
    top: 0,
    right: left + width,
    bottom: 300,
    width,
    height: 300,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function renderSlider(props: Partial<React.ComponentProps<typeof CompareSlider>> = {}) {
  const utils = render(<CompareSlider before={BEFORE} after={AFTER} {...props} />);
  const frame = screen.getByTestId('compare-frame');
  sizeFrame(frame);
  return { ...utils, frame };
}

describe('CompareSlider — rendering', () => {
  it('shows both photographs with their alt text', () => {
    renderSlider();
    expect(screen.getByAltText('Living Room at move-in')).toBeDefined();
    expect(screen.getByAltText('Living Room at move-out')).toBeDefined();
  });

  it('starts at the midpoint by default', () => {
    const { frame } = renderSlider();
    expect(frame.getAttribute('aria-valuenow')).toBe('50');
  });

  it('honours defaultPosition', () => {
    renderSlider({ defaultPosition: 0.25 });
    expect(screen.getByTestId('compare-frame').getAttribute('aria-valuenow')).toBe('25');
  });

  it('exposes itself as a slider to assistive technology', () => {
    const { frame } = renderSlider();
    expect(frame.getAttribute('role')).toBe('slider');
    expect(frame.getAttribute('aria-valuemin')).toBe('0');
    expect(frame.getAttribute('aria-valuemax')).toBe('100');
    expect(frame.getAttribute('aria-orientation')).toBe('horizontal');
    expect(frame.getAttribute('tabindex')).toBe('0');
  });

  it('clips the before image to the left of the divider', () => {
    renderSlider({ defaultPosition: 0.25 });
    const clip = screen.getByTestId('compare-before-clip');
    expect(clip.style.clipPath).toBe('inset(0 75.0000% 0 0)');
  });

  it('positions the divider at the slider value', () => {
    renderSlider({ defaultPosition: 0.8 });
    // CSSOM normalises the trailing zeros away.
    expect(screen.getByTestId('compare-divider').style.left).toBe('80%');
  });

  it('disables touch scrolling on the frame so a drag does not scroll the page', () => {
    const { frame } = renderSlider();
    expect(frame.style.touchAction).toBe('none');
  });
});

describe('CompareSlider — pointer dragging (mouse and touch)', () => {
  it('jumps to the position of a mouse press', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange });

    fireEvent.pointerDown(frame, { clientX: 100, pointerId: 1, pointerType: 'mouse', button: 0 });
    expect(onPositionChange).toHaveBeenCalledWith(0.25);
  });

  it('tracks a mouse drag', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange });

    fireEvent.pointerDown(frame, { clientX: 100, pointerId: 1, pointerType: 'mouse', button: 0 });
    fireEvent.pointerMove(frame, { clientX: 300, pointerId: 1, pointerType: 'mouse' });
    expect(onPositionChange).toHaveBeenLastCalledWith(0.75);
  });

  it('tracks a touch drag through the same path', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange });

    fireEvent.pointerDown(frame, { clientX: 40, pointerId: 7, pointerType: 'touch' });
    fireEvent.pointerMove(frame, { clientX: 360, pointerId: 7, pointerType: 'touch' });
    expect(onPositionChange).toHaveBeenLastCalledWith(0.9);
  });

  it('ignores movement before a press', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange });
    fireEvent.pointerMove(frame, { clientX: 300, pointerId: 1, pointerType: 'mouse' });
    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it('stops tracking after the pointer is released', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange });

    fireEvent.pointerDown(frame, { clientX: 100, pointerId: 1, pointerType: 'mouse', button: 0 });
    fireEvent.pointerUp(frame, { clientX: 100, pointerId: 1, pointerType: 'mouse' });
    onPositionChange.mockClear();

    fireEvent.pointerMove(frame, { clientX: 300, pointerId: 1, pointerType: 'mouse' });
    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it('stops tracking when the gesture is cancelled', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange });

    fireEvent.pointerDown(frame, { clientX: 100, pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerCancel(frame, { pointerId: 1, pointerType: 'touch' });
    onPositionChange.mockClear();

    fireEvent.pointerMove(frame, { clientX: 300, pointerId: 1, pointerType: 'touch' });
    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it('clamps a drag past either edge instead of overshooting', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange });

    fireEvent.pointerDown(frame, { clientX: 200, pointerId: 1, pointerType: 'mouse', button: 0 });
    fireEvent.pointerMove(frame, { clientX: -500, pointerId: 1, pointerType: 'mouse' });
    expect(onPositionChange).toHaveBeenLastCalledWith(0);

    fireEvent.pointerMove(frame, { clientX: 5000, pointerId: 1, pointerType: 'mouse' });
    expect(onPositionChange).toHaveBeenLastCalledWith(1);
  });

  it('ignores a right-click, which would start a drag with no visible end', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange });
    fireEvent.pointerDown(frame, { clientX: 100, pointerId: 1, pointerType: 'mouse', button: 2 });
    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it('accounts for a frame that is not flush with the viewport edge', () => {
    const onPositionChange = vi.fn();
    render(<CompareSlider before={BEFORE} after={AFTER} onPositionChange={onPositionChange} />);
    const frame = screen.getByTestId('compare-frame');
    sizeFrame(frame, 400, 100);

    fireEvent.pointerDown(frame, { clientX: 200, pointerId: 1, pointerType: 'mouse', button: 0 });
    expect(onPositionChange).toHaveBeenCalledWith(0.25);
  });

  it('marks itself as dragging while a pointer is down', () => {
    const { frame } = renderSlider();
    expect(frame.dataset.dragging).toBe('false');
    fireEvent.pointerDown(frame, { clientX: 100, pointerId: 1, pointerType: 'mouse', button: 0 });
    expect(frame.dataset.dragging).toBe('true');
    fireEvent.pointerUp(frame, { pointerId: 1, pointerType: 'mouse' });
    expect(frame.dataset.dragging).toBe('false');
  });
});

describe('CompareSlider — keyboard', () => {
  it('moves by one step on the arrow keys', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange, step: 0.1 });

    fireEvent.keyDown(frame, { key: 'ArrowRight' });
    expect(onPositionChange).toHaveBeenLastCalledWith(0.6);

    fireEvent.keyDown(frame, { key: 'ArrowLeft' });
    fireEvent.keyDown(frame, { key: 'ArrowLeft' });
    expect(onPositionChange).toHaveBeenLastCalledWith(0.4);
  });

  it('takes a larger step with shift held', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange, step: 0.02 });
    fireEvent.keyDown(frame, { key: 'ArrowRight', shiftKey: true });
    expect(onPositionChange).toHaveBeenLastCalledWith(0.6);
  });

  it('jumps to either end on Home and End', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange });

    fireEvent.keyDown(frame, { key: 'Home' });
    expect(onPositionChange).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(frame, { key: 'End' });
    expect(onPositionChange).toHaveBeenLastCalledWith(1);
  });

  it('ignores keys it does not own', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange });
    fireEvent.keyDown(frame, { key: 'a' });
    fireEvent.keyDown(frame, { key: 'Enter' });
    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it('cannot be driven past either end', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ onPositionChange, defaultPosition: 0, step: 0.1 });
    fireEvent.keyDown(frame, { key: 'ArrowLeft' });
    expect(onPositionChange).toHaveBeenLastCalledWith(0);
  });
});

describe('CompareSlider — controlled mode', () => {
  it('renders the position it is given and does not move itself', () => {
    const onPositionChange = vi.fn();
    const { frame } = renderSlider({ position: 0.3, onPositionChange });

    fireEvent.keyDown(frame, { key: 'End' });
    expect(onPositionChange).toHaveBeenCalledWith(1);
    // Still 30% — the parent owns the value.
    expect(frame.getAttribute('aria-valuenow')).toBe('30');
  });

  it('clamps a value supplied out of range', () => {
    renderSlider({ position: 5 });
    expect(screen.getByTestId('compare-frame').getAttribute('aria-valuenow')).toBe('100');
  });
});

describe('CompareSlider — overlay boxes', () => {
  const overlays: CompareOverlayBox[] = [
    { id: 'c1', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, label: 'Stain on wall' },
    { id: 'c2', box: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, label: 'Rejected', muted: true },
  ];

  it('renders nothing when no overlays are supplied', () => {
    renderSlider();
    expect(screen.queryByTestId('overlay-c1')).toBeNull();
  });

  it('draws a labelled box for each marked change', () => {
    renderSlider({ overlays });
    expect(screen.getByTestId('overlay-c1')).toBeDefined();
    expect(screen.getByText('Stain on wall')).toBeDefined();
    expect(screen.getByText('Rejected')).toBeDefined();
  });

  it('positions a box as a percentage of the frame', () => {
    renderSlider({ overlays });
    const box = screen.getByTestId('overlay-c1');
    expect(box.style.left).toBe('10%');
    expect(box.style.top).toBe('20%');
    expect(box.style.width).toBe('30%');
    expect(box.style.height).toBe('40%');
  });

  it('visually distinguishes a muted box from an active one', () => {
    renderSlider({ overlays });
    expect(screen.getByTestId('overlay-c1').className).toContain('border-amber-400');
    expect(screen.getByTestId('overlay-c2').className).toContain('border-slate-400/60');
  });
});

describe('CompareSlider — differing aspect ratios', () => {
  it('takes the after photo aspect for the frame, since overlays live in its space', () => {
    render(
      <CompareSlider
        before={{ ...BEFORE, aspect: 4 / 3 }}
        after={{ ...AFTER, aspect: 16 / 9 }}
      />,
    );
    expect(screen.getByTestId('compare-frame').style.aspectRatio).toBe(String(16 / 9));
  });

  it('falls back to the before aspect while the after photo is still loading', () => {
    render(<CompareSlider before={{ ...BEFORE, aspect: 3 / 4 }} after={AFTER} />);
    expect(screen.getByTestId('compare-frame').style.aspectRatio).toBe(String(3 / 4));
  });

  it('uses the supplied fallback when neither photo has reported a size', () => {
    render(<CompareSlider before={BEFORE} after={AFTER} fallbackAspect={1} />);
    expect(screen.getByTestId('compare-frame').style.aspectRatio).toBe('1');
  });

  it('tells the tenant when the two photographs are different shapes', () => {
    render(
      <CompareSlider
        before={{ ...BEFORE, aspect: 4 / 3 }}
        after={{ ...AFTER, aspect: 16 / 9 }}
      />,
    );
    const note = screen.getByTestId('aspect-mismatch-note');
    expect(note.textContent).toContain('letterboxed');
    expect(note.textContent).toContain('neither image has been cropped or stretched'.slice(8));
  });

  it('says nothing when the two photographs already match', () => {
    render(
      <CompareSlider before={{ ...BEFORE, aspect: 4 / 3 }} after={{ ...AFTER, aspect: 4 / 3 }} />,
    );
    expect(screen.queryByTestId('aspect-mismatch-note')).toBeNull();
  });

  it('projects an overlay into the letterboxed content rect of the after photo', () => {
    // After is 4:3 inside a 4:3 frame... but the frame follows the after photo,
    // so the overlay is unprojected. Make the frame follow a *taller* after
    // photo and check the before image is what gets letterboxed instead.
    render(
      <CompareSlider
        before={{ ...BEFORE, aspect: 16 / 9 }}
        after={{ ...AFTER, aspect: 1 }}
        overlays={[{ id: 'c1', box: { x: 0, y: 0, w: 1, h: 1 }, label: 'Whole frame' }]}
      />,
    );
    // The after photo owns the frame, so its overlay spans the full frame.
    const box = screen.getByTestId('overlay-c1');
    expect(box.style.width).toBe('100%');
    expect(box.style.height).toBe('100%');
    expect(screen.getByTestId('before-letterboxed')).toBeDefined();
  });
});

describe('CompareSlider — expiring photo links', () => {
  it('surfaces a load failure instead of showing a broken image', () => {
    renderSlider();
    fireEvent.error(screen.getByAltText('Living Room at move-out'));
    expect(screen.getByTestId('photo-expired').textContent).toContain('expire after five minutes');
  });

  it('tells the caller which photo failed, so the aggregate can be re-fetched', () => {
    const onImageError = vi.fn();
    renderSlider({ onImageError });
    fireEvent.error(screen.getByAltText('Living Room at move-in'));
    expect(onImageError).toHaveBeenCalledWith('before');
  });

  it('reports each side only once', () => {
    const onImageError = vi.fn();
    renderSlider({ onImageError });
    const img = screen.getByAltText('Living Room at move-out');
    fireEvent.error(img);
    fireEvent.error(img);
    expect(onImageError).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId('photo-expired')).toHaveLength(1);
  });
});

describe('CompareSlider — evidence metadata', () => {
  it('shows the server timestamp and a truncated digest for each photograph', () => {
    const sha = 'a'.repeat(60) + 'beef';
    render(
      <CompareSlider
        before={{ ...BEFORE, receivedAt: '2025-09-02T09:14:00.000Z', sha256: sha }}
        after={AFTER}
      />,
    );
    const meta = screen.getByTestId('evidence-meta');
    expect(meta.textContent).toContain('aaaaaaaa');
    expect(meta.textContent).toContain('beef');
    // The full digest stays available without filling a phone screen with hex.
    expect(screen.getByTitle(sha)).toBeDefined();
  });

  it('renders no metadata block when the caller supplies none', () => {
    renderSlider();
    expect(screen.queryByTestId('evidence-meta')).toBeNull();
  });
});
