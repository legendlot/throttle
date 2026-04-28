// apps/garage/src/hooks/useProducts.js
// TD-020 resolution: single source of truth for LOT product/variant constants.
// Used by GRN, Receiving, and Dashboard pages.

export const PRODUCT_VARIANTS = {
  'Flare':    ['Track', 'Race', 'Underground', 'Street', 'Burnout'],
  'Flare LE': ['Race'],
  'Ghost':    ['Burnout', 'Street', 'Underground'],
  'Knox':     ['Adventure', 'Explorer'],
  'Shadow':   ['Asphalt', 'Tarmac'],
  'Nitro':    ['Race Grey', 'Race Blue', 'Tarmac Black', 'Tarmac Green', 'Tarmac Grey', 'Burnout Red'],
  'Dash':     ['Street White', 'Green', 'Black', 'Blue', 'Silver', 'Urban Red', 'Urban White', 'Sports Yellow', 'Sports Blue'],
  'Fang':     ['Common'],
  'Atlas':    ['Common'],
};

export const PRODUCT_SUBVARIANTS = {
  'Flare': {
    'Track':       ['Pink', 'White'],
    'Race':        ['Grey', 'Black'],
    'Underground': ['Silver', 'Blue'],
    'Street':      ['White', 'Red'],
    'Burnout':     ['Grey', 'Green', 'Red'],
  },
  'Flare LE': {
    'Race': ['Black'],
  },
  'Ghost': {
    'Burnout':     ['Red', 'Yellow'],
    'Street':      ['Blue', 'White'],
    'Underground': ['Black', 'White'],
  },
  'Knox': {
    'Adventure': ['Black', 'Green'],
    'Explorer':  ['Black', 'Blue'],
  },
  'Shadow': {
    'Tarmac':  ['Black', 'Red'],
    'Asphalt': ['Black', 'Silver'],
  },
  'Nitro':    {},
  'Dash':     {},
  'Fang':     {},
  'Atlas':    {},
};

export const PRODUCTS = Object.keys(PRODUCT_VARIANTS);

// Products that ship with a separate remote unit (FBU receive creates car + remote lines)
export const HAS_REMOTE = new Set(['Dash', 'Nitro', 'Flare LE']);

export function useProducts() {
  return { PRODUCTS, PRODUCT_VARIANTS, PRODUCT_SUBVARIANTS, HAS_REMOTE };
}
