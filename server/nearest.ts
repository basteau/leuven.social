/**
 * Moves the `k` of the first `count` entries with the smallest `distances` to the front of both
 * arrays, in no particular order: quickselect, linear on average, as it runs for every client on
 * every few ticks.
 */
export function nearestFirst(
  ids: Int32Array,
  distances: Float64Array,
  count: number,
  k: number,
): void {
  if (k <= 0 || k >= count) return;
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
        const id = ids[i]!;
        ids[i] = ids[j]!;
        ids[j] = id;
        i++;
        j--;
      }
    }
    if (k - 1 <= j) right = j;
    else if (k - 1 >= i) left = i;
    else return;
  }
}
