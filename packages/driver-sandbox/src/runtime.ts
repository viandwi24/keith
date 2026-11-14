// Container runtime detection: Docker first, Podman second (docs/specs/node-drivers.md, "Driver sandbox").
// The lookup is injected (`WhichFn`), so tests never touch PATH or a real runtime.
export const RUNTIMES = ['docker', 'podman'] as const
export type RuntimeName = (typeof RUNTIMES)[number]

export type WhichFn = (name: string) => string | undefined

export const INSTALL_HINT =
  'install Docker (https://docs.docker.com/get-docker/) or Podman (https://podman.io/docs/installation)'

export type Choice<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

/**
 * The runtime a node uses: the requested one when it is on PATH, else the first of Docker or Podman that is.
 * Refuses (no runtime at all, or the requested one missing) with the message the owner needs.
 */
export function chooseRuntime(
  requested: RuntimeName | undefined,
  which: WhichFn,
): Choice<RuntimeName> {
  if (requested !== undefined) {
    return which(requested) !== undefined
      ? { ok: true, value: requested }
      : {
          ok: false,
          message: `${requested} is not installed: ${INSTALL_HINT}, or pick the other runtime with --runtime`,
        }
  }
  const found = RUNTIMES.find((name) => which(name) !== undefined)
  return found !== undefined
    ? { ok: true, value: found }
    : {
        ok: false,
        message: `no container runtime found: ${INSTALL_HINT}, then run keith-node driver add sandbox again`,
      }
}

/** The runtime command that fetches one image (`driver add` pulls the allowlist; a call never pulls). */
export function pullArgv(runtime: RuntimeName, image: string): string[] {
  return [runtime, 'pull', image]
}
