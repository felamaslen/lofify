declare module 'fake-tag' {
  const gql: (strings: TemplateStringsArray, ...values: unknown[]) => string;
  export default gql;
}
