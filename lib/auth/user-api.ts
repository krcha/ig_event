export type RequireUserApiAccess = () => Promise<string>;

type UserApiAuthPreflightOptions = {
  authConfigured: boolean;
  getUserId: () => Promise<string | null>;
};

type UserApiDependencyOptions = {
  notFoundErrorIncludes?: string;
  notFoundMessage?: string;
};

class UserApiHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UserApiHttpError";
    this.status = status;
  }
}

export async function preflightUserApiAccess({
  authConfigured,
  getUserId,
}: UserApiAuthPreflightOptions): Promise<string> {
  if (!authConfigured) {
    throw new UserApiHttpError(503, "Authentication is not configured.");
  }

  const userId = await getUserId();
  if (!userId) {
    throw new UserApiHttpError(401, "Unauthorized");
  }

  return userId;
}

export function badUserApiRequest(message: string): never {
  throw new UserApiHttpError(400, message);
}

function getErrorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

export async function callUserApiDependency<T>(
  operation: () => Promise<T>,
  options: UserApiDependencyOptions = {},
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof UserApiHttpError) {
      throw error;
    }

    const errorMessage = getErrorMessage(error);
    if (
      options.notFoundErrorIncludes &&
      errorMessage?.includes(options.notFoundErrorIncludes)
    ) {
      throw new UserApiHttpError(
        404,
        options.notFoundMessage ?? "Requested resource not found.",
      );
    }

    throw new UserApiHttpError(502, "User data service is unavailable.");
  }
}

function userApiErrorResponse(error: unknown): Response {
  if (error instanceof UserApiHttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  return Response.json(
    { error: "Unexpected user API failure." },
    { status: 500 },
  );
}

export async function runUserApiHandler<T>(
  requireAccess: RequireUserApiAccess,
  operation: (userId: string) => Promise<T>,
): Promise<Response> {
  try {
    const userId = await requireAccess();
    const result = await operation(userId);
    return Response.json(result);
  } catch (error) {
    return userApiErrorResponse(error);
  }
}
