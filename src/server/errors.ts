/** An error whose message is safe to show to the workspace owner. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'UserError';
  }
}
