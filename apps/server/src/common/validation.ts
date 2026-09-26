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
 */
export function validationPipe(): ValidationPipe {
  return new ValidationPipe({ whitelist: true });
}
