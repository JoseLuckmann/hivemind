/**
 * resolve-project — the PURE precedence rule for turning a picked directory into
 * a { root, repoPath } pair, given the two things the filesystem walk found:
 *   - foundRoot: the nearest ancestor `.hivemind/` dir (from findRoot), or null
 *   - gitRoot:   the git repo root that CONTAINS the picked dir (findGitRoot), or null
 *
 * Extracted from the `resolveProject` IPC handler so the precedence — which is
 * subtle and was silently wrong — is unit-testable without Electron.
 *
 * The bug this encodes the fix for: binding a CHILD repo that lives inside a
 * folder which itself ran `hive init` (e.g. `~/Workspace` has `.hivemind/` and
 * you bind `~/Workspace/some-repo`). findRoot climbs UP and returns the PARENT's
 * `.hivemind`, so the old code set repoPath = dirname(parentRoot) = the parent
 * folder — silently collapsing every child repo back onto the parent, so the
 * child never bound. The picked dir's own git repo must win.
 */
import path from "node:path";

export interface ResolvedProject {
  /** The `.hivemind/` dir to scope issues to, or null if none belongs to the
   *  picked repo. */
  root: string | null;
  /** The git repo (or workspace folder) every tile's cwd/diff/tree targets. */
  repoPath: string | null;
}

/**
 * @param foundRoot nearest ancestor `.hivemind/` dir, or null
 * @param gitRoot   git repo root containing the picked dir, or null
 */
export function resolveProjectPaths(
  foundRoot: string | null,
  gitRoot: string | null,
): ResolvedProject {
  const rootRepo = foundRoot ? path.dirname(foundRoot) : null;

  // Accept the ancestor `.hivemind` root ONLY when it belongs to the picked
  // repo (its parent === the picked git root), or when the pick isn't a git
  // repo at all (nothing more specific to prefer). Otherwise the found root is
  // an unrelated ANCESTOR's — discard it so the child repo binds to itself.
  const root =
    foundRoot && (!gitRoot || rootRepo === gitRoot) ? foundRoot : null;

  // The picked dir's own git repo is authoritative; fall back to the found
  // root's repo only when there's no git repo (e.g. a bare `.hivemind` folder
  // that isn't under git).
  const repoPath = gitRoot ?? rootRepo;

  return { root, repoPath };
}
