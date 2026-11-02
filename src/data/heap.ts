/**
 * A binary min-heap of integer items keyed by a float: the open set of an A* search. Its
 * arrays grow as needed and are kept between searches, so a search allocates nothing. Stale
 * entries (an item pushed again with a better key) are the caller's to skip on pop.
 */
export class MinHeap {
  #items = new Int32Array(1024);
  #keys = new Float32Array(1024);
  #size = 0;

  get size(): number {
    return this.#size;
  }

  clear(): void {
    this.#size = 0;
  }

  push(item: number, key: number): void {
    if (this.#size === this.#items.length) {
      const [items, keys] = [new Int32Array(this.#size * 2), new Float32Array(this.#size * 2)];
      items.set(this.#items);
      keys.set(this.#keys);
      [this.#items, this.#keys] = [items, keys];
    }
    let i = this.#size++;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (this.#keys[up]! <= key) break;
      this.#items[i] = this.#items[up]!;
      this.#keys[i] = this.#keys[up]!;
      i = up;
    }
    this.#items[i] = item;
    this.#keys[i] = key;
  }

  /** The item with the smallest key, or -1 when empty. */
  pop(): number {
    if (this.#size === 0) return -1;
    const top = this.#items[0]!;
    const item = this.#items[--this.#size]!;
    const key = this.#keys[this.#size]!;
    let i = 0;
    for (;;) {
      let child = i * 2 + 1;
      if (child >= this.#size) break;
      if (child + 1 < this.#size && this.#keys[child + 1]! < this.#keys[child]!) child++;
      if (this.#keys[child]! >= key) break;
      this.#items[i] = this.#items[child]!;
      this.#keys[i] = this.#keys[child]!;
      i = child;
    }
    this.#items[i] = item;
    this.#keys[i] = key;
    return top;
  }
}
