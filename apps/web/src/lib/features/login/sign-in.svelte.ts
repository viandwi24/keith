import {
  createCookieSignIn,
  localStorageIdentifierMemory,
  type SignIn,
  type SignInState,
} from '@keith/client/browser'

/** The sign-in controller of the page as reactive state. The address is the page origin; the controller is created once per visit. */
export class LoginModel {
  state = $state<SignInState>({ step: 'address', address: '' })
  readonly signIn: SignIn
  private off: () => void

  constructor() {
    this.signIn = createCookieSignIn({ remember: localStorageIdentifierMemory() })
    this.state = this.signIn.get()
    this.off = this.signIn.subscribe((next) => {
      this.state = next
    })
  }

  /** Ask the core `/health` at the page origin; it moves on to `identify`. */
  start(): void {
    void this.signIn.submitAddress(globalThis.location.origin)
  }

  dispose(): void {
    this.off()
    this.signIn.dispose()
  }
}
