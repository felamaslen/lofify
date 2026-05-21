import {
  GraphQLError,
  GraphQLSchema,
  defaultFieldResolver,
  isObjectType,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLFieldResolver,
} from 'graphql';
import { Int } from 'grats';

/**
 * Restricts a numeric argument to the inclusive range [min, max].
 *
 * @gqlDirective on ARGUMENT_DEFINITION
 */
export function constraint(_args: { min: Int; max: Int }) {}

type ConstraintArgs = { min: number; max: number };

function readConstraint(arg: GraphQLArgument): ConstraintArgs | null {
  const directives = (
    arg.extensions as
      | { grats?: { directives?: Array<{ name: string; args?: Record<string, unknown> }> } }
      | undefined
  )?.grats?.directives;
  if (!directives) return null;
  const found = directives.find((d) => d.name === 'constraint');
  if (!found) return null;
  const min = Number(found.args?.min);
  const max = Number(found.args?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

function wrapResolver(
  field: GraphQLField<unknown, unknown>,
  constraints: ReadonlyArray<{ name: string; min: number; max: number }>,
): GraphQLFieldResolver<unknown, unknown> {
  const inner = field.resolve ?? defaultFieldResolver;
  return (source, args, ctx, info) => {
    for (const c of constraints) {
      const value = (args as Record<string, unknown>)[c.name];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || value < c.min || value > c.max) {
        throw new GraphQLError(
          `Argument "${c.name}" on field "${info.parentType.name}.${field.name}" must be between ${c.min} and ${c.max}.`,
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
    }
    return inner(source, args, ctx, info);
  };
}

/** Applies runtime enforcement for the `@constraint(min, max)` directive. */
export function applyConstraintDirective(schema: GraphQLSchema): GraphQLSchema {
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type)) continue;
    for (const field of Object.values(type.getFields())) {
      const constraints: Array<{ name: string; min: number; max: number }> = [];
      for (const arg of field.args) {
        const c = readConstraint(arg);
        if (c) constraints.push({ name: arg.name, ...c });
      }
      if (constraints.length > 0) {
        field.resolve = wrapResolver(field, constraints);
      }
    }
  }
  return schema;
}
