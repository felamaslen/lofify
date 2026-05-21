import { getSchema } from './__generated__/schema.js';
import { applyConstraintDirective } from './directives/constraint.js';

/** Returns the executable GraphQL schema with directive enforcement applied. */
export function buildSchema() {
  return applyConstraintDirective(getSchema());
}
