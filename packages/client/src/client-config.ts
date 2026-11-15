// The stored login and the default core address. Pure: no file access (the file lives in config.ts, Node only).

export interface ClientConfig {
  /** Core URL. */
  core: string
  /** The credential: a device login's `keith_s_…`, a `token create` one, or a legacy token. */
  token: string
  /**
   * Set only by the sign-in the person made with "remember this device" ticked (a 30 days idle credential). A file
   * without it (`keith login`, a token, an earlier version) is not remembered: the interactive app never signs in
   * with it silently (docs/specs/client.md, "Remembered and saved logins"); commands and scripts still use it.
   */
  remember?: true
}

export const DEFAULT_CORE = 'http://localhost:7420'
