/**
 * What a shop front sells, read off its OpenStreetMap tags, as one of the few kinds the scene
 * draws differently (a frituur's striped awning, a café's warm windows, a pharmacy's green cross),
 * and the public places that show what they are by their door the same way (a university's blue
 * banner, a hotel's flags). Pure tables: the bake reads them, the city file stores a kind as its
 * place in `SHOP_KINDS`.
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
  /** Groceries: supermarkets, corner shops, butchers, delis, wine. */
  'food',
  'pharmacy',
  'bank',
  'books',
  'fashion',
  'bicycle',
  /** A counter, not a display: beauty salons, opticians, phone shops, travel agents, laundries. */
  'service',
  /** Any other shop. */
  'shop',
  /** Hairdressers and barbers, out of `service`: they have a pole by the door. */
  'hairdresser',
  /** Out of `food`: crates of fruit and vegetables on the pavement. */
  'greengrocer',
  /** Buckets of flowers on the pavement. */
  'florist',
  // Public places from here on (`PLACES`): a sign by the door, but no shop window.
  /** KU Leuven's faculties, institutes and halls, and the colleges. */
  'university',
  /** Schools and nurseries. */
  'school',
  /** Hotels, hostels and guest houses. */
  'hotel',
  'museum',
  'library',
  'cinema',
  'theatre',
  'hospital',
  /** Sports halls and centres. */
  'sports',
  // More shops, each with a sign of its own instead of the catch-all's (`PLACES` names the rest).
  /** Gifts, souvenirs and second-hand knick-knacks. */
  'gift',
  /** Galleries, antiques, picture framers. */
  'art',
  /** Furniture and things for the home. */
  'home',
  /** Beauty salons, cosmetics, massage, tattoos. */
  'beauty',
  'optician',
  'laundry',
  /** Mobile phones and their contracts. */
  'phone',
  /** Electronics, computers, photo. */
  'electronics',
  'travel',
  /** DIY, keys, repairs, what a handyman buys. */
  'hardware',
  'copyshop',
  'music',
  /** Toys, games, hobbies, babies' things. */
  'toys',
  /** Sports gear and outdoor clothes (the place `sports` is a hall). */
  'sportshop',
  /** A drugstore or medical supplier, not a pharmacy. */
  'drugstore',
  /** Kiosks, tobacco, tickets, lottery. */
  'kiosk',
  // And more public places.
  /** Doctors and dentists: a sign, no flag. */
  'clinic',
  /** Churches and chapels: a sign, no flag. */
  'worship',
  /** The town hall, the courthouse, community centres, public buildings. */
  'civic',
  /** Student residences, the kots. A sign, no flag. */
  'dorm',
] as const;
export type ShopKind = (typeof SHOP_KINDS)[number];

/** The public places among the kinds: a sign by the door, no shop window, no awning. */
export const PLACES: ReadonlySet<ShopKind> = new Set<ShopKind>([
  'university',
  'school',
  'hotel',
  'museum',
  'library',
  'cinema',
  'theatre',
  'hospital',
  'sports',
  'clinic',
  'worship',
  'civic',
  'dorm',
]);

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
  greengrocer: 'greengrocer',
  florist: 'florist',
  deli: 'food',
  cheese: 'food',
  alcohol: 'food',
  wine: 'food',
  beverages: 'food',
  seafood: 'food',
  farm: 'greengrocer',
  // A drugstore (Kruidvat), not a pharmacy: no green cross.
  chemist: 'drugstore',
  medical_supply: 'drugstore',
  hearing_aids: 'drugstore',
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
  hairdresser: 'hairdresser',
  barber: 'hairdresser',
  beauty: 'beauty',
  cosmetics: 'beauty',
  perfumery: 'beauty',
  massage: 'beauty',
  tattoo: 'beauty',
  piercing: 'beauty',
  optician: 'optician',
  laundry: 'laundry',
  dry_cleaning: 'laundry',
  ironingshop: 'laundry',
  mobile_phone: 'phone',
  telecommunication: 'phone',
  gps_and_communication: 'phone',
  electronics: 'electronics',
  computer: 'electronics',
  hifi: 'electronics',
  photo: 'electronics',
  travel_agency: 'travel',
  copyshop: 'copyshop',
  printing: 'copyshop',
  gift: 'gift',
  craft: 'gift',
  charity: 'gift',
  second_hand: 'gift',
  art: 'art',
  antiques: 'art',
  frame: 'art',
  furniture: 'home',
  interior_decoration: 'home',
  houseware: 'home',
  household: 'home',
  kitchen: 'home',
  bathroom_furnishing: 'home',
  bed: 'home',
  curtain: 'home',
  lighting: 'home',
  home_decoration: 'home',
  flooring: 'hardware',
  doityourself: 'hardware',
  hardware: 'hardware',
  locksmith: 'hardware',
  keys: 'hardware',
  glaziery: 'hardware',
  glass_design: 'hardware',
  repair: 'hardware',
  shoe_repair: 'hardware',
  tool_hire: 'hardware',
  car: 'hardware',
  car_repair: 'hardware',
  motorcycle: 'hardware',
  music: 'music',
  musical_instrument: 'music',
  toys: 'toys',
  games: 'toys',
  hobby: 'toys',
  baby_goods: 'toys',
  sports: 'sportshop',
  outdoor: 'sportshop',
  kiosk: 'kiosk',
  tobacco: 'kiosk',
  ticket: 'kiosk',
  lottery: 'kiosk',
  bookmaker: 'kiosk',
  'e-cigarette': 'kiosk',
  fabric: 'fashion',
  sewing: 'fashion',
  tailor: 'fashion',
  leather: 'fashion',
  estate_agent: 'service',
  funeral_directors: 'service',
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
  // A `shop` listing several (`home_decoration;linen`) is its first.
  const value = shop?.split(';')[0]?.trim();
  if (value !== undefined && !CLOSED.has(value)) return lookup(BY_SHOP, value) ?? 'shop';
  if (craft === 'bakery' || craft === 'confectionery') return 'bakery';
  return null;
}

/** Public places by OSM's `amenity`, `tourism`, `leisure` or `building` value. */
const BY_PLACE: Record<string, ShopKind> = {
  place_of_worship: 'worship',
  church: 'worship',
  chapel: 'worship',
  townhall: 'civic',
  courthouse: 'civic',
  public_building: 'civic',
  public: 'civic',
  civic: 'civic',
  government: 'civic',
  government_office: 'civic',
  community_centre: 'civic',
  events_venue: 'civic',
  arts_centre: 'civic',
  social_facility: 'civic',
  police: 'civic',
  fire_station: 'civic',
  post_office: 'civic',
  dormitory: 'dorm',
  doctors: 'clinic',
  dentist: 'clinic',
  clinic: 'clinic',
  university: 'university',
  college: 'university',
  school: 'school',
  kindergarten: 'school',
  hotel: 'hotel',
  hostel: 'hotel',
  guest_house: 'hotel',
  motel: 'hotel',
  museum: 'museum',
  library: 'library',
  cinema: 'cinema',
  theatre: 'theatre',
  hospital: 'hospital',
  sports_centre: 'sports',
  sports_hall: 'sports',
};

/**
 * The public place OSM's tags describe, on a point, a building or the site round it: an
 * `amenity` first, then `tourism`, `leisure`, and the `building` value. Null for none.
 */
export function placeKind(tags: Tags): ShopKind | null {
  // Worship with a religion of its own has no sign of ours to say so: a cross would be wrong.
  if (tags.amenity === 'place_of_worship' && (tags.religion ?? 'christian') !== 'christian') {
    return null;
  }
  for (const key of ['amenity', 'tourism', 'leisure', 'building', 'office']) {
    const kind = lookup(BY_PLACE, tags[key]);
    if (kind) return kind;
  }
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
  'greengrocer',
  'florist',
  'drugstore',
  'optician',
  'beauty',
  'phone',
  'electronics',
  'laundry',
  'hardware',
  'music',
  'toys',
  'gift',
  'art',
  'sportshop',
  'home',
  'travel',
  'copyshop',
  'kiosk',
  'hairdresser',
  'service',
  'shop',
  // A building's places come after its shops: its main front is a shop's.
  'university',
  'school',
  'hospital',
  'clinic',
  'library',
  'museum',
  'theatre',
  'cinema',
  'hotel',
  'sports',
  'civic',
  'worship',
  'dorm',
];

/** Where a kind stands in that order: a building's main front is the one ranked first. */
export const rank = (kind: ShopKind): number => PRIORITY.indexOf(kind);
