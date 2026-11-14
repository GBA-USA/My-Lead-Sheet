/** A request the API turns down. `reason` is the machine word the phone branches on, and `detail` joins it in the reply. */
export class Refused extends Error {
  constructor(
    readonly reason: string,
    readonly status = 400,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(reason);
  }
}
