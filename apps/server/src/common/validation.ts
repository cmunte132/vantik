import type { ArgumentMetadata } from '@nestjs/common';

import { ValidationPipe } from '@nestjs/common';

/**
 * The pipe every request body, query and route-param DTO goes through.
 *
 * `whitelist` drops any property a DTO does not declare with a class-validator
 * decorator, so a handler that spreads its body into Prisma writes only the
 * columns the DTO names. A property with no decorator is dropped too, however
 * it is typed: give it one (`@Allow()` if nothing narrower fits), or the
 * handler receives it as undefined. The same goes for a nested class under
 * `@ValidateNested`, which is why a map keyed by field name must not be one.
 *
 * With any option set, the pipe also hands the handler the transformed DTO
 * rather than the raw input, so `@Type` and `@Transform` now apply: a
 * `@Type(() => Number)` query parameter arrives as a number.
 *
 * A transformed DTO is an instance of its class, and the DTOs compile to
 * ES2022 class fields, so an instance carries every field the class declares,
 * as undefined when the client did not send it. The server reads "the client
 * sent this key" as `'key' in dto` (an issue update connects its parent,
 * project, cycle and capability that way, and hands an assignee change to
 * agent delegation), and a JSON column is updated by spreading the DTO over
 * what is stored. With every key present, every issue update tried to connect
 * a parent of `undefined` and failed, and a spread erased what it did not
 * mention. So the keys the client did not send are taken off again: a key is
 * on the DTO exactly when it was in the request.
 *
 * Only a value the pipe turned into a DTO is touched. What a custom parameter
 * decorator hands over (the session, the request) passes through as it came:
 * it is no DTO, and walking it never ends.
 */
class SentFieldsValidationPipe extends ValidationPipe {
  async transform(value: unknown, metadata: ArgumentMetadata) {
    const transformed = await super.transform(value, metadata);

    return this.toValidate(metadata)
      ? withoutUnsentFields(transformed)
      : transformed;
  }
}

/**
 * This function removes, in place and all the way down, every property whose
 * value is undefined. JSON has no undefined, so such a property was never sent.
 */
export function withoutUnsentFields<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(withoutUnsentFields);
    return value;
  }

  if (
    value === null ||
    typeof value !== 'object' ||
    value instanceof Date ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }

  for (const key of Object.keys(value)) {
    const field = (value as Record<string, unknown>)[key];

    if (field === undefined) {
      delete (value as Record<string, unknown>)[key];
    } else {
      withoutUnsentFields(field);
    }
  }

  return value;
}

export function validationPipe(): ValidationPipe {
  return new SentFieldsValidationPipe({ whitelist: true });
}
