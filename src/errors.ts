/** An error meant for the person at the terminal: printed as-is, no stack. */
export class CliError extends Error {
  constructor(
    message: string,
    /** 1 for a failure, 2 for a usage mistake, 130 for Ctrl-C. */
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** A wrong flag or argument. Exits 2 and prints the command's usage. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}
