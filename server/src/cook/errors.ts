/** A command the user can't make right now (400 invalid, 404 nothing there, 409 wrong state). */
export class CommandError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
