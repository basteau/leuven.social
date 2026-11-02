/**
 * What a shop front sells, read off its OpenStreetMap tags, as one of the few kinds the scene
 * draws differently (a frituur's striped awning, a café's warm windows, a pharmacy's green cross).
 * Pure tables: the bake reads them, the city file stores a kind as its place in `SHOP_KINDS`.
 */

type Tags = Record<string, string | undefined>;

/** The kinds, in the order the city file numbers them. Append only: the number is the format. */
export const SHOP_KINDS = [
  'frituur',
  'cafe',
  'bar',
  'restaurant',
  'snack',
  'bakery',
  'icecream',
  /** Groceries: supermarkets, corner shops, butchers, greengrocers, delis, wine. */
  'food',
  'pharmacy',
  'bank',
  'books',
  'fashion',
  'bicycle',
  /** A counter, not a display: hairdressers, opticians, phone shops, travel agents, laundries. */
  'service',
  /** Any other shop. */
  'shop',
] as const;
export type ShopKind = (typeof SHOP_KINDS)[number];

/** A frituur's `cuisine`: one of these among its `;`-separated values. */
const FRIES = /(^|;)\s*(friture|fries|frieten|frites)\s*(;|$)/i;
/** A fast-food place named for its chips, whatever its `cuisine` says. */
const FRIES_NAME = /\b(frit|friet|frituur)/i;

const BY_AMENITY: Record<string, ShopKind> = {
  cafe: 'cafe',
  bar: 'bar',
  pub: 'bar',
  biergarten: 'bar',
  restaurant: 'restaurant',
  fast_food: 'snack',
  ice_cream: 'icecream',
  pharmacy: 'pharmacy',
  bank: 'bank',
};

const BY_SHOP: Record<string, ShopKind> = {
  bakery: 'bakery',
  pastry: 'bakery',
  confectionery: 'bakery',
  chocolate: 'bakery',
  ice_cream: 'icecream',
  coffee: 'cafe',
  tea: 'cafe',
  supermarket: 'food',
  convenience: 'food',
  butcher: 'food',
  greengrocer: 'food',
  deli: 'food',
  cheese: 'food',
  alcohol: 'food',
  wine: 'food',
  beverages: 'food',
  seafood: 'food',
  farm: 'food',
  // A drugstore (Kruidvat), not a pharmacy: no green cross.
  chemist: 'shop',
  books: 'books',
  stationery: 'books',
  comics: 'books',
  newsagent: 'books',
  clothes: 'fashion',
  shoes: 'fashion',
  boutique: 'fashion',
  jewelry: 'fashion',
  bag: 'fashion',
  fashion_accessories: 'fashion',
  bicycle: 'bicycle',
  hairdresser: 'service',
  beauty: 'service',
  optician: 'service',
  mobile_phone: 'service',
  telecommunication: 'service',
  travel_agency: 'service',
  laundry: 'service',
  dry_cleaning: 'service',
  tattoo: 'service',
  massage: 'service',
  copyshop: 'service',
};

/** `shop` values that mean no shop is open there. */
const CLOSED = new Set(['vacant', 'no', 'disused']);

const lookup = (table: Record<string, ShopKind>, value: string | undefined) =>
  value !== undefined && Object.hasOwn(table, value) ? table[value] : undefined;

/**
 * The kind of shop front OSM's tags describe, or null for none. A frituur is fast food whose
 * `cuisine` lists friture or fries, or whose name says so (`Fritboutique`, `De Frittoerist`).
 */
export function shopKind(tags: Tags): ShopKind | null {
  const { amenity, shop, craft } = tags;
  if (
    amenity === 'fast_food' &&
    (FRIES.test(tags.cuisine ?? '') || FRIES_NAME.test(tags.name ?? ''))
  ) {
    return 'frituur';
  }
  const kind = lookup(BY_AMENITY, amenity);
  if (kind) return kind;
  if (shop !== undefined && !CLOSED.has(shop)) return lookup(BY_SHOP, shop) ?? 'shop';
  if (craft === 'bakery' || craft === 'confectionery') return 'bakery';
  return null;
}

/**
 * Which of several fronts in one building it shows: the most telling first, so a frituur under
 * a block of flats with a hairdresser beside it reads as the frituur.
 */
const PRIORITY: readonly ShopKind[] = [
  'frituur',
  'bakery',
  'icecream',
  'pharmacy',
  'cafe',
  'bar',
  'bicycle',
  'books',
  'snack',
  'restaurant',
  'food',
  'fashion',
  'bank',
  'service',
  'shop',
];

/** Where a kind stands in that order: a building's main front is the one ranked first. */
export const rank = (kind: ShopKind): number => PRIORITY.indexOf(kind);
