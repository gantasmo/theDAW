/**
 * vstLive/projectSessions — a hosted plugin lives as long as its entry is in the project.
 *
 * A session used to be claimed only by audio nodes, and the engine builds its graph on Play.
 * Two things followed from that, both audible or visible to the user:
 *
 *  - A plugin was SPAWNED BY THE FIRST PLAY. A project that was just loaded or restored opened
 *    dry: the host process had to start and the plugin had to load (seconds, for a mastering
 *    suite) while the song was already running, and then the processing cut in.
 *  - A plugin removed with the transport stopped stayed claimed by the node of the last graph,
 *    so its host process kept running until the next Play.
 *
 * So the project itself holds its plugins. `reconcile()` compares the racks with what is held:
 * a new entry is held at once (the host starts while the user is still looking at the plugin
 * browser, and is ready long before Play), and an entry that left the project is forgotten —
 * every claim dropped, grace period started — whatever removed it: its row's remove button, its
 * track being deleted, an undo of the add, a project load. An undo inside the grace period holds
 * it again and gets the very same running plugin back.
 *
 * Pure apart from its three injected dependencies; the engine (`state/liveMixer.ts`) owns the
 * instance, feeds it the Edit project's racks and resets it when the editor goes away.
 */
import type { ChainEntry } from '../../state/effectChainStore';
import type { VstSessionRegistry } from './sessionRegistry';

/** The holder name the project claims its sessions under. */
export const PROJECT_HOLDER = 'project';
/** The holder name the piano roll claims its parts' instruments under (state/rollInstruments). */
export const ROLL_HOLDER = 'roll';
/** The holder name the SWAY cockpit claims the plugins on its tracks under (lib/swayHostVst). */
export const SWAY_HOLDER = 'sway';

export interface ProjectSessionsDeps {
  registry: Pick<VstSessionRegistry, 'hold' | 'forget' | 'hostAvailable'>;
  /** Every chain entry currently in the project, from every rack. Non-plugin entries are skipped here. */
  entries: () => readonly ChainEntry[];
  /** The engine context's sample rate. Only read when there is a plugin to host, so a project
   *  without plugins never touches the AudioContext. */
  sampleRate: () => number;
}

export interface ProjectSessions {
  /** Bring what is held in line with the project. Call after every change to a rack. */
  reconcile(): void;
  /** Drop the bookkeeping WITHOUT releasing anything: the registry was closed wholesale
   *  (`closeAll`), so there is nothing left to give back. The next `reconcile()` holds afresh. */
  reset(): void;
  /** Entry ids currently held, for tests and diagnostics. */
  heldIds(): string[];
}

const isHostedPlugin = (e: ChainEntry): boolean => e.effect === 'vst3' && !!e.vst?.plugin_path;

export function createProjectSessions(deps: ProjectSessionsDeps): ProjectSessions {
  const held = new Set<string>();
  return {
    reconcile() {
      const wanted = new Map<string, ChainEntry>();
      for (const e of deps.entries()) if (isHostedPlugin(e)) wanted.set(e.id, e);

      for (const id of [...held]) {
        if (wanted.has(id)) continue;
        held.delete(id);
        deps.registry.forget(id);
      }
      // Known to have no host binary: nothing to start. Not remembered as held, so a machine that
      // gains the host later (a build, a retry that re-probes) picks its plugins up on the next pass.
      if (deps.registry.hostAvailable() === false) return;
      for (const [id, entry] of wanted) {
        if (held.has(id)) continue;
        held.add(id);
        // Never rejects by contract; the catch keeps a broken fake or a future change from
        // becoming an unhandled rejection in the engine's store subscription.
        void deps.registry.hold(entry, deps.sampleRate(), PROJECT_HOLDER).catch(() => {});
      }
    },
    reset() {
      held.clear();
    },
    heldIds() {
      return [...held];
    },
  };
}
