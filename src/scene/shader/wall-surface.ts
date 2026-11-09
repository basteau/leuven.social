import {
  BAYS_PER_PAGE,
  BAY_MAX,
  BAY_MIN,
  BAY_SPREAD,
  LANCET_BAY,
  NICHE_BAY,
} from '../facade-bays.ts';
import { LANCETS, ORNATE, SHOP_FRONT } from '../facade-codes.ts';
import { f } from './glsl.ts';

/**
 * What a wall is made of, shared by the walls with windows and the plain ones (gables, sheds,
 * towers): brick in running bond with each brick its own tone, render with a fine speckle, dressed
 * stone in courses, and the slow weathering of all of them. Each fades before it is finer than a
 * couple of pixels.
 */
const WALL_SKIN = `void wallSkin(inout vec3 albedo, vec2 p, float pixel, float isBrick, float isRender, float seed, float solid) {
  vec2 brickAt = p / vec2(0.7, 0.3);
  brickAt.x += 0.5 * mod(floor(brickAt.y), 2.0);
  vec2 bond = fract(brickAt);
  float mortar = max(step(bond.x, 0.06), step(bond.y, 0.14));
  float tone = hash2(floor(brickAt) + vec2(seed * 40.0));
  float fine = (1.0 - smoothstep(0.05, 0.1, pixel)) * solid;
  albedo *= 1.0 + isBrick * fine * ((tone - 0.5) * 0.24 - mortar * 0.24);
  albedo = mix(albedo, albedo * vec3(1.18, 0.92, 0.8), isBrick * fine * step(0.93, tone));
  float stone = (1.0 - isBrick) * (1.0 - isRender);
  vec2 block = p / vec2(1.1, 0.55);
  block.x += 0.5 * mod(floor(block.y), 2.0);
  vec2 ashlar = fract(block);
  float joint = max(step(ashlar.x, 0.03), step(ashlar.y, 0.06));
  albedo *= 1.0 + stone * fine * ((hash2(floor(block)) - 0.5) * 0.08 - joint * 0.14);
  float render = isRender * (1.0 - isBrick);
  albedo *= 1.0 + render * fine * (hash2(floor(p / 0.09)) - 0.5) * 0.06;
  albedo *= 0.95 + 0.1 * noise2(vec2(p.x / 3.1, p.y / 2.3));
}`;

/**
 * A wall with its windows. `vFacade` holds its top height plus a code (facade-codes.ts): each
 * building's own rhythm of bays and storeys seeded by that height, its style of window, trim and
 * door; a church's lancets, civic Gothic's niches and statues, a shop's glazed ground floor.
 */
export const WALL = `${WALL_SKIN}
void wallSurface(inout vec3 albedo, vec3 base, inout vec3 glowEmit) {
  // Walls carry their top height, plus LANCETS on churches, ORNATE on civic Gothic or
  // SHOP_FRONT + 100 · kind over a shop front (facade-codes.ts).
  float shop = step(${f(SHOP_FRONT - 0.5)}, vFacade);
  float ornate = step(${f(ORNATE - 0.5)}, vFacade) - shop;
  float church = step(${f(LANCETS - 0.5)}, vFacade) - ornate - shop;
  float kind = shop * floor((vFacade - ${f(SHOP_FRONT)}) / 100.0);
  float top = vFacade - church * ${f(LANCETS)} - ornate * ${f(ORNATE)} -
    shop * (${f(SHOP_FRONT)} + 100.0 * kind);
  // Each building's own rhythm, seeded by its wall height: bay width, window width,
  // and as many storeys as fit, so the top row always sits under the eaves.
  float seed = fract(sin(top * 91.345) * 43758.5453);
  float seed2 = fract(seed * 13.17 + 0.37);
  float storey = clamp(top / max(1.0, floor(top / 3.2 + 0.5)), 2.8, 4.0);
  // The width a bay is meant to be (facade-bays.ts): what doors and frames are sized by. The
  // bays actually drawn are a whole number fitted along the wall (vBay).
  float aim = mix(mix(${f(BAY_MIN)}, ${f(BAY_MAX)}, fract(top * ${f(BAY_SPREAD)})), ${f(LANCET_BAY)}, church);
  vec2 size = vec2(aim, storey);
  float halfWidth = mix(mix(0.17, 0.25, seed2), 0.75 / ${f(LANCET_BAY)}, church);
  // Storeys count from the foot of the house, wherever the ground lifted it.
  vec2 p = vec2(dot(vWorld.xz, vec2(-vWallNormal.y, vWallNormal.x)), vWorld.y - vLift);
  // Across a wall, its fitted bays; up it, the storeys.
  vec2 cell = vec2(floor(vBay), floor(p.y / storey));
  vec2 g = vec2(fract(vBay), fract(p.y / storey));
  float house = (1.0 - church) * (1.0 - ornate);
  // Each building's own style (DESIGN.md, "Facades"): arched windows on a quarter of
  // the houses, tall ones with a balcony rail on another quarter, the rest plain; and
  // whether it wears a cornice, a string course, a bluestone plinth or shutters.
  float sA = fract(seed * 17.13 + 0.29);
  float sB = fract(seed * 23.71 + 0.61);
  float sC = fract(seed * 29.37 + 0.83);
  float arched = house * step(0.74, sA);
  float tall = house * step(0.5, sA) * (1.0 - arched);
  float sillY = mix(0.32, 0.2, tall);
  float headY = mix(0.8, 0.84, tall);
  // A segmental arch takes 0.12 of the storey off the head towards the window's sides.
  float across = (g.x - 0.5) / max(halfWidth, 1e-3);
  float head = headY - arched * 0.12 * (1.0 - sqrt(max(0.0, 1.0 - across * across)));
  float window = step(0.5 - halfWidth, g.x) * step(g.x, 0.5 + halfWidth) * step(sillY, g.y) * step(g.y, head);
  // Only between the ground-floor sill and just under the eaves.
  window *= step(1.0, p.y) * step(p.y, top - 0.7);
  float average = 2.0 * halfWidth * 0.48 * step(1.0, p.y);
  // Lancets from 3 m to 2 m under the eaves, narrowing to a point over their last 1.6 m.
  float apex = top - 2.0;
  float lancet = step(3.0, p.y) * step(p.y, apex) *
    step(abs(g.x - 0.5) * size.x, 0.75 * sqrt(clamp((apex - p.y) / 1.6, 0.0, 1.0)));
  window = mix(window, lancet, church);
  average = mix(average, 2.0 * halfWidth * step(3.0, p.y) * step(p.y, apex), church);
  // A lancet's tracery: a stone mullion down its middle and a transom every 2.4 m.
  float fromMiddle = abs(g.x - 0.5) * size.x;
  window *= 1.0 - church * max(step(fromMiddle, 0.06), step(fract(p.y / 2.4), 0.05));
  // Civic Gothic draws niches of its own instead of windows (below).
  window *= 1.0 - ornate;
  average *= 1.0 - ornate;
  // A front door in one bay in four of a house's walls (never a shop's): 1.1 m wide and
  // 2.3 m tall in the frames' paint, under a pale fanlight. Its bay has no ground-floor
  // window.
  float bay4 = floor(cell.x / 4.0);
  float doorBay = house * (1.0 - shop) * step(hash2(vec2(bay4, seed * 100.0)), 0.7) *
    step(abs(mod(cell.x, 4.0) - floor(hash2(vec2(seed * 50.0, bay4)) * 4.0)), 0.5) *
    step(cell.y, 0.5) * step(4.0, top);
  float door = doorBay * step(abs(g.x - 0.5) * size.x, 0.55) * step(0.0, p.y) * step(p.y, 2.3);
  float fanlight = door * step(1.95, p.y);
  window *= 1.0 - doorBay;
  vec3 glass = uGlass;
  // A shop front: one wide pane per bay on the ground floor, under its kind's canvas,
  // with a door at one end of it, and a mullion down the middle of a wide one.
  float ground = shop * (1.0 - step(storey, p.y));
  float awning = ground * step(storey * 0.78, p.y) * step(p.y, storey * 0.92);
  float doorSide = step(0.5, fract(seed * 5.17)) * 2.0 - 1.0;
  float doorU = (g.x - 0.5) * size.x * doorSide;
  float doorAt = 0.5 * size.x - 0.6;
  // A wall's bay numbers run on from a page (facade-bays.ts), so count from its first bay: the
  // door goes in the first of every three, and even a one-bay shop gets one.
  float shopDoor = ground * step(mod(mod(cell.x, ${f(BAYS_PER_PAGE)}), 3.0), 0.5) * step(abs(doorU - doorAt), 0.5) *
    step(0.1, p.y) * step(p.y, storey * 0.72);
  float mullion = step(0.6, fract(seed * 9.1)) * step(abs(g.x - 0.5) * size.x, 0.05) * (1.0 - shopDoor);
  float pane = step(0.08, g.x) * step(g.x, 0.92) * step(0.1, p.y) * step(p.y, storey * 0.72) * (1.0 - mullion);
  window = mix(window, pane, ground);
  average = mix(average, 0.6, ground);
  // A window narrower than about two device pixels aliases into stripes, so the grid
  // fades to its average tint between three and two pixels per window.
  float pixel = max(fwidth(p.x), fwidth(p.y));
  vec4 front = uFront[int(kind) * 2];
  vec4 second = uFront[int(kind) * 2 + 1];
  // Stripes 45 cm wide, blended to their average once finer than a couple of pixels.
  float band = mix(0.5, step(0.5, fract(p.x / 0.9)), 1.0 - smoothstep(0.2, 0.35, pixel));
  vec3 canvas = mix(front.rgb, second.rgb, band);
  // Warm panes in a café, goods in a shop's window: blocks of its canvas and paper.
  glass = mix(glass, mix(glass, uLit, 0.55), ground * front.w);
  float item = hash2(floor(vec2(p.x / 0.32, p.y / 0.28)));
  float goods = ground * second.w * step(0.15, p.y) * step(p.y, storey * 0.3) * step(0.45, item);
  glass = mix(glass, mix(front.rgb, vec3(0.93, 0.89, 0.8), item), goods);
  // How much of a window a pixel spans, in the bays actually fitted to this wall (the width in
  // metres would miss how much narrower or wider a wall's fit makes them).
  float pixelBays = max(fwidth(vBay), fwidth(p.y) / size.y);
  float span = 2.0 * halfWidth;
  float detail = 1.0 - smoothstep(span / 3.0, span / 2.0, pixelBays);
  float coverage = mix(average, window, detail);
  float litHash = fract(sin(dot(cell + vec2(seed * 13.0, seed * 7.0), vec2(12.9898, 78.233))) * 43758.5453);
  float glow = step(0.93, litHash) * (1.0 - ground - church);
  // At night (uNight), a share of the windows light up, most of them warm, a few cool,
  // and three shop fronts in four, a café's warm: they glow whatever the light on them.
  float lit = uNight * house * (1.0 - ground) * step(1.0 - 0.45 * uNight, litHash);
  vec3 bulb = fract(litHash * 7.0) < 0.78 ? vec3(1.0, 0.76, 0.4) : vec3(0.72, 0.8, 1.0);
  // From afar one window's hash against the next is a checkerboard: their average instead.
  lit = mix(uNight * house * (1.0 - ground) * 0.45 * uNight, lit, detail);
  bulb = mix(vec3(1.0, 0.76, 0.4), bulb, detail);
  float shopLit = ground * uNight * step(0.25, fract(seed * 3.3));
  vec3 shopLight = mix(vec3(0.9, 0.9, 0.85), vec3(1.0, 0.72, 0.38), front.w);
  // Up close a window is more than a dark square: bars across it, a reveal shading its
  // top, a streak of sky on the glass by day; lit, a warm room, brighter at the ceiling,
  // between two curtains.
  float paneU = (g.x - 0.5 + halfWidth) / max(2.0 * halfWidth, 1e-3);
  float paneV = (g.y - sillY) / max(head - sillY, 1e-3);
  float plainPane = house * (1.0 - ground) * window * detail;
  float bars = max(step(abs(paneU - 0.5), 0.035), step(abs(paneV - 0.64), 0.03)) * plainPane;
  float reveal = smoothstep(0.8, 1.0, paneV) * plainPane;
  float sky = step(0.5, fract(litHash * 5.0)) * step(abs(paneU * 0.9 - paneV * 0.5 - 0.2 + 0.3 * fract(litHash * 9.0)), 0.09) * plainPane;
  float curtain = max(step(paneU, 0.16), step(0.84, paneU)) * plainPane;
  glass = mix(glass, mix(glass, vec3(0.5, 0.66, 0.82), 0.26), sky);
  glass *= 1.0 - 0.45 * reveal;
  vec3 room = bulb * mix(0.72, 1.12, paneV) * (1.0 - 0.45 * curtain);
  vec3 paneColour = mix(mix(glass, uLit, glow * detail), room, lit);
  paneColour = mix(paneColour, shopLight, shopLit);
  paneColour = mix(paneColour, vec3(0.05, 0.05, 0.06), bars * 0.85);
  albedo = mix(albedo, paneColour, coverage * 0.8);
  glowEmit = room * lit * mix(average * 0.6, window * (1.0 - bars), detail) * 0.9 +
    shopLight * shopLit * window * 0.8;
  albedo = mix(albedo, canvas, awning * (1.0 - smoothstep(0.3, 0.6, pixel)));
  // A lancet's stone surround, a little paler than the wall, once it spans a few pixels.
  float surround = church * (1.0 - lancet) * step(2.85, p.y) * step(p.y, apex + 0.15) *
    step(fromMiddle, 0.9 * sqrt(clamp((apex + 0.15 - p.y) / 1.75, 0.0, 1.0)));
  albedo *= 1.0 + 0.12 * surround * (1.0 - smoothstep(0.1, 0.2, pixel));
  // Civic Gothic, as on the Stadhuis: tiers 3.6 m tall of pointed niches 1.6 m apart, each
  // with a statue on its plinth, over a moulded band, from the first tier to the eaves.
  if (ornate > 0.5) {
    vec2 bay = vec2(${f(NICHE_BAY)}, 3.6);
    float nx = abs(g.x - 0.5) * bay.x;
    float ny = fract((p.y - 1.0) / bay.y) * bay.y;
    float arch = 2.6 + 0.45 * sqrt(clamp(1.0 - nx / 0.42, 0.0, 1.0));
    float niche = step(nx, 0.42) * step(0.5, ny) * step(ny, arch);
    float figure = step(nx, 0.15) * step(0.75, ny) * step(ny, 2.15) +
      step(length(vec2(nx, ny - 2.32)), 0.13) + step(nx, 0.24) * step(0.5, ny) * step(ny, 0.75);
    vec3 stone = albedo;
    vec3 carved = mix(stone, stone * 1.15, step(ny, 0.18));
    carved = mix(carved, stone * 0.45, niche);
    carved = mix(carved, min(stone * 1.25, vec3(1.0)), clamp(figure, 0.0, 1.0) * niche);
    float sharp = 1.0 - smoothstep(0.17, 0.28, pixel);
    albedo = mix(stone, mix(stone * 0.82, carved, sharp),
      step(1.0, p.y) * step(p.y, top - 1.2));
  }
  // Round an ordinary window, a frame and a bluestone sill, and under one in five a
  // box of flowers, red, pink, white or yellow: houses that look lived in, at no geometry.
  // A frame fades out before it's thinner than a pixel, a flower box a little later.
  float plain = house * (1.0 - ground) * (1.0 - doorBay) *
    step(1.0, (cell.y + sillY) * size.y) * step((cell.y + headY) * size.y, top - 0.7);
  vec2 rim = vec2(0.09) / size;
  float inX = step(0.5 - halfWidth - rim.x, g.x) * step(g.x, 0.5 + halfWidth + rim.x);
  float frame = inX * step(sillY - rim.y, g.y) * step(g.y, head + rim.y) * (1.0 - window);
  float sill = step(0.5 - halfWidth - 2.0 * rim.x, g.x) * step(g.x, 0.5 + halfWidth + 2.0 * rim.x) *
    step(sillY - 2.0 * rim.y, g.y) * step(g.y, sillY - rim.y);
  float bloom = step(0.8, hash2(cell + vec2(3.7 + seed * 31.0, 1.3))) * (1.0 - tall);
  float flowerBox = bloom * inX * step(sillY - 5.0 * rim.y, g.y) * step(g.y, sillY - 2.0 * rim.y);
  float fine = plain * (1.0 - smoothstep(0.05, 0.12, pixel));
  float luma = dot(base, vec3(0.2126, 0.7152, 0.0722));
  // White frames on brick; on a pale render, painted wood: bottle green, oxblood or charcoal.
  float paint = fract(seed * 7.31);
  vec3 wood = paint < 0.4 ? vec3(0.04, 0.12, 0.07) : paint < 0.7 ? vec3(0.22, 0.04, 0.03) : vec3(0.06, 0.06, 0.07);
  vec3 frameColour = luma > 0.4 ? wood : vec3(0.88, 0.85, 0.79);
  albedo = mix(albedo, frameColour, frame * fine);
  albedo = mix(albedo, vec3(0.42, 0.43, 0.44), sill * fine);
  // Tall windows on the upper floors stand behind a balcony rail of iron bars.
  float rail = tall * plain * step(0.5, cell.y) * inX * step(sillY, g.y) * step(g.y, sillY + 0.1) *
    max(step(0.6, fract(p.x / 0.14)), step(g.y, sillY + 0.025));
  albedo = mix(albedo, vec3(0.1, 0.1, 0.11), rail * (1.0 - smoothstep(0.04, 0.09, pixel)));
  // Shutters either side of the windows of one pale house in five.
  float side = abs(g.x - 0.5);
  float shutter = step(0.8, sC) * step(0.4, luma) * plain * step(halfWidth + rim.x, side) *
    step(side, halfWidth + rim.x + 0.6 * halfWidth) * step(sillY, g.y) * step(g.y, headY);
  albedo = mix(albedo, wood * 1.6, shutter * (1.0 - smoothstep(0.1, 0.2, pixel)));
  float hue = hash2(cell + vec2(9.1 + seed * 11.0, 4.2));
  vec3 petals = hue < 0.4 ? vec3(0.72, 0.07, 0.05) : hue < 0.65 ? vec3(0.86, 0.33, 0.45)
    : hue < 0.85 ? vec3(0.9, 0.87, 0.8) : vec3(0.9, 0.68, 0.1);
  float petal = step(0.5, hash2(floor(p / 0.1)));
  albedo = mix(albedo, mix(vec3(0.06, 0.18, 0.04), petals, petal),
    flowerBox * plain * (1.0 - smoothstep(0.1, 0.22, pixel)));
  // Trim: a cornice under the eaves of most houses and a string course over the ground
  // floor of some, pale stone on brick and a darker band on render; a bluestone plinth
  // on half of them. Brick shows its courses, faintly, once one spans a couple of pixels.
  vec3 trim = luma > 0.4 ? base * 0.8 : vec3(0.9, 0.87, 0.78);
  float cornice = house * step(0.4, sB) * step(top - 0.5, p.y) * step(p.y, top - 0.1);
  float course = house * (1.0 - shop) * step(0.72, sB) * step(storey - 0.14, p.y) * step(p.y, storey - 0.02);
  float plinth = house * (1.0 - shop) * step(0.5, sC) * step(0.0, p.y) * step(p.y, 0.5);
  float trimFine = 1.0 - smoothstep(0.12, 0.25, pixel);
  albedo = mix(albedo, trim, max(cornice, course) * trimFine);
  albedo = mix(albedo, vec3(0.3, 0.33, 0.36), plinth * trimFine);
  float isBrick = step(luma, 0.4) * house;
  float solid = (1.0 - coverage) * (1.0 - max(cornice, plinth));
  wallSkin(albedo, p, pixel, isBrick, house, seed, solid);
  // The eaves' shadow on the top of a wall with no cornice to carry it, and the streak of
  // weather under each sill.
  albedo *= 1.0 - 0.18 * smoothstep(top - 1.4, top - 0.1, p.y) * (1.0 - cornice);
  float stain = plain * inX * smoothstep(sillY - 0.2, sillY - 2.0 * rim.y, g.y) * step(g.y, sillY - 2.0 * rim.y);
  albedo *= 1.0 - 0.09 * stain * fine;
  // At night a church and a hall are floodlit from below, stronger at the foot.
  float flood = max(church, ornate) * step(0.0, p.y);
  glowEmit += albedo * vec3(0.95, 0.68, 0.38) * flood * uNight * mix(0.48, 0.14, smoothstep(0.0, top, p.y)) * (1.0 - coverage);
  // Grime along the foot of every wall, and the slow weathering of the rest.
  albedo *= 1.0 - 0.2 * (1.0 - smoothstep(0.0, 1.5, p.y));
  vec3 doorColour = mix(wood, vec3(0.9, 0.86, 0.72), fanlight);
  albedo = mix(albedo, doorColour, door * (1.0 - smoothstep(0.15, 0.3, pixel)));
  // The shop's door: its wooden frame, a bar at handle height and a kick plate.
  float doorFrame = shopDoor * clamp(step(0.42, abs(doorU - doorAt)) + step(abs(p.y - 1.0), 0.04) + step(p.y, 0.2), 0.0, 1.0);
  albedo = mix(albedo, wood, doorFrame * (1.0 - smoothstep(0.06, 0.12, pixel)));
}

// A wall with no windows: a gable end, a shed, a tower.
void plainWall(inout vec3 albedo, vec3 base) {
  vec2 p = vec2(dot(vWorld.xz, vec2(-vWallNormal.y, vWallNormal.x)), vWorld.y - vLift);
  float pixel = max(fwidth(p.x), fwidth(p.y));
  float luma = dot(base, vec3(0.2126, 0.7152, 0.0722));
  wallSkin(albedo, p, pixel, step(luma, 0.4), step(0.4, luma) * step(luma, 0.62), 0.5, 1.0);
}`;
