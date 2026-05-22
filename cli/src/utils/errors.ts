// Exit codes for CLI
export const ExitCodes = {
  SUCCESS: 0,
  ERROR: 1,
  GENERAL_ERROR: 1,
  INVALID_ARGS: 2,
  SERVER_UNREACHABLE: 3,
  NOT_FOUND: 4,
  VALIDATION_ERROR: 5,
  NETWORK_ERROR: 6,
  // Precondition for the requested operation isn't met (e.g. developer
  // mode required but not enabled). Referenced from cli/src/commands/dev.ts.
  INVALID_STATE: 7,
  // The operation reached the server but the server reported failure
  // (e.g. restart attempted but build/migrate step failed).
  OPERATION_FAILED: 8,
} as const

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes]

export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode: ExitCode = ExitCodes.ERROR
  ) {
    super(message)
    this.name = 'CliError'
  }
}

export class ApiError extends CliError {
  constructor(
    public statusCode: number,
    message: string
  ) {
    const exitCode =
      statusCode === 0
        ? ExitCodes.SERVER_UNREACHABLE
        : statusCode === 404
          ? ExitCodes.NOT_FOUND
          : statusCode === 400
            ? ExitCodes.VALIDATION_ERROR
            : ExitCodes.ERROR

    const code =
      statusCode === 0
        ? 'SERVER_UNREACHABLE'
        : statusCode === 404
          ? 'NOT_FOUND'
          : statusCode === 400
            ? 'VALIDATION_ERROR'
            : 'API_ERROR'

    super(code, message, exitCode)
    this.name = 'ApiError'
  }
}
