import type { Int } from 'grats';

/**
 * Marks a field that is null only when an error has been propagated into it — never as a meaningful value. Clients with error-aware response handling may treat it as non-nullable. `levels` names the list depths the guarantee applies to (`0` is the field itself), matching the semantic-nullability draft spec.
 *
 * @gqlDirective on FIELD_DEFINITION
 */
export function semanticNonNull(_args?: { levels?: Int[] | null }): void {}
