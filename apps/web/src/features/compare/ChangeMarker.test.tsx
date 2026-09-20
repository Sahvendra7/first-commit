import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { diffAdditionSchema } from '@handover/shared';
import { toDiffAddition } from '../../lib/marked-change.js';
import type { MarkedChange } from '../../lib/marked-change.js';
import { ChangeMarker } from './ChangeMarker.js';

afterEach(cleanup);

const IMAGE = {
  imageUrl: 'https://example.invalid/after.jpg',
  imageAlt: 'Living Room at move-out',
};

const EXISTING: MarkedChange = {
  id: 'm1',
  type: 'STAIN',
  surface: 'WALL',
  location: 'wall left of the window',
  description: 'Dark patch about 20cm across.',
  box: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 },
};

function sizeFrame(frame: HTMLElement, width = 400, height = 300) {
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

function renderMarker(props: Partial<React.ComponentProps<typeof ChangeMarker>> = {}) {
  const onMarksChange = props.onMarksChange ?? vi.fn();
  const utils = render(
    <ChangeMarker
      {...IMAGE}
      imageAspect={4 / 3}
      marks={props.marks ?? []}
      onMarksChange={onMarksChange}
      makeId={props.makeId ?? (() => 'new-mark')}
      {...props}
    />,
  );
  const frame = screen.getByTestId('marker-frame');
  sizeFrame(frame);
  return { ...utils, frame, onMarksChange };
}

/** Draws a box from (x1,y1) to (x2,y2) in a 400x300 frame. */
function drawBox(frame: HTMLElement, x1: number, y1: number, x2: number, y2: number) {
  fireEvent.pointerDown(frame, { clientX: x1, clientY: y1, pointerId: 1, pointerType: 'mouse', button: 0 });
  fireEvent.pointerMove(frame, { clientX: x2, clientY: y2, pointerId: 1, pointerType: 'mouse' });
  fireEvent.pointerUp(frame, { clientX: x2, clientY: y2, pointerId: 1, pointerType: 'mouse' });
}

function fillForm(location: string, description: string) {
  fireEvent.change(screen.getByLabelText(/Where in the room/), { target: { value: location } });
  fireEvent.change(screen.getByLabelText(/What changed/), { target: { value: description } });
}

describe('ChangeMarker — drawing a box', () => {
  it('shows the photograph being marked', () => {
    renderMarker();
    expect(screen.getByAltText('Living Room at move-out')).toBeDefined();
  });

  it('draws a live box while the pointer is down', () => {
    const { frame } = renderMarker();
    fireEvent.pointerDown(frame, { clientX: 40, clientY: 30, pointerId: 1, pointerType: 'mouse', button: 0 });
    fireEvent.pointerMove(frame, { clientX: 200, clientY: 180, pointerId: 1, pointerType: 'mouse' });

    const draft = screen.getByTestId('draft-box');
    expect(draft.style.left).toBe('10%');
    expect(draft.style.top).toBe('10%');
  });

  it('opens the form once the box is released', () => {
    const { frame } = renderMarker();
    drawBox(frame, 40, 30, 200, 180);
    expect(screen.getByTestId('mark-form')).toBeDefined();
    expect(screen.queryByTestId('draft-box')).toBeNull();
  });

  it('works when the box is dragged up and to the left', () => {
    const { frame } = renderMarker();
    drawBox(frame, 200, 180, 40, 30);
    expect(screen.getByTestId('mark-form')).toBeDefined();
  });

  it('ignores a stray tap, which would put noise into the record', () => {
    const { frame } = renderMarker();
    drawBox(frame, 100, 100, 101, 101);
    expect(screen.queryByTestId('mark-form')).toBeNull();
  });

  it('seeds the location field as an editable suggestion', () => {
    const { frame } = renderMarker();
    drawBox(frame, 20, 20, 120, 110);
    const location = screen.getByLabelText(/Where in the room/) as HTMLInputElement;
    expect(location.value).toBe('upper left of the frame');

    fireEvent.change(location, { target: { value: 'behind the sofa' } });
    expect(location.value).toBe('behind the sofa');
  });

  it('disables touch scrolling so a drag does not scroll the page', () => {
    const { frame } = renderMarker();
    expect(frame.style.touchAction).toBe('none');
  });
});

describe('ChangeMarker — adding a change', () => {
  it('adds a mark carrying the drawn box and the typed prose', () => {
    const onMarksChange = vi.fn();
    const { frame } = renderMarker({ onMarksChange });

    drawBox(frame, 40, 30, 200, 180);
    fillForm('wall left of the window', 'Dark patch about 20cm across.');
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));

    expect(onMarksChange).toHaveBeenCalledTimes(1);
    const [added] = onMarksChange.mock.calls[0]![0] as MarkedChange[];
    expect(added!.location).toBe('wall left of the window');
    expect(added!.description).toBe('Dark patch about 20cm across.');
    expect(added!.box).toBeDefined();
  });

  it('offers every change type the contract defines', () => {
    const { frame } = renderMarker();
    drawBox(frame, 40, 30, 200, 180);
    const select = screen.getByLabelText(/What kind of change/) as HTMLSelectElement;
    expect(select.options.length).toBe(13);
    expect([...select.options].map((o) => o.value)).toContain('WATER_DAMAGE');
  });

  it('offers surface as optional, defaulting to unspecified', () => {
    const { frame } = renderMarker();
    drawBox(frame, 40, 30, 200, 180);
    const select = screen.getByLabelText(/Surface/) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect([...select.options].map((o) => o.value)).toContain('SANITARYWARE');
  });

  it('records the chosen type and surface', () => {
    const onMarksChange = vi.fn();
    const { frame } = renderMarker({ onMarksChange });

    drawBox(frame, 40, 30, 200, 180);
    fireEvent.change(screen.getByLabelText(/What kind of change/), {
      target: { value: 'CRACK' },
    });
    fireEvent.change(screen.getByLabelText(/Surface/), { target: { value: 'CEILING' } });
    fillForm('above the door', 'Hairline crack running 30cm.');
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));

    const [added] = onMarksChange.mock.calls[0]![0] as MarkedChange[];
    expect(added!.type).toBe('CRACK');
    expect(added!.surface).toBe('CEILING');
  });

  it('trims what it stores', () => {
    const onMarksChange = vi.fn();
    const { frame } = renderMarker({ onMarksChange });
    drawBox(frame, 40, 30, 200, 180);
    fillForm('  by the door  ', '  Scuffed.  ');
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));

    const [added] = onMarksChange.mock.calls[0]![0] as MarkedChange[];
    expect(added!.location).toBe('by the door');
    expect(added!.description).toBe('Scuffed.');
  });

  it('appends rather than replacing existing marks', () => {
    const onMarksChange = vi.fn();
    const { frame } = renderMarker({ marks: [EXISTING], onMarksChange });

    drawBox(frame, 40, 30, 200, 180);
    fillForm('by the door', 'Scuffed.');
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));

    expect((onMarksChange.mock.calls[0]![0] as MarkedChange[]).map((m) => m.id)).toEqual([
      'm1',
      'new-mark',
    ]);
  });

  it('closes the form after a successful add', () => {
    const { frame } = renderMarker();
    drawBox(frame, 40, 30, 200, 180);
    fillForm('by the door', 'Scuffed.');
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
    expect(screen.queryByTestId('mark-form')).toBeNull();
  });

  it('abandons the draft on cancel', () => {
    const onMarksChange = vi.fn();
    const { frame } = renderMarker({ onMarksChange });
    drawBox(frame, 40, 30, 200, 180);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByTestId('mark-form')).toBeNull();
    expect(onMarksChange).not.toHaveBeenCalled();
  });
});

describe('ChangeMarker — authoring without drawing', () => {
  it('opens the same form from a single button', () => {
    renderMarker();
    fireEvent.click(screen.getByRole('button', { name: /without drawing/i }));
    expect(screen.getByTestId('mark-form')).toBeDefined();
  });

  it('adds a change with no box, which the contract has never required', () => {
    const onMarksChange = vi.fn();
    renderMarker({ onMarksChange });

    fireEvent.click(screen.getByRole('button', { name: /without drawing/i }));
    fillForm('by the front door', 'Handle is loose.');
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));

    const [added] = onMarksChange.mock.calls[0]![0] as MarkedChange[];
    expect(added!.box).toBeUndefined();
    expect(() => diffAdditionSchema.parse(toDiffAddition(added!))).not.toThrow();
  });

  it('leaves the location empty rather than guessing at a position', () => {
    renderMarker();
    fireEvent.click(screen.getByRole('button', { name: /without drawing/i }));
    expect((screen.getByLabelText(/Where in the room/) as HTMLInputElement).value).toBe('');
  });
});

describe('ChangeMarker — validation mirrors the contract', () => {
  it('refuses a change with no description', () => {
    const onMarksChange = vi.fn();
    const { frame } = renderMarker({ onMarksChange });

    drawBox(frame, 40, 30, 200, 180);
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));

    expect(onMarksChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Describe what changed');
  });

  it('refuses a change with no location', () => {
    const onMarksChange = vi.fn();
    renderMarker({ onMarksChange });

    fireEvent.click(screen.getByRole('button', { name: /without drawing/i }));
    fillForm('', 'Something changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));

    expect(onMarksChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').some((n) => n.textContent?.includes('where'))).toBe(true);
  });

  it('bounds the fields at the contract limits', () => {
    const { frame } = renderMarker();
    drawBox(frame, 40, 30, 200, 180);
    expect((screen.getByLabelText(/Where in the room/) as HTMLInputElement).maxLength).toBe(200);
    expect((screen.getByLabelText(/What changed/) as HTMLTextAreaElement).maxLength).toBe(600);
  });

  it('clears the error once the draft is fixed', () => {
    const { frame } = renderMarker();
    drawBox(frame, 40, 30, 200, 180);
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
    expect(screen.getByRole('alert')).toBeDefined();

    fillForm('by the door', 'Scuffed.');
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ChangeMarker — listing, editing and deleting', () => {
  it('lists existing marks with their prose', () => {
    renderMarker({ marks: [EXISTING] });
    expect(screen.getByText('Stain · Wall')).toBeDefined();
    expect(screen.getByText('wall left of the window')).toBeDefined();
    expect(screen.getByText('Dark patch about 20cm across.')).toBeDefined();
  });

  it('draws a numbered overlay box for each mark that has one', () => {
    renderMarker({ marks: [EXISTING] });
    const box = screen.getByTestId('mark-box-m1');
    expect(box.style.left).toBe('10%');
    expect(box.style.width).toBe('30%');
    expect(box.textContent).toBe('1');
  });

  it('draws no overlay for a mark that was never drawn', () => {
    const { box: _box, ...undrawn } = EXISTING;
    renderMarker({ marks: [undrawn] });
    expect(screen.queryByTestId('mark-box-m1')).toBeNull();
    expect(screen.getByTestId('mark-m1')).toBeDefined();
  });

  it('loads an existing mark into the form for editing', () => {
    renderMarker({ marks: [EXISTING] });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect((screen.getByLabelText(/Where in the room/) as HTMLInputElement).value).toBe(
      'wall left of the window',
    );
    expect((screen.getByLabelText(/What kind of change/) as HTMLSelectElement).value).toBe(
      'STAIN',
    );
    expect(screen.getByRole('button', { name: 'Save change' })).toBeDefined();
  });

  it('replaces the edited mark in place, keeping its box', () => {
    const onMarksChange = vi.fn();
    renderMarker({ marks: [EXISTING], onMarksChange });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fillForm('wall right of the window', 'Bigger than it first looked.');
    fireEvent.click(screen.getByRole('button', { name: 'Save change' }));

    const next = onMarksChange.mock.calls[0]![0] as MarkedChange[];
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe('m1');
    expect(next[0]!.location).toBe('wall right of the window');
    expect(next[0]!.box).toEqual(EXISTING.box);
  });

  it('deletes a mark', () => {
    const onMarksChange = vi.fn();
    renderMarker({ marks: [EXISTING], onMarksChange });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onMarksChange).toHaveBeenCalledWith([]);
  });

  it('closes the form if the mark being edited is deleted', () => {
    const { rerender } = renderMarker({ marks: [EXISTING], onMarksChange: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('mark-form')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    rerender(
      <ChangeMarker {...IMAGE} imageAspect={4 / 3} marks={[]} onMarksChange={vi.fn()} />,
    );
    expect(screen.queryByTestId('mark-form')).toBeNull();
  });

  it('numbers marks in list order', () => {
    const second: MarkedChange = { ...EXISTING, id: 'm2', description: 'Second thing.' };
    renderMarker({ marks: [EXISTING, second] });
    expect(screen.getByTestId('mark-box-m1').textContent).toBe('1');
    expect(screen.getByTestId('mark-box-m2').textContent).toBe('2');
  });

  it('shows no list when nothing has been marked', () => {
    renderMarker();
    expect(screen.queryByTestId('mark-list')).toBeNull();
  });
});

describe('ChangeMarker — letterboxed photographs', () => {
  it('maps a drag into image space, not frame space', () => {
    const onMarksChange = vi.fn();
    // A 16:9 photo in a 16:9 frame is unletterboxed; a 1:1 photo would be
    // pillarboxed. Use a square photo so the content rect is narrower than the
    // frame and the mapping has something to do.
    render(
      <ChangeMarker
        {...IMAGE}
        imageAspect={1}
        fallbackAspect={1}
        marks={[]}
        onMarksChange={onMarksChange}
        makeId={() => 'new-mark'}
      />,
    );
    const frame = screen.getByTestId('marker-frame');
    sizeFrame(frame, 400, 400);

    drawBox(frame, 0, 0, 200, 200);
    fillForm('somewhere', 'Something.');
    fireEvent.click(screen.getByRole('button', { name: 'Add change' }));

    const [added] = onMarksChange.mock.calls[0]![0] as MarkedChange[];
    // Square photo, square frame: no letterbox, so the box is the top-left quarter.
    expect(added!.box!.w).toBeCloseTo(0.5, 6);
    expect(added!.box!.h).toBeCloseTo(0.5, 6);
  });
});
