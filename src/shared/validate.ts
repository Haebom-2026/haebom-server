import type { z } from "zod";
import { ApiError } from "./errors.js";
import type { HttpEvent } from "./http.js";

const MAX_BODY_BYTES = 256 * 1024;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** JSON 본문을 읽어 스키마로 검증한다. 실패하면 400 invalid-argument. */
export function parseJsonBody<S extends z.ZodType>(event: HttpEvent, schema: S): z.output<S> {
  const raw =
    event.body === undefined
      ? ""
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    throw new ApiError("invalid-argument", "Request body too large");
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ApiError("invalid-argument", "Request body must be JSON");
  }

  const result = schema.safeParse(data);
  if (!result.success) throw new ApiError("invalid-argument", formatIssues(result.error));
  return result.data;
}

/** 쿼리 문자열을 스키마로 검증한다. */
export function parseQuery<S extends z.ZodType>(event: HttpEvent, schema: S): z.output<S> {
  const result = schema.safeParse(event.queryStringParameters ?? {});
  if (!result.success) throw new ApiError("invalid-argument", formatIssues(result.error));
  return result.data;
}
