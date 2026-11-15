import { StepUpController, type StepUpMethod, type StepUpPrompt } from '@keith/app-model'
import { getClient, session } from '../session/index.ts'

/**
 * Step-up for the page: the shared `StepUpController` (app-model) over the browser client, whose `stepUp`
 * runs in cookie mode (rotate and deliver the new cookie). After a success the whoami is read again so the
 * elevated pill counts down from the core's `elevatedUntil`.
 */
class StepUpState {
  prompt = $state<StepUpPrompt | undefined>(undefined)
  elevatedUntil = $state<number | undefined>(undefined)
  private controller: StepUpController | undefined

  private get c(): StepUpController {
    if (this.controller === undefined) {
      // a PIN session cannot step up with its PIN: open on the password for it
      const controller = new StepUpController(getClient(), {
        preferMethod: () => (session.me?.methods?.includes('pin') === true ? 'password' : 'pin'),
      })
      this.controller = controller
      controller.subscribe(() => this.sync(controller))
    }
    return this.controller
  }

  private sync(controller: StepUpController): void {
    const next = controller.getSnapshot()
    const stepped = next.elevatedUntil !== undefined && next.elevatedUntil !== this.elevatedUntil
    this.prompt = next.prompt
    this.elevatedUntil = next.elevatedUntil
    if (stepped) void session.load()
  }

  /** Run `act`; on `KEITH_STEP_UP_REQUIRED` ask for the PIN or password and run it once more. Cancel rejects. */
  guard = <T>(act: () => Promise<T>): Promise<T> => this.c.guard(act)
  /** Open the dialog with nothing to retry. */
  elevate = (): Promise<void> => this.c.elevate()
  submit = (secret: string): void => this.c.submit(secret)
  setMethod = (method: StepUpMethod): void => this.c.setMethod(method)
  cancel = (): void => this.c.cancel()
}

export const stepUp = new StepUpState()
