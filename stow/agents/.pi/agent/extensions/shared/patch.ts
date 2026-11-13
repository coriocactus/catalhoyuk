// How an adapter replaces methods of Pi's classes while Pi runs, where Pi offers no extension
// point. Every adapter follows the same rules:
//
// - The first owner installs the replacements. Later owners (another session of the same
//   extension, or its reloaded copy) share them.
// - The last owner to let go puts Pi's methods back, but only those that are still the adapter's:
//   a replacement someone else made since is never overwritten.
// - If someone else replaced a method while the patch was installed, a new owner is refused.
//
// Each extension loads its own copy of this module, so the module keeps no state. A patch's
// record lives on the first patched object, under a global symbol, where every copy finds it.

// biome-ignore lint/suspicious/noExplicitAny: the methods of Pi's classes have every signature.
export type Method = (this: any, ...args: any[]) => any;

/** One method to replace: `target[name]`. */
export interface Site {
  target: object;
  name: string;
}

export interface PatchRecord<Owner, State> {
  /** The owners sharing the patch, oldest first. */
  owners: Set<Owner>;
  /** What the replacements keep between calls. */
  state: State;
  methods: { target: object; name: string; original: Method; installed: Method }[];
}

export interface Patch<Owner, State> {
  record: PatchRecord<Owner, State>;
  /** Whether this owner installed the replacements, rather than joined them. */
  first: boolean;
  /** Lets go. A second call does nothing. */
  release(): void;
}

export interface PatchSpec<Owner, State> {
  /** Names the patch for every copy of the adapter. Bump its version when the record changes. */
  key: string;
  /** How a refusal names the adapter: `rearview's adapter`. */
  name: string;
  /** The methods to replace. The record is kept on the first one's target. */
  sites: readonly Site[];
  /**
   * Builds the replacements for the first owner, one per site and in their order, from the
   * methods they replace. `owners` is the live set, for a replacement to read when it runs.
   * Throws to refuse the patch, which then changes nothing.
   */
  build(originals: Method[], owners: ReadonlySet<Owner>): { methods: Method[]; state: State };
  owner: Owner;
}

/**
 * Whether a patch is installed on `home`, the first of its sites' targets. A first owner asks
 * before it probes Pi's own methods, which a later owner would find already replaced.
 */
export function isPatched(key: string, home: object): boolean {
  return (home as { [key: symbol]: unknown })[Symbol.for(key)] !== undefined;
}

/** Installs a patch, or joins it. Throws when Pi lacks a method, or another extension holds one. */
export function installPatch<Owner, State>(spec: PatchSpec<Owner, State>): Patch<Owner, State> {
  const symbol = Symbol.for(spec.key);
  // Pi's classes are indexed by method name here and nowhere else: each site names a method
  // that its adapter's own types declare.
  const method = (site: Site) => (site.target as Record<string, Method | undefined>)[site.name];
  const assign = (site: Site, value: Method) => {
    (site.target as Record<string, Method>)[site.name] = value;
  };
  const home = spec.sites[0].target as { [symbol]?: PatchRecord<Owner, State> };
  let record = home[symbol];
  const first = !record;
  if (record) {
    if (record.methods.some((site) => method(site) !== site.installed))
      throw new Error(`Another extension replaced ${spec.name}.`);
  } else {
    const originals = spec.sites.map(method);
    const missing = spec.sites.find((_, index) => typeof originals[index] !== "function");
    if (missing) throw new Error(`Pi's ${missing.name} is unavailable to ${spec.name}.`);
    const owners = new Set<Owner>();
    const built = spec.build(originals as Method[], owners);
    record = {
      owners,
      state: built.state,
      methods: spec.sites.map((site, index) => ({
        ...site,
        original: originals[index] as Method,
        installed: built.methods[index],
      })),
    };
    for (const site of record.methods) assign(site, site.installed);
    home[symbol] = record;
  }
  const current = record;
  current.owners.add(spec.owner);
  let released = false;
  return {
    record: current,
    first,
    release() {
      if (released) return;
      released = true;
      current.owners.delete(spec.owner);
      if (current.owners.size) return;
      // A method someone else replaced since stays theirs, and so does the record: it refuses
      // new owners until Pi restarts, rather than patch over a stranger's patch.
      if (current.methods.some((site) => method(site) !== site.installed)) return;
      for (const site of current.methods) assign(site, site.original);
      delete home[symbol];
    },
  };
}
