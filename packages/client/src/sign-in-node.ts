// The Node/Bun entry's `createSignIn`: the browser-safe controller (sign-in.ts) plus the default store, which writes the
// credential to `~/.keith/client.json` (mode 0600). The browser entry uses the controller directly.
import { writeClientConfig } from './config.ts'
import { createSignIn as createBareSignIn } from './sign-in.ts'
import type { SignIn, SignInOptions } from './sign-in-types.ts'

export function createSignIn(options: SignInOptions = {}): SignIn {
  return createBareSignIn({
    store: {
      write: (config) => {
        writeClientConfig(config)
      },
    },
    ...options,
  })
}
