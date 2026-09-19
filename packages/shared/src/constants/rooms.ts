/**
 * Room presets — the default room list offered at tenancy setup.
 * architecture.md §14 (`constants/ — room presets`), §5.1 (guided room
 * checklist), A2 (average tenancy = 6 rooms).
 *
 * `orderIndex` is the capture order and is preserved at move-out so the
 * compare view pairs rooms in the same sequence the tenant walked them (§8.2).
 * `defaultSelected` marks the six that make up the A2 average tenancy; the rest
 * are offered but unchecked.
 */
export interface RoomPreset {
  readonly key: string;
  readonly label: string;
  readonly orderIndex: number;
  readonly defaultSelected: boolean;
}

export const ROOM_PRESETS: readonly RoomPreset[] = [
  { key: 'living_room', label: 'Living Room', orderIndex: 0, defaultSelected: true },
  { key: 'kitchen', label: 'Kitchen', orderIndex: 1, defaultSelected: true },
  { key: 'bedroom_1', label: 'Bedroom 1', orderIndex: 2, defaultSelected: true },
  { key: 'bedroom_2', label: 'Bedroom 2', orderIndex: 3, defaultSelected: true },
  { key: 'bathroom_1', label: 'Bathroom 1', orderIndex: 4, defaultSelected: true },
  { key: 'balcony', label: 'Balcony', orderIndex: 5, defaultSelected: true },
  { key: 'bedroom_3', label: 'Bedroom 3', orderIndex: 6, defaultSelected: false },
  { key: 'bathroom_2', label: 'Bathroom 2', orderIndex: 7, defaultSelected: false },
  { key: 'dining_room', label: 'Dining Room', orderIndex: 8, defaultSelected: false },
  { key: 'study', label: 'Study', orderIndex: 9, defaultSelected: false },
  { key: 'utility', label: 'Utility Area', orderIndex: 10, defaultSelected: false },
  { key: 'entrance', label: 'Entrance / Foyer', orderIndex: 11, defaultSelected: false },
  { key: 'staircase', label: 'Staircase', orderIndex: 12, defaultSelected: false },
  { key: 'parking', label: 'Parking', orderIndex: 13, defaultSelected: false },
  { key: 'terrace', label: 'Terrace', orderIndex: 14, defaultSelected: false },
] as const;

/** The six preselected rooms — what the setup form shows checked. */
export const DEFAULT_ROOM_PRESETS: readonly RoomPreset[] = ROOM_PRESETS.filter(
  (r) => r.defaultSelected,
);

/** Preset lookup by key, for room-label normalisation (§9.1 — no model). */
export const ROOM_PRESET_BY_KEY: Readonly<Record<string, RoomPreset>> = Object.freeze(
  Object.fromEntries(ROOM_PRESETS.map((r) => [r.key, r])),
);
