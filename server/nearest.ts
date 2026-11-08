/** Reused from call to call: this runs for every client on every tick. */
let scratch = new Float64Array(256);

/**
 * Moves the `k` of the first `count` items with the smallest `distance` to the front of `items`, in
 * no particular order: quickselect, linear on average, as it runs for every client on every tick.
 */
export function nearestFirst<T>(
  items: T[],
  count: number,
  k: number,
  distance: (item: T) => number,
): void {
  if (k <= 0 || k >= count) return;
  if (scratch.length < count) scratch = new Float64Array(count * 2);
  const distances = scratch;
  for (let i = 0; i < count; i++) distances[i] = distance(items[i]!);
  let [left, right] = [0, count - 1];
  while (left < right) {
    // The middle of the range as the pivot: a crowd's order is random enough.
    const pivot = distances[(left + right) >> 1]!;
    let i = left;
    let j = right;
    while (i <= j) {
      while (distances[i]! < pivot) i++;
      while (distances[j]! > pivot) j--;
      if (i <= j) {
        const d = distances[i]!;
        distances[i] = distances[j]!;
        distances[j] = d;
        const item = items[i]!;
        items[i] = items[j]!;
        items[j] = item;
        i++;
        j--;
      }
    }
    if (k - 1 <= j) right = j;
    else if (k - 1 >= i) left = i;
    else return;
  }
}
