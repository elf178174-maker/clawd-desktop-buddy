// Clawd's anatomy in "art units" (u). One art unit is one pixel of the reference sprite.
// Coordinates are y-up with the origin on the ground, centred between the feet.
//
// Reference sprite (12 x 8 units, eyes are the black squares):
//
//   ..########..
//   ..#.####.#..
//   ############
//   ############
//   ..########..
//   ..########..
//   ..#.#..#.#..
//   ..#.#..#.#..

export const PALETTE = {
  body: '#D77757',
  eye: '#141210',
  shadow: 'rgba(0, 0, 0, 0.22)',
  cream: '#F4ECE1',
  ink: '#241713',
  laptopLid: '#3B3936',
  laptopEdge: '#57534D',
  laptopBase: '#2B2927',
  wave: '#F4ECE1',
} as const

export const BODY = { left: -4, right: 4, bottom: 2, height: 6 } as const

/** Leg column centres; every leg is one unit wide and two units tall. */
export const LEG_X = [-3.5, -1.5, 1.5, 3.5] as const
export const LEG = { width: 1, height: 2 } as const

/** Arm nubs: two units long, two units tall, rows 2-3 counted from the top of the body. */
export const ARM = { length: 2, height: 2, fromBodyBottom: 2 } as const

/** Eyes: one unit squares on row 1, columns 1 and 6 of the body. */
export const EYE = { size: 1, dx: 2.5, fromBodyBottom: 4.5 } as const

/** Bounding box of the neutral sprite, used for layout and hit testing. */
export const SPRITE_BOUNDS = { left: -6, right: 6, bottom: 0, top: 8 } as const
