import { MinHeap } from './heap.ts';

/**
 * A* over any directed graph of numbered nodes and edges: the road graph the traffic drives
 * (src/data/traffic.ts), or whatever else is a graph. The graph is given as a few functions,
 * so nothing here knows what an edge is; the router keeps its arrays between searches and
 * allocates nothing per search but the route it returns.
 */
export interface Graph {
  /** How many nodes there are: they are numbered from 0. */
  nodes: number;
  /** The edges leaving a node. */
  out(node: number): ArrayLike<number>;
  /** Where an edge leads. */
  to(edge: number): number;
  /** What an edge costs to take (its length, say). */
  cost(edge: number): number;
  /** A lower bound on the cost from a node to the goal; 0 makes it Dijkstra. */
  estimate(node: number, goal: number): number;
}

export class GraphRouter {
  readonly #graph: Graph;
  readonly #cost: Float32Array;
  /** The edge each node was best reached by, and the node that edge was taken from. */
  readonly #via: Int32Array;
  readonly #tail: Int32Array;
  /** Which search last touched each node: clearing the arrays is bumping the search number. */
  readonly #seen: Uint32Array;
  readonly #closed: Uint32Array;
  #search = 0;
  readonly #heap = new MinHeap();

  constructor(graph: Graph) {
    this.#graph = graph;
    this.#cost = new Float32Array(graph.nodes);
    this.#via = new Int32Array(graph.nodes);
    this.#tail = new Int32Array(graph.nodes);
    this.#seen = new Uint32Array(graph.nodes);
    this.#closed = new Uint32Array(graph.nodes);
  }

  /**
   * The cheapest route from one node to another as the edges to take, in order, or null when
   * there is none within `most` cost (or none at all). `allowed` leaves edges out, so one graph
   * serves cars, bikes and people. From a node to itself the route is empty.
   */
  route(
    from: number,
    to: number,
    allowed: (edge: number) => boolean,
    most = Infinity,
  ): number[] | null {
    const g = this.#graph;
    const search = ++this.#search;
    const heap = this.#heap;
    heap.clear();
    this.#cost[from] = 0;
    this.#via[from] = -1;
    this.#seen[from] = search;
    heap.push(from, g.estimate(from, to));
    for (let node = heap.pop(); node !== -1; node = heap.pop()) {
      if (this.#closed[node] === search) continue;
      this.#closed[node] = search;
      if (node === to) break;
      const here = this.#cost[node]!;
      const out = g.out(node);
      for (let i = 0; i < out.length; i++) {
        const edge = out[i]!;
        if (!allowed(edge)) continue;
        const next = g.to(edge);
        const cost = here + g.cost(edge);
        if (cost > most) continue;
        if (this.#seen[next] === search && this.#cost[next]! <= cost) continue;
        this.#seen[next] = search;
        this.#cost[next] = cost;
        this.#via[next] = edge;
        this.#tail[next] = node;
        heap.push(next, cost + g.estimate(next, to));
      }
    }
    if (this.#closed[to] !== search) return null;
    const edges: number[] = [];
    for (let node = to; node !== from; node = this.#tail[node]!) edges.push(this.#via[node]!);
    return edges.toReversed();
  }
}
