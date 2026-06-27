/**
 * Per-request GraphQL context. A resolver receives it by declaring a parameter of this type.
 *
 * @gqlContext
 */
export interface GraphQLContext {
  /** IP of the requesting client, resolved through `X-Forwarded-For`. */
  clientIp: string;
}
