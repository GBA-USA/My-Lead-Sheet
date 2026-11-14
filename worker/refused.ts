/** A request the API turns down. `reason` is the machine word the phone branches on. */
export class Refused extends Error {
  constructor(
    readonly reason: string,
    readonly status = 400,
  ) {
    super(reason);
  }
}
